"""Fail-closed deployment recipe discovery and isolated-runner contract.

This module only inspects project metadata. It never extracts a source tree to
the host, invokes shell commands, starts containers, or evaluates project files.
The discovered recipe identifiers are hints for a separately isolated
DeploymentProvider; they are not permission to execute a manifest script.
"""

from __future__ import annotations

import json
import base64
import hashlib
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import PurePosixPath
from typing import Dict, List, Optional, Protocol, Tuple
from urllib.parse import urlsplit

from .intake import MAX_ARCHIVE_BYTES, safe_path


MAX_MANIFEST_BYTES = 1_048_576
MAX_ARCHIVE_ENTRIES = 40_000
MAX_EXPANDED_BYTES = 500 * 1024 * 1024
MAX_RUNNER_RESPONSE_BYTES = 1_048_576
RUNNER_STATUS_TIMEOUT_SECONDS = 20
RUNNER_SUBMIT_TIMEOUT_SECONDS = 600


@dataclass(frozen=True)
class RuntimeLimits:
    """Upper bounds that a remote/isolated runner must enforce independently."""

    cpu_millicores: int = 1_000
    memory_mb: int = 1_024
    disk_mb: int = 2_048
    timeout_seconds: int = 900
    max_processes: int = 128
    allow_outbound_network: bool = False

    def validate(self) -> None:
        if not 100 <= self.cpu_millicores <= 8_000:
            raise ValueError("cpu_millicores must be between 100 and 8000")
        if not 128 <= self.memory_mb <= 32_768:
            raise ValueError("memory_mb must be between 128 and 32768")
        if not 128 <= self.disk_mb <= 131_072:
            raise ValueError("disk_mb must be between 128 and 131072")
        if not 10 <= self.timeout_seconds <= 7_200:
            raise ValueError("timeout_seconds must be between 10 and 7200")
        if not 8 <= self.max_processes <= 4_096:
            raise ValueError("max_processes must be between 8 and 4096")


@dataclass(frozen=True)
class RecipeCandidate:
    stack: str
    runtime_family: str
    build_recipe_id: Optional[str]
    start_recipe_id: Optional[str]
    package_manager: Optional[str] = None
    entrypoint_hint: Optional[str] = None
    manifest_paths: Tuple[str, ...] = ()
    confidence: str = "medium"
    notes: Tuple[str, ...] = ()


@dataclass(frozen=True)
class DeploymentPlan:
    snapshot_id: Optional[str]
    source_digest: Optional[str]
    status: str
    candidates: Tuple[RecipeCandidate, ...]
    project_files: Tuple[str, ...]
    requires_isolated_runner: bool = True
    requires_review: bool = False
    reason: str = ""

    def to_dict(self) -> Dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class SnapshotReference:
    snapshot_id: str
    source_digest: str
    archive_path: str


@dataclass(frozen=True)
class DeploymentResult:
    status: str
    message: str
    url: Optional[str] = None
    provider_deployment_id: Optional[str] = None
    log_reference: Optional[str] = None


class DeploymentProvider(Protocol):
    """Interface for a separately isolated deployment service.

    Implementations must enforce all RuntimeLimits on the execution host and
    must not expose a general-purpose host daemon/socket to the API process.
    """

    def submit(
        self,
        snapshot: SnapshotReference,
        plan: DeploymentPlan,
        limits: RuntimeLimits,
    ) -> Dict[str, object]:
        """Submit a verified snapshot and return its runner deployment record."""
        ...

    def status(self, provider_deployment_id: str) -> Dict[str, object]:
        """Return a bounded status record for a submitted deployment."""
        ...


class DeploymentUnavailable(RuntimeError):
    """Raised by the default provider until a secure runner is configured."""


class RemoteRunnerProvider:
    """Authenticated HTTPS client for a separately hosted isolated runner.

    CodeMind sends only an immutable, digest-verified archive to the explicitly
    configured endpoint. The runner must independently verify the digest and
    enforce the supplied limits. No source code is executed in this process.
    """

    def __init__(self, base_url: str, bearer_token: str, allowed_domains: Tuple[str, ...] = ()) -> None:
        parsed = urlsplit(base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("CODEMIND_RUNNER_URL must be an HTTPS URL without credentials, query, or fragment.")
        if parsed.port not in (None, 443):
            raise ValueError("CODEMIND_RUNNER_URL must use the standard HTTPS port.")
        if not bearer_token or len(bearer_token) < 32 or "\r" in bearer_token or "\n" in bearer_token:
            raise ValueError("CODEMIND_RUNNER_TOKEN must contain at least 32 characters.")
        self.base_url = base_url.rstrip("/")
        self.token = bearer_token
        self.allowed_domains = allowed_domains
        self._ssl_context = ssl.create_default_context()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=self._ssl_context),
            _NoRedirectHandler(),
        )

    def submit(self, snapshot: SnapshotReference, plan: DeploymentPlan, limits: RuntimeLimits) -> Dict[str, object]:
        limits.validate()
        if plan.status != "candidate" or plan.requires_review:
            raise DeploymentUnavailable("This project needs review or deployment configuration before it can be sent to a runner.")
        if plan.snapshot_id != snapshot.snapshot_id or plan.source_digest != snapshot.source_digest:
            raise ValueError("Deployment plan and source snapshot identifiers do not match.")
        archive_bytes = self._read_verified_snapshot(snapshot)
        payload = {
            "protocol_version": 1,
            "snapshot_id": snapshot.snapshot_id,
            "source_digest": snapshot.source_digest,
            "archive_base64": base64.b64encode(archive_bytes).decode("ascii"),
            "plan": plan.to_dict(),
            "limits": asdict(limits),
        }
        idempotency_key = hashlib.sha256(
            (snapshot.snapshot_id + ":" + snapshot.source_digest.lower()).encode("utf-8")
        ).hexdigest()
        result = self._request(
            "POST", "/v1/deployments", payload, RUNNER_SUBMIT_TIMEOUT_SECONDS,
            extra_headers={"Idempotency-Key": idempotency_key},
        )
        self._validate_job_response(result, require_id=True)
        return result

    def status(self, provider_deployment_id: str) -> Dict[str, object]:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", provider_deployment_id):
            raise ValueError("Runner deployment identifier is malformed.")
        result = self._request("GET", "/v1/deployments/" + urllib.parse.quote(provider_deployment_id, safe=""), timeout=RUNNER_STATUS_TIMEOUT_SECONDS)
        self._validate_job_response(result, require_id=False)
        return result

    def _read_verified_snapshot(self, snapshot: SnapshotReference) -> bytes:
        if not re.fullmatch(r"[A-Fa-f0-9]{64}", snapshot.source_digest):
            raise ValueError("Snapshot digest must be a SHA-256 hex digest.")
        with open(snapshot.archive_path, "rb") as stream:
            data = stream.read(MAX_ARCHIVE_BYTES + 1)
        if len(data) > MAX_ARCHIVE_BYTES:
            raise ValueError("Source archive exceeds the configured runner transfer limit.")
        if not hashlib.sha256(data).hexdigest() == snapshot.source_digest.lower():
            raise ValueError("Source snapshot digest verification failed; it was not sent to the runner.")
        return data

    def _request(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, object]] = None,
        timeout: int = RUNNER_STATUS_TIMEOUT_SECONDS,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, object]:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else None
        headers = {
            "Accept": "application/json",
            "Authorization": "Bearer " + self.token,
            **({"Content-Type": "application/json"} if body is not None else {}),
            **(extra_headers or {}),
        }
        request = urllib.request.Request(
            self.base_url + path,
            data=body,
            method=method,
            headers=headers,
        )
        try:
            with self._opener.open(request, timeout=timeout) as response:
                if response.status < 200 or response.status >= 300:
                    raise DeploymentUnavailable("The isolated runner rejected the deployment request.")
                raw = response.read(MAX_RUNNER_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RUNNER_RESPONSE_BYTES:
                    raise DeploymentUnavailable("The isolated runner response exceeded the size limit.")
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise DeploymentUnavailable("The isolated deployment runner is unavailable.") from error
        try:
            result = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise DeploymentUnavailable("The isolated runner returned an invalid response.") from error
        if not isinstance(result, dict):
            raise DeploymentUnavailable("The isolated runner returned an invalid response.")
        return result

    def _validate_job_response(self, result: Dict[str, object], require_id: bool) -> None:
        deployment_id = result.get("deployment_id")
        if (require_id or deployment_id is not None) and (not isinstance(deployment_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", deployment_id)):
            raise DeploymentUnavailable("The isolated runner returned a malformed deployment identifier.")
        status = result.get("status")
        if status not in {"queued", "building", "starting", "succeeded", "failed", "cancelled"}:
            raise DeploymentUnavailable("The isolated runner returned an unsupported deployment status.")
        message = result.get("message", "")
        if not isinstance(message, str) or len(message) > 2_000:
            raise DeploymentUnavailable("The isolated runner returned an invalid status message.")
        if status == "succeeded" and not isinstance(result.get("url"), str):
            raise DeploymentUnavailable("The isolated runner reported success without a deployment URL.")
        if "url" in result:
            try:
                validate_deployment_url(result.get("url") if isinstance(result.get("url"), str) else None, self.allowed_domains)
            except ValueError as error:
                raise DeploymentUnavailable("The isolated runner returned a URL outside the configured HTTPS domain allowlist.") from error
        logs = result.get("logs")
        if logs is not None and (not isinstance(logs, str) or len(logs) > 32_000):
            raise DeploymentUnavailable("The isolated runner returned oversized log output.")


def configured_deployment_provider() -> DeploymentProvider:
    """Build the configured provider; missing credentials always fail closed."""
    runner_url = os.environ.get("CODEMIND_RUNNER_URL", "").strip()
    runner_token = os.environ.get("CODEMIND_RUNNER_TOKEN", "")
    if not runner_url and not runner_token:
        return DisabledDeploymentProvider()
    if not runner_url or not runner_token:
        raise RuntimeError("Set both CODEMIND_RUNNER_URL and CODEMIND_RUNNER_TOKEN to enable the isolated runner.")
    domains = tuple(
        domain.strip().lower().lstrip(".").rstrip(".")
        for domain in os.environ.get("CODEMIND_DEPLOYMENT_DOMAINS", "").split(",")
        if domain.strip()
    )
    return RemoteRunnerProvider(runner_url, runner_token, domains)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Never forward a bearer credential to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class DisabledDeploymentProvider:
    """Default fail-closed provider; no uploaded source is ever executed."""

    def submit(
        self,
        snapshot: SnapshotReference,
        plan: DeploymentPlan,
        limits: RuntimeLimits,
    ) -> Dict[str, object]:
        limits.validate()
        raise DeploymentUnavailable(
            "No isolated deployment provider is configured. The snapshot was not executed."
        )

    def status(self, provider_deployment_id: str) -> Dict[str, object]:
        raise DeploymentUnavailable("No isolated deployment provider is configured.")


def _read_member(archive: zipfile.ZipFile, name: str) -> Optional[bytes]:
    try:
        info = archive.getinfo(name)
    except KeyError:
        return None
    if info.is_dir() or info.file_size > MAX_MANIFEST_BYTES:
        return None
    with archive.open(info) as stream:
        data = stream.read(MAX_MANIFEST_BYTES + 1)
    return data if len(data) <= MAX_MANIFEST_BYTES else None


def _inventory(archive_path: str) -> Tuple[Dict[str, int], Dict[str, bytes], List[str]]:
    paths: Dict[str, int] = {}
    contents: Dict[str, bytes] = {}
    try:
        with zipfile.ZipFile(archive_path) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ARCHIVE_ENTRIES:
                raise ValueError("The snapshot has too many archive entries for deployment inspection.")
            expanded_total = 0
            for entry in entries:
                normalized = safe_path(entry.filename.rstrip("/") if entry.is_dir() else entry.filename)
                if entry.is_dir():
                    continue
                expanded_total += entry.file_size
                if expanded_total > MAX_EXPANDED_BYTES:
                    raise ValueError("The snapshot exceeds the deployment inspection size limit.")
                paths[normalized] = entry.file_size
            candidate_names = {
                "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
                "pyproject.toml", "requirements.txt", "poetry.lock", "uv.lock",
                "pom.xml", "build.gradle", "build.gradle.kts", "gradlew",
                "dockerfile", "compose.yaml", "docker-compose.yml",
            }
            for path in paths:
                if PurePosixPath(path).name.lower() in candidate_names:
                    value = _read_member(archive, path)
                    if value is not None:
                        contents[path] = value
            return paths, contents, []
    except (OSError, zipfile.BadZipFile) as error:
        raise ValueError("The source snapshot is not a readable ZIP archive.") from error


def _candidate_paths(paths: Dict[str, int], names: set) -> List[str]:
    return sorted(path for path in paths if PurePosixPath(path).name.lower() in names)


def _package_json(contents: Dict[str, bytes], path: str) -> Dict[str, object]:
    raw = contents.get(path)
    if raw is None:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _node_candidate(paths: Dict[str, int], contents: Dict[str, bytes], package_path: str) -> RecipeCandidate:
    package = _package_json(contents, package_path)
    manager_files = {
        "pnpm-lock.yaml": "pnpm",
        "yarn.lock": "yarn",
        "package-lock.json": "npm",
    }
    folder = str(PurePosixPath(package_path).parent)
    lock_file = None
    for lock_name, manager in manager_files.items():
        possible = f"{folder}/{lock_name}" if folder != "." else lock_name
        if possible in paths:
            lock_file = manager
            break
    if lock_file is None:
        lock_file = "npm"

    scripts = package.get("scripts") if isinstance(package.get("scripts"), dict) else {}
    build_script = "build" in scripts
    start_script = any(key in scripts for key in ("start", "serve", "preview"))
    all_deps: Dict[str, object] = {}
    for key in ("dependencies", "devDependencies"):
        value = package.get(key)
        if isinstance(value, dict):
            all_deps.update(value)
    if "next" in all_deps:
        framework = "next.js"
    elif "vite" in all_deps:
        framework = "vite"
    elif "react" in all_deps:
        framework = "react"
    elif "express" in all_deps:
        framework = "express"
    else:
        framework = "node.js"

    notes = ["Manifest scripts are untrusted and must only run inside the isolated deployment provider."]
    if not build_script:
        notes.append("No package.json build script was detected; the project may need a user-supplied build recipe.")
    if not start_script:
        notes.append("No conventional start/serve/preview script was detected; startup requires review.")
    return RecipeCandidate(
        stack=framework,
        runtime_family="node",
        build_recipe_id=f"node.{lock_file}.manifest-build" if build_script else None,
        start_recipe_id=f"node.{lock_file}.manifest-start" if start_script else None,
        package_manager=lock_file,
        entrypoint_hint=None,
        manifest_paths=(package_path,),
        confidence="high" if build_script and start_script else "medium",
        notes=tuple(notes),
    )


def _python_candidate(paths: Dict[str, int], contents: Dict[str, bytes]) -> RecipeCandidate:
    manifests = tuple(_candidate_paths(paths, {"pyproject.toml", "requirements.txt"}))
    path_set = set(paths)
    entrypoint = next((path for path in ("main.py", "app.py", "manage.py", "src/main.py", "src/app.py") if path in path_set), None)
    text = "\n".join(value.decode("utf-8", "ignore") for name, value in contents.items() if PurePosixPath(name).name.lower() in {"pyproject.toml", "requirements.txt"}).lower()
    if "fastapi" in text:
        framework = "fastapi"
    elif "django" in text:
        framework = "django"
    elif "flask" in text:
        framework = "flask"
    else:
        framework = "python"
    start = None
    if entrypoint and framework == "fastapi":
        start = "python.asgi-module"
    elif entrypoint and framework in {"flask", "django"}:
        start = "python.wsgi-module"
    notes = ["Dependency installation and startup are untrusted execution and require an isolated provider."]
    if not entrypoint:
        notes.append("No conventional Python entrypoint was found; startup configuration requires review.")
    return RecipeCandidate(
        stack=framework,
        runtime_family="python",
        build_recipe_id="python.dependencies" if manifests else None,
        start_recipe_id=start,
        manifest_paths=manifests,
        entrypoint_hint=entrypoint,
        confidence="medium" if entrypoint and manifests else "low",
        notes=tuple(notes),
    )


def _java_candidate(paths: Dict[str, int], contents: Dict[str, bytes]) -> RecipeCandidate:
    manifests = tuple(_candidate_paths(paths, {"pom.xml", "build.gradle", "build.gradle.kts", "gradlew"}))
    lower_manifest = "\n".join(value.decode("utf-8", "ignore") for name, value in contents.items() if PurePosixPath(name).name.lower() in {"pom.xml", "build.gradle", "build.gradle.kts"}).lower()
    framework = "spring boot" if "spring-boot" in lower_manifest or "springboot" in lower_manifest else "java"
    has_maven = any(PurePosixPath(path).name.lower() == "pom.xml" for path in manifests)
    has_gradle = any(PurePosixPath(path).name.lower() in {"build.gradle", "build.gradle.kts", "gradlew"} for path in manifests)
    if has_maven and has_gradle:
        build_recipe = None
        notes = ("Both Maven and Gradle manifests were found; select the build system before deployment.", "Build scripts are untrusted and require an isolated provider.")
    else:
        build_recipe = "java.maven.package" if has_maven else ("java.gradle.build" if has_gradle else None)
        notes = ("The detected build tool executes project-controlled plugins/tasks and requires an isolated provider.",)
    return RecipeCandidate(
        stack=framework,
        runtime_family="java",
        build_recipe_id=build_recipe,
        start_recipe_id=("java.spring-boot-artifact" if build_recipe and framework == "spring boot" else None),
        manifest_paths=manifests,
        confidence="medium" if build_recipe else "low",
        notes=notes,
    )


def inspect_deployment(
    archive_path: str,
    snapshot_id: Optional[str] = None,
    source_digest: Optional[str] = None,
) -> DeploymentPlan:
    """Identify deployment candidates without executing project-controlled data."""
    paths, contents, _ = _inventory(archive_path)
    candidates: List[RecipeCandidate] = []
    package_files = _candidate_paths(paths, {"package.json"})
    py_manifests = _candidate_paths(paths, {"pyproject.toml", "requirements.txt"})
    java_manifests = _candidate_paths(paths, {"pom.xml", "build.gradle", "build.gradle.kts", "gradlew"})

    if package_files:
        for package_path in package_files[:8]:
            candidates.append(_node_candidate(paths, contents, package_path))
    if py_manifests:
        candidates.append(_python_candidate(paths, contents))
    if java_manifests:
        candidates.append(_java_candidate(paths, contents))

    custom_dockerfiles = _candidate_paths(paths, {"dockerfile"})
    compose_files = _candidate_paths(paths, {"compose.yaml", "compose.yml", "docker-compose.yml"})
    multiple_packages = len(package_files) > 1
    multi_runtime = len({candidate.runtime_family for candidate in candidates}) > 1
    requires_review = bool(custom_dockerfiles or compose_files or multiple_packages or multi_runtime)
    if not candidates:
        status = "unsupported"
        reason = "No supported project manifest was detected. Add a supported stack recipe before deployment."
    elif requires_review:
        status = "review_required"
        reason = "The project contains custom container or multi-service configuration that needs explicit review."
    elif any(candidate.build_recipe_id is None or candidate.start_recipe_id is None for candidate in candidates):
        status = "configuration_required"
        reason = "A likely stack was found, but build or startup details need explicit configuration."
    else:
        status = "candidate"
        reason = "A stack recipe candidate was found. Execution still requires an isolated deployment provider."

    return DeploymentPlan(
        snapshot_id=snapshot_id,
        source_digest=source_digest,
        status=status,
        candidates=tuple(candidates),
        project_files=tuple(sorted(paths)[:5_000]),
        requires_review=requires_review,
        reason=reason,
    )


def validate_deployment_url(url: Optional[str], allowed_domain_suffixes: Tuple[str, ...]) -> Optional[str]:
    """Reject malformed or unexpected provider URLs before displaying them."""
    if url is None:
        return None
    parsed = urlsplit(url)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or not hostname or parsed.username or parsed.password:
        raise ValueError("Deployment provider returned a URL that is not a valid HTTPS endpoint.")
    if parsed.port not in (None, 443):
        raise ValueError("Deployment provider returned a non-standard HTTPS port.")
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", hostname) or hostname in {"localhost", "::1"}:
        raise ValueError("Deployment provider returned a local or IP-based endpoint.")
    suffixes = tuple(suffix.lower().lstrip(".").rstrip(".") for suffix in allowed_domain_suffixes if suffix.strip())
    if not any(hostname == suffix or hostname.endswith("." + suffix) for suffix in suffixes):
        raise ValueError("Deployment provider returned a host outside the configured domain allowlist.")
    return url
