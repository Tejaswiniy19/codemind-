"""Privileged host daemon that alone controls Docker's preconfigured runsc runtime.

The daemon accepts archives, not commands. Project build commands are selected
from a small fixed recipe set and only execute in disposable runsc containers.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import io
import json
import logging
import os
import re
import socket
import sqlite3
import tarfile
import threading
import time
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

import docker
from docker.errors import DockerException, NotFound
from fastapi import FastAPI, Header, HTTPException, Request as ApiRequest
from fastapi.responses import JSONResponse


DATA = Path(os.environ.get("CODEMIND_SANDBOXD_DATA_DIR", "/var/lib/codemind-sandboxd"))
DB = DATA / "jobs.sqlite3"
ARCHIVES = DATA / "archives"
TOKEN = os.environ.get("CODEMIND_SANDBOXD_TOKEN", "")
MAX_ARCHIVE = 100 * 1024 * 1024
MAX_FILES = 20_000
MAX_UNPACKED = 512 * 1024 * 1024
LOG_LIMIT = 24_000
def _configured_limit(name: str, default: int, maximum: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer.") from exc
    if not 1 <= value <= maximum:
        raise RuntimeError(f"{name} must be between 1 and {maximum}.")
    return value


MAX_CONCURRENT = _configured_limit("CODEMIND_MAX_CONCURRENT_JOBS", 4, 32)
MAX_ACTIVE_DEPLOYMENTS = _configured_limit("CODEMIND_MAX_ACTIVE_DEPLOYMENTS", 32, 256)
if MAX_CONCURRENT > MAX_ACTIVE_DEPLOYMENTS:
    raise RuntimeError("CODEMIND_MAX_CONCURRENT_JOBS cannot exceed CODEMIND_MAX_ACTIVE_DEPLOYMENTS.")
ARCHIVE_QUOTA = max(MAX_ARCHIVE, int(os.environ.get("CODEMIND_ARCHIVE_QUOTA_MB", "2048")) * 1024 * 1024)
IMAGE_NODE = os.environ.get("CODEMIND_IMAGE_NODE", "")
IMAGE_PYTHON = os.environ.get("CODEMIND_IMAGE_PYTHON", "")
IMAGE_JAVA = os.environ.get("CODEMIND_IMAGE_JAVA", "")
IMAGE_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-fA-F0-9]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
app = FastAPI(title="CodeMind sandboxd", version="1.0.0")
log = logging.getLogger("codemind.sandboxd")
docker_client = None
worker_lock = threading.Lock()
active: set[str] = set()
submission_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
stop = threading.Event()


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Prevent a project-controlled app response from turning health checks into SSRF."""

    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


public_probe = urllib.request.build_opener(_NoRedirectHandler())


class RequestLimitMiddleware:
    def __init__(self, application, maximum: int) -> None:
        self.application, self.maximum = application, maximum

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http" or scope.get("path") != "/v1/jobs":
            await self.application(scope, receive, send)
            return
        size = 0
        async def bounded():
            nonlocal size
            message = await receive()
            if message.get("type") == "http.request":
                size += len(message.get("body", b""))
                if size > self.maximum:
                    raise HTTPException(413, "Request exceeds size limit.")
            return message
        await self.application(scope, bounded, send)


app.add_middleware(RequestLimitMiddleware, maximum=140 * 1024 * 1024)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _database():
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    ARCHIVES.mkdir(mode=0o700, parents=True, exist_ok=True)
    conn = sqlite3.connect(DB, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL,
        message TEXT NOT NULL, recipe TEXT, container_id TEXT, port INTEGER,
        url TEXT, logs TEXT NOT NULL DEFAULT '', limits_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
    columns = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
    if "runtime_started_at" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN runtime_started_at TEXT")
    return conn


def _auth(value: str | None) -> None:
    supplied = value[7:] if value and value.startswith("Bearer ") else ""
    if len(TOKEN) < 32 or not hmac.compare_digest(TOKEN, supplied):
        raise HTTPException(status_code=401, detail="Invalid sandboxd credentials.")


def _update(job_id: str, status: str, message: str, **fields: Any) -> None:
    allowed = {"recipe", "container_id", "port", "url", "logs", "runtime_started_at"}
    updates = {key: (_scrub(value) if key == "logs" and isinstance(value, str) else value)
               for key, value in fields.items() if key in allowed}
    assignments = ["status=?", "message=?", "updated_at=?"]
    values: list[Any] = [status, message[:2000], now()]
    for key, value in updates.items():
        assignments.append(f"{key}=?")
        values.append(value)
    values.append(job_id)
    with _database() as db:
        db.execute(f"UPDATE jobs SET {','.join(assignments)} WHERE id=?", values)


def _public(row: sqlite3.Row) -> dict[str, Any]:
    out = {"provider_id": row["id"], "status": row["status"], "message": row["message"]}
    if row["url"]:
        out["url"] = row["url"]
    if row["logs"]:
        out["logs"] = row["logs"][-LOG_LIMIT:]
    return out


def _limits(value: Any) -> dict[str, Any]:
    bounds = {"cpu_millicores": (100, 8000), "memory_mb": (128, 32768),
              "disk_mb": (128, 131072), "timeout_seconds": (10, 7200),
              "max_processes": (8, 4096)}
    if not isinstance(value, dict):
        raise HTTPException(400, "Runtime limits are required.")
    result = {}
    for key, (low, high) in bounds.items():
        val = value.get(key)
        if isinstance(val, bool) or not isinstance(val, int) or not low <= val <= high:
            raise HTTPException(400, "Invalid runtime limits.")
        result[key] = val
    if not isinstance(value.get("allow_outbound_network"), bool):
        raise HTTPException(400, "Invalid runtime limits.")
    result["allow_outbound_network"] = value["allow_outbound_network"]
    return result


def _read_archive(encoded: Any, digest: Any) -> tuple[bytes, list[tuple[str, bytes]]]:
    if not isinstance(encoded, str) or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        raise HTTPException(400, "Archive and SHA-256 digest are required.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise HTTPException(400, "Archive is not valid base64.") from exc
    if len(raw) > MAX_ARCHIVE or not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), digest.lower()):
        raise HTTPException(400, "Archive size or SHA-256 digest is invalid.")
    files: list[tuple[str, bytes]] = []
    seen_names: set[str] = set()
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FILES:
                raise HTTPException(413, "Archive contains too many files.")
            for item in infos:
                path = PurePosixPath(item.filename)
                mode = item.external_attr >> 16
                if (path.is_absolute() or not item.filename or "\\" in item.filename or
                    any(part in ("", ".", "..") for part in path.parts) or
                    (mode & 0o170000) == 0o120000):
                    raise HTTPException(400, "Archive contains an unsafe path or symbolic link.")
                if item.is_dir():
                    continue
                normalized = path.as_posix()
                if normalized in seen_names:
                    raise HTTPException(400, "Archive contains duplicate paths.")
                seen_names.add(normalized)
                if item.file_size > MAX_UNPACKED or total + item.file_size > MAX_UNPACKED:
                    raise HTTPException(413, "Unpacked archive exceeds the size limit.")
                content = io.BytesIO()
                actual = 0
                with archive.open(item, "r") as source:
                    while True:
                        chunk = source.read(64 * 1024)
                        if not chunk:
                            break
                        actual += len(chunk)
                        total += len(chunk)
                        if actual > item.file_size or total > MAX_UNPACKED:
                            raise HTTPException(413, "Unpacked archive exceeds the size limit.")
                        content.write(chunk)
                if actual != item.file_size:
                    raise HTTPException(400, "Archive entry size is inconsistent.")
                files.append((normalized, content.getvalue()))
    except zipfile.BadZipFile as exc:
        raise HTTPException(400, "Project archive is not a valid ZIP file.") from exc
    if not files:
        raise HTTPException(400, "Project archive contains no files.")
    return raw, files


def _detect(files: list[tuple[str, bytes]]) -> tuple[str, dict[str, Any]]:
    by_name = {name: data for name, data in files}
    if "package.json" in by_name:
        try:
            package = json.loads(by_name["package.json"].decode("utf-8"))
        except (UnicodeError, ValueError) as exc:
            raise ValueError("package.json is invalid") from exc
        if not isinstance(package, dict) or not isinstance(package.get("scripts", {}), dict):
            raise ValueError("package.json has an unsupported shape")
        if "package-lock.json" not in by_name:
            raise ValueError("Node recipe requires package-lock.json")
        return "node-npm", {"start": "start" in package.get("scripts", {}), "build": "build" in package.get("scripts", {})}
    if "pom.xml" in by_name:
        return "java-maven", {}
    if "requirements.txt" in by_name and ("main.py" in by_name or "app.py" in by_name):
        return "python-asgi", {"module": "main:app" if "main.py" in by_name else "app:app"}
    raise ValueError("No supported fixed recipe found. Supported recipes: Node/npm with package-lock.json, Maven, or Python requirements.txt plus main.py/app.py.")


def _tar(files: list[tuple[str, bytes]]) -> bytes:
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        for name, content in files:
            item = tarfile.TarInfo("work/" + name)
            item.size = len(content)
            item.mode = 0o644
            item.mtime = 0
            archive.addfile(item, io.BytesIO(content))
    return stream.getvalue()


def _recipe_commands(recipe: str, metadata: dict[str, Any]) -> tuple[str, str, list[str], list[str]]:
    if recipe == "node-npm":
        # Shell commands are fixed literals; npm lifecycle scripts are project
        # code and execute only inside the runsc container.
        cmd = ["/bin/sh", "-lc", "cd /work && npm ci --ignore-scripts" + (" && npm run build" if metadata["build"] else "")]
        if not metadata["start"]:
            raise ValueError("Node recipe requires a package.json start script for a runnable app.")
        run = ["/bin/sh", "-lc", "cd /work && PORT=8080 HOST=0.0.0.0 npm run start"]
        return IMAGE_NODE, "node-npm", ["/bin/sh", "-lc", "cd /work && npm ci" + (" && npm run build" if metadata["build"] else "")], run
    if recipe == "python-asgi":
        module = metadata["module"]
        build_cmd = ["/bin/sh", "-lc", "cd /work && python -m pip install --no-cache-dir -r requirements.txt uvicorn"]
        run_cmd = ["/bin/sh", "-lc", f"cd /work && exec python -m uvicorn {module} --host 0.0.0.0 --port 8080"]
        return IMAGE_PYTHON, "python-asgi", build_cmd, run_cmd
    if recipe == "java-maven":
        return IMAGE_JAVA, "java-maven", ["/bin/sh", "-lc", "cd /work && mvn -B -DskipTests package"], ["/bin/sh", "-lc", "cd /work && set -- target/*.jar; [ -f \"$1\" ] && exec java -jar \"$1\""]
    raise ValueError("Unsupported recipe ID")


def _caddy_route(host: str, port: int) -> bool:
    admin = os.environ.get("CODEMIND_CADDY_ADMIN_URL", "").rstrip("/")
    if not admin.startswith("http://127.0.0.1:"):
        return False
    route = {"@id": "codemind-" + host, "match": [{"host": [host]}],
             "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": f"127.0.0.1:{port}"}]}], "terminal": True}
    req = Request(admin + "/config/apps/http/servers/srv0/routes", data=json.dumps(route).encode(),
                  headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=5) as response:
            return 200 <= response.status < 300
    except (URLError, TimeoutError):
        return False


def _run_job(job_id: str, claimed: bool = False) -> None:
    if not claimed:
        with worker_lock:
            if job_id in active or len(active) >= MAX_CONCURRENT:
                return
            active.add(job_id)
    cont = None
    app_network_obj = None
    route_host = ""
    try:
        with _database() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row or row["status"] in {"failed", "succeeded", "cancelled"}:
            return
        if row["status"] == "starting" and row["container_id"]:
            try:
                recovered = docker_client.containers.get(row["container_id"])
                if recovered.status != "running":
                    _update(job_id, "failed", "Sandbox app stopped while sandboxd was restarting.")
                    return
                domain = os.environ.get("CODEMIND_PUBLIC_BASE_DOMAIN", "").strip().lower().strip(".")
                recovered_host = _hostname(job_id, domain)
                recovered_url = "https://" + recovered_host
                if _valid_domain(domain) and row["port"] and _wait_local(int(row["port"]), 10) and _caddy_route(recovered_host, int(row["port"])) and _wait_https(recovered_url, 30):
                    _update(job_id, "succeeded", "App is healthy behind verified HTTPS ingress.", url=recovered_url, logs=_container_logs(recovered))
                    return
                _update(job_id, "failed", "App could not be revalidated behind HTTPS ingress after sandboxd restart.", logs=_container_logs(recovered))
                return
            except Exception:
                _update(job_id, "failed", "Sandbox app could not be recovered after sandboxd restart.")
                return
        config = os.environ.get("CODEMIND_PUBLIC_BASE_DOMAIN", "").strip().lower().strip(".")
        if not _valid_domain(config) or not _caddy_ready():
            _update(job_id, "failed", "needs_configuration: configure a real application domain, DNS/TLS, and local Caddy ingress before enabling deployments.")
            return
        if not os.environ.get("CODEMIND_EGRESS_PROXY") and json.loads(row["limits_json"])["allow_outbound_network"]:
            _update(job_id, "failed", "needs_configuration: outbound network was requested but no controlled egress proxy/network is configured.")
            return
        archive_path = ARCHIVES / (job_id + ".zip")
        raw = archive_path.read_bytes()
        if not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), row["digest"]):
            _update(job_id, "failed", "Stored project archive digest verification failed.")
            return
        _, files = _read_archive(base64.b64encode(raw).decode("ascii"), row["digest"])
        recipe, metadata = _detect(files)
        if not limits["allow_outbound_network"]:
            _update(job_id, "failed", "needs_configuration: this recipe must download dependencies; outbound egress is disabled by default. Configure an ACL-restricted package proxy and request controlled build egress.", recipe=recipe)
            return
        image, recipe, build_cmd, run_cmd = _recipe_commands(recipe, metadata)
        unpacked_size = sum(len(data) for _, data in files)
        if unpacked_size > limits["disk_mb"] * 1024 * 1024:
            _update(job_id, "failed", "Project contents exceed the configured workspace disk limit.", recipe=recipe)
            return
        limits = json.loads(row["limits_json"])
        egress_proxy = os.environ.get("CODEMIND_EGRESS_PROXY", "").strip()
        build_network = "none"
        env = {"HOME": "/tmp", "PORT": "8080", "HOST": "0.0.0.0"}
        if limits["allow_outbound_network"]:
            if not egress_proxy or "@" in egress_proxy:
                _update(job_id, "failed", "needs_configuration: configure a credential-free controlled package egress proxy and firewall-enforced build network.")
                return
            build_network = os.environ.get("CODEMIND_BUILD_NETWORK", "")
            if not build_network:
                _update(job_id, "failed", "needs_configuration: CODEMIND_BUILD_NETWORK must name an operator-created egress-restricted Docker network.")
                return
            env.update({"HTTP_PROXY": egress_proxy, "HTTPS_PROXY": egress_proxy, "http_proxy": egress_proxy, "https_proxy": egress_proxy})
        docker_client.images.get(image)  # images are provisioned by the operator; sandboxd does not pull implicitly
        port = _port()
        app_network = "codemind-app-" + job_id[:20]
        app_network_obj = docker_client.networks.create(app_network, driver="bridge", internal=True,
                                                        labels={"codemind.managed": "true", "codemind.job": job_id})
        limits_cpu = int(limits["cpu_millicores"] * 1_000_000)
        mem = int(limits["memory_mb"] * 1024 * 1024)
        disk = int(limits["disk_mb"] * 1024 * 1024)
        initial_network = build_network if build_network != "none" else app_network
        cont = docker_client.containers.create(
            image=image, command=["sleep", "infinity"], detach=True, name="codemind-" + job_id[:24],
            labels={"codemind.managed": "true", "codemind.job": job_id},
            runtime="runsc", network=initial_network,
            ports={"8080/tcp": ("127.0.0.1", port)},
            environment=env, working_dir="/work", user="65532:65532",
            read_only=True, cap_drop=["ALL"], security_opt=["no-new-privileges:true"],
            mem_limit=mem, nano_cpus=limits_cpu, pids_limit=limits["max_processes"],
            tmpfs={"/work": f"rw,nosuid,nodev,size={disk},uid=65532,gid=65532",
                   "/tmp": "rw,nosuid,nodev,noexec,size=67108864,uid=65532,gid=65532"},
            restart_policy={"Name": "no"},
        )
        _update(job_id, "building", "Building in a disposable runsc sandbox.", recipe=recipe, container_id=cont.id, port=port)
        cont.start()
        cont.put_archive("/", _tar(files))
        exec_result = _exec_bounded(cont, build_cmd, limits["timeout_seconds"], env)
        logs = exec_result[1]
        if exec_result[0] != 0:
            cont.remove(force=True)
            app_network_obj.remove()
            _update(job_id, "failed", "Build failed inside the runsc sandbox.", logs=logs)
            return
        _update(job_id, "starting", "Build completed; starting the app in its private runsc network.", logs=logs)
        if build_network != "none":
            docker_client.networks.get(build_network).disconnect(cont, force=True)
            app_network_obj.connect(cont)
        run_id = cont.exec_run(run_cmd, detach=True, workdir="/work", environment=env, user="65532:65532")
        if not run_id:
            raise RuntimeError("runtime command did not start")
        hostname = _hostname(job_id, config)
        route_host = hostname
        local_ready = _wait_local(port, limits["timeout_seconds"])
        if not local_ready:
            logs = _container_logs(cont)
            cont.remove(force=True)
            app_network_obj.remove()
            _update(job_id, "failed", "App did not become healthy on its private port.", logs=logs)
            return
        if not _caddy_route(hostname, port):
            logs = _container_logs(cont)
            cont.remove(force=True)
            app_network_obj.remove()
            _update(job_id, "failed", "needs_configuration: Caddy could not install the app route; verify its local admin API and srv0 server.", logs=logs)
            return
        url = "https://" + hostname
        if not _wait_https(url, limits["timeout_seconds"]):
            logs = _container_logs(cont)
            _remove_caddy_route(hostname)
            cont.remove(force=True)
            app_network_obj.remove()
            _update(job_id, "failed", "needs_configuration: the public hostname or HTTPS ingress is not reachable yet; verify DNS, firewall, and Caddy TLS.", logs=logs)
            return
        _update(job_id, "succeeded", "App is healthy behind verified HTTPS ingress.", container_id=cont.id, port=port, url=url, logs=_container_logs(cont), runtime_started_at=now())
    except Exception as exc:
        # Avoid exception strings: Docker errors can include paths and environment details.
        log.error("sandbox job %s failed (%s)", job_id, type(exc).__name__)
        if route_host:
            _remove_caddy_route(route_host)
        if cont is not None:
            try:
                cont.remove(force=True)
            except Exception:
                pass
        if app_network_obj is not None:
            try:
                app_network_obj.remove()
            except Exception:
                pass
        _update(job_id, "failed", "Sandbox execution failed. Verify Docker runsc, preloaded recipe images, resource support, and host configuration.")
    finally:
        try:
            with _database() as db:
                terminal = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            if terminal and terminal["status"] in {"failed", "succeeded", "cancelled"}:
                (ARCHIVES / (job_id + ".zip")).unlink(missing_ok=True)
        except Exception:
            pass
        with worker_lock:
            active.discard(job_id)


def _caddy_ready() -> bool:
    admin = os.environ.get("CODEMIND_CADDY_ADMIN_URL", "").rstrip("/")
    if not admin.startswith("http://127.0.0.1:"):
        return False
    try:
        with urlopen(admin + "/config/", timeout=2) as response:
            return 200 <= response.status < 300
    except (URLError, TimeoutError):
        return False


def _exec_bounded(container, command: list[str], timeout: int, environment: dict[str, str]) -> tuple[int, str]:
    # Base images include coreutils timeout. This is a fixed argv prefix around
    # the daemon's hard-coded recipe; no project command string is interpolated.
    timed = ["timeout", "--signal=KILL", f"{timeout}s", *command]
    created = docker_client.api.exec_create(container.id, timed, workdir="/work", user="65532:65532", environment=environment)
    output = docker_client.api.exec_start(created["Id"], stream=True, demux=True)
    tail = bytearray()
    for chunk in output:
        if isinstance(chunk, tuple):
            chunk = (chunk[0] or b"") + (chunk[1] or b"")
        if chunk:
            tail.extend(chunk)
            if len(tail) > LOG_LIMIT:
                del tail[:-LOG_LIMIT]
    info = docker_client.api.exec_inspect(created["Id"])
    return int(info.get("ExitCode") or 0), _scrub(tail.decode("utf-8", "replace"))


def _wait_local(port: int, timeout: int) -> bool:
    deadline = time.monotonic() + min(timeout, 180)
    while time.monotonic() < deadline:
        try:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            connection.request("GET", "/")
            response = connection.getresponse()
            response.read(1024)
            connection.close()
            if 200 <= response.status < 300:
                return True
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(2)
    return False


def _wait_https(url: str, timeout: int) -> bool:
    expected_host = (urlsplit(url).hostname or "").lower().rstrip(".")
    if not expected_host or urlsplit(url).scheme != "https":
        return False
    deadline = time.monotonic() + min(timeout, 180)
    while time.monotonic() < deadline:
        try:
            # Do not follow redirects from the untrusted application. A redirect
            # could otherwise make the privileged daemon request localhost or
            # cloud metadata endpoints while performing an HTTPS health check.
            with public_probe.open(url, timeout=5) as response:
                response.read(1024)
                actual_host = (urlsplit(response.geturl()).hostname or "").lower().rstrip(".")
                if 200 <= response.status < 300 and actual_host == expected_host:
                    return True
        except Exception:
            time.sleep(3)
    return False


def _container_logs(container) -> str:
    try:
        tail = bytearray()
        for chunk in container.logs(tail=200, timestamps=False, stream=True):
            tail.extend(chunk)
            if len(tail) > LOG_LIMIT:
                del tail[:-LOG_LIMIT]
        return _scrub(tail.decode("utf-8", "replace"))
    except Exception:
        return ""


def _valid_domain(domain: str) -> bool:
    if not domain or domain.endswith("example.com") or len(domain) > 240:
        return False
    labels = domain.split(".")
    return len(labels) >= 2 and all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)


def _hostname(job_id: str, domain: str) -> str:
    return hashlib.sha256(job_id.encode("ascii")).hexdigest()[:24] + "." + domain


def _scrub(value: str) -> str:
    value = re.sub(r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+", r"\1[redacted]", value)
    value = re.sub(r"(?i)(password|passwd|token|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;]+", r"\1\2[redacted]", value)
    value = re.sub(r"(?i)(https?://)[^/@\s]+:[^/@\s]+@", r"\1[redacted]@", value)
    return value[-LOG_LIMIT:]


def _remove_caddy_route(host: str) -> None:
    admin = os.environ.get("CODEMIND_CADDY_ADMIN_URL", "").rstrip("/")
    if not admin.startswith("http://127.0.0.1:"):
        return
    request = Request(admin + "/id/" + quote("codemind-" + host, safe=""), method="DELETE")
    try:
        with urlopen(request, timeout=4):
            pass
    except (URLError, TimeoutError):
        pass


def _maintain_runtime(row: sqlite3.Row) -> None:
    try:
        limits = json.loads(row["limits_json"])
        started = datetime.fromisoformat(row["runtime_started_at"] or row["created_at"])
        # Build timeout bounds dependency install/build/startup work. A separate
        # operator policy controls how long a healthy deployed app can remain.
        max_lifetime = int(os.environ.get("CODEMIND_MAX_DEPLOYMENT_LIFETIME_SECONDS", "2592000"))
        if max_lifetime > 0 and (datetime.now(timezone.utc) - started).total_seconds() >= max_lifetime:
            _stop_job_resources(row)
            _update(row["id"], "failed", "Deployment reached the configured maximum service lifetime.")
            return
        container = docker_client.containers.get(row["container_id"])
        if container.status != "running" or not row["port"] or not _wait_local(int(row["port"]), 1) or not _wait_https(row["url"], 1):
            _stop_job_resources(row)
            _update(row["id"], "failed", "App health check failed; isolated runtime was stopped.")
    except Exception:
        _stop_job_resources(row)
        _update(row["id"], "failed", "Runtime could not be verified; isolated runtime was stopped.")


def _stop_job_resources(row: sqlite3.Row) -> None:
    domain = os.environ.get("CODEMIND_PUBLIC_BASE_DOMAIN", "").strip().lower().strip(".")
    if domain:
        _remove_caddy_route(_hostname(row["id"], domain))
    if row["container_id"]:
        try:
            docker_client.containers.get(row["container_id"]).remove(force=True)
        except Exception:
            pass
    try:
        docker_client.networks.get("codemind-app-" + row["id"][:20]).remove()
    except Exception:
        pass


def _port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@app.on_event("startup")
def startup() -> None:
    global docker_client
    if len(TOKEN) < 32:
        raise RuntimeError("CODEMIND_SANDBOXD_TOKEN must be at least 32 characters.")
    configured_images = {"node": IMAGE_NODE, "python": IMAGE_PYTHON, "java": IMAGE_JAVA}
    for stack, image_ref in configured_images.items():
        if not IMAGE_REF_RE.fullmatch(image_ref):
            raise RuntimeError(f"CODEMIND_IMAGE_{stack.upper()} must be a digest-pinned image reference ending in @sha256:<64 hex characters>.")
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    ARCHIVES.mkdir(mode=0o700, parents=True, exist_ok=True)
    docker_client = docker.from_env()
    info = docker_client.info()
    if "runsc" not in info.get("Runtimes", {}):
        raise RuntimeError("Docker runtime 'runsc' is not configured; refusing to execute workloads.")
    for image in configured_images.values():
        try:
            docker_client.images.get(image)
        except NotFound as exc:
            raise RuntimeError("Missing exact digest-pinned sandbox recipe image: " + image) from exc
    stop.clear()
    threading.Thread(target=_recovery_loop, name="sandboxd-recovery", daemon=True).start()


def _recovery_loop() -> None:
    while not stop.is_set():
        try:
            with _database() as db:
                rows = db.execute("SELECT id,status FROM jobs WHERE status IN ('queued','building','starting','succeeded')").fetchall()
            for row in rows:
                if row["status"] == "succeeded":
                    with _database() as db:
                        full = db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()
                    _maintain_runtime(full)
                # Start at most the configured number of workers. Queued jobs
                # remain durable and are scheduled on the next loop iteration.
                else:
                    with worker_lock:
                        slots = max(0, MAX_CONCURRENT - len(active))
                    if slots <= 0:
                        break
                    scheduled = 0
                    for candidate in rows:
                        if candidate["status"] == "succeeded":
                            continue
                        with worker_lock:
                            if candidate["id"] in active or len(active) >= MAX_CONCURRENT:
                                continue
                            active.add(candidate["id"])
                        threading.Thread(target=_run_job, args=(candidate["id"], True), daemon=True).start()
                        scheduled += 1
                        if scheduled >= slots:
                            break
                    break
        except Exception:
            log.exception("sandbox recovery loop failed")
        stop.wait(10)


@app.on_event("shutdown")
def shutdown() -> None:
    stop.set()


@app.get("/v1/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "codemind-sandboxd", "runtime": "runsc"}


@app.post("/v1/jobs")
async def submit(request: ApiRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _auth(authorization)
    if not submission_slots.acquire(blocking=False):
        raise HTTPException(503, "Sandbox admission is at capacity; retry after an upload slot becomes available.")
    try:
        return await _submit_admitted(request)
    finally:
        submission_slots.release()


async def _submit_admitted(request: ApiRequest) -> dict[str, Any]:
    if int(request.headers.get("content-length", "0") or 0) > 140 * 1024 * 1024:
        raise HTTPException(413, "Request exceeds size limit.")
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(400, "Request must contain valid JSON.") from exc
    job_id = payload.get("deployment_id") if isinstance(payload, dict) else None
    if not isinstance(job_id, str) or not ID_RE.fullmatch(job_id):
        raise HTTPException(400, "Invalid deployment identifier.")
    with _database() as db:
        existing = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if existing:
            if existing["digest"] != str(payload.get("source_digest", "")).lower():
                raise HTTPException(409, "Deployment identifier already exists with a different digest.")
            return _public(existing)
        count = db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','building','starting','succeeded')").fetchone()[0]
        if count >= MAX_ACTIVE_DEPLOYMENTS:
            raise HTTPException(503, "Sandbox deployment capacity is full; retry after a deployment terminates.")
    raw, _ = _read_archive(payload.get("archive_base64"), payload.get("source_digest"))
    limits = _limits(payload.get("limits"))
    with _database() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if existing:
            if existing["digest"] != payload["source_digest"].lower():
                raise HTTPException(409, "Deployment identifier already exists with a different digest.")
            return _public(existing)
        active_count = db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','building','starting','succeeded')").fetchone()[0]
        if active_count >= MAX_ACTIVE_DEPLOYMENTS:
            raise HTTPException(503, "Sandbox deployment capacity is full; retry after a deployment terminates.")
        used = sum(path.stat().st_size for path in ARCHIVES.glob("*.zip") if path.is_file())
        if used + len(raw) > ARCHIVE_QUOTA:
            raise HTTPException(507, "Sandbox archive storage quota is full; operator retention is required.")
        path = ARCHIVES / (job_id + ".zip")
        with path.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        db.execute("INSERT INTO jobs(id,digest,status,message,limits_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                   (job_id, payload["source_digest"].lower(), "queued", "Accepted; waiting for an isolated runsc sandbox.", json.dumps(limits), now(), now()))
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return _public(row)


@app.get("/v1/jobs/{job_id}")
def status(job_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _auth(authorization)
    if not ID_RE.fullmatch(job_id):
        raise HTTPException(404, "Job not found.")
    with _database() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Job not found.")
    return _public(row)

