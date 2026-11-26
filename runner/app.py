"""Authenticated runner control API; uploaded code is never executed here.

Execution is delegated to an explicitly installed SandboxBackend plugin. The
service refuses to start without one, so a missing/unsafe runtime cannot be
mistaken for a working deployment system.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib
import json
import logging
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, Optional, Protocol
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse


MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_REQUEST_BYTES = (MAX_ARCHIVE_BYTES * 4 // 3) + 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 1_048_576
MAX_PLAN_BYTES = 512 * 1024
MAX_LOG_CHARS = 32_000
MAX_MESSAGE_CHARS = 2_000
POLL_SECONDS = 5
MAX_POLL_BACKOFF_SECONDS = 60
DISPATCH_LEASE_SECONDS = 90
TERMINAL = {"succeeded", "failed", "cancelled"}
STATUSES = {"queued", "building", "starting", "succeeded", "failed", "cancelled"}
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
DIGEST_PATTERN = re.compile(r"^[A-Fa-f0-9]{64}$")

DATA_DIR = Path(os.environ.get("CODEMIND_RUNNER_DATA_DIR", "/data"))
ARCHIVE_DIR = DATA_DIR / "archives"
DB_PATH = DATA_DIR / "runner.sqlite3"
logger = logging.getLogger("codemind.runner")
app = FastAPI(title="CodeMind Isolated Runner Control API", version="1.0.0")
_backend: Optional["SandboxBackend"] = None
_worker_stop = threading.Event()
_worker_thread: Optional[threading.Thread] = None


class RequestSizeLimitMiddleware:
    """Limit the full ASGI request body even when Content-Length is absent."""

    def __init__(self, application, max_bytes: int) -> None:
        self.application = application
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http" or scope.get("path") != "/v1/deployments":
            await self.application(scope, receive, send)
            return
        raw_length = dict(scope.get("headers", [])).get(b"content-length", b"")
        if raw_length:
            try:
                if int(raw_length) > self.max_bytes:
                    response = JSONResponse({"detail": "Runner request exceeds the configured size limit."}, status_code=413)
                    await response(scope, receive, send)
                    return
            except ValueError:
                response = JSONResponse({"detail": "Invalid request length."}, status_code=400)
                await response(scope, receive, send)
                return
        seen = 0

        async def bounded_receive():
            nonlocal seen
            message = await receive()
            if message.get("type") == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise _RequestTooLarge()
            return message

        try:
            await self.application(scope, bounded_receive, send)
        except _RequestTooLarge:
            response = JSONResponse({"detail": "Runner request exceeds the configured size limit."}, status_code=413)
            await response(scope, receive, send)


class _RequestTooLarge(Exception):
    pass


app.add_middleware(RequestSizeLimitMiddleware, max_bytes=MAX_REQUEST_BYTES)


class SandboxBackend(Protocol):
    """Adapter to the isolated VM/sandbox service on the dedicated runner VM.

    The plugin must submit jobs to a disposable microVM or equivalent strong
    sandbox. It must not evaluate source in this API process. See README.md.
    """

    def submit(self, job: "SandboxJob") -> Dict[str, Any]: ...

    def status(self, provider_id: str) -> Dict[str, Any]: ...


class SandboxJob:
    def __init__(self, row: Dict[str, Any]) -> None:
        self.deployment_id = row["id"]
        self.snapshot_id = row["snapshot_id"]
        self.source_digest = row["source_digest"]
        self.archive_path = row["archive_path"]
        self.plan = json.loads(row["plan_json"])
        self.limits = json.loads(row["limits_json"])


@contextmanager
def database() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _chmod(DATA_DIR, 0o700)
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA foreign_keys = ON")
    _chmod(DB_PATH, 0o600)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _chmod(path: Path, mode: int) -> None:
    try:
        path.chmod(mode)
    except OSError:
        # On Windows the directory ACL is the access-control boundary.
        pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _initialize() -> None:
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    _chmod(ARCHIVE_DIR, 0o700)
    with database() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS deployments (
                id TEXT PRIMARY KEY,
                idempotency_key TEXT NOT NULL UNIQUE,
                snapshot_id TEXT NOT NULL,
                source_digest TEXT NOT NULL,
                archive_path TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                limits_json TEXT NOT NULL,
                provider_id TEXT,
                status TEXT NOT NULL,
                message TEXT NOT NULL,
                url TEXT,
                logs TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS deployments_status_idx
                ON deployments(status, created_at);
            """
        )
        columns = {row[1] for row in db.execute("PRAGMA table_info(deployments)")}
        migrations = {
            "submission_failures": "INTEGER NOT NULL DEFAULT 0",
            "next_submit_at": "TEXT",
            "submission_lease_until": "TEXT",
            "status_failures": "INTEGER NOT NULL DEFAULT 0",
            "next_status_poll_at": "TEXT",
        }
        for name, declaration in migrations.items():
            if name not in columns:
                db.execute(f"ALTER TABLE deployments ADD COLUMN {name} {declaration}")


def _load_backend() -> "SandboxBackend":
    target = os.environ.get("CODEMIND_SANDBOX_BACKEND", "").strip()
    if not target or ":" not in target:
        raise RuntimeError(
            "CODEMIND_SANDBOX_BACKEND must name an installed module:Class implementing the isolated VM backend."
        )
    module_name, class_name = target.split(":", 1)
    backend_class = getattr(importlib.import_module(module_name), class_name)
    instance = backend_class()
    if not callable(getattr(instance, "submit", None)) or not callable(getattr(instance, "status", None)):
        raise RuntimeError("Configured sandbox backend must implement submit(job) and status(provider_id).")
    return instance


@app.on_event("startup")
def startup() -> None:
    token = os.environ.get("CODEMIND_RUNNER_TOKEN", "")
    if len(token) < 32 or "\r" in token or "\n" in token:
        raise RuntimeError("CODEMIND_RUNNER_TOKEN must be a random value with at least 32 characters.")
    global _backend, _worker_thread
    _initialize()
    _backend = _load_backend()
    _worker_stop.clear()
    _worker_thread = threading.Thread(target=_worker_loop, name="sandbox-dispatch", daemon=True)
    _worker_thread.start()


@app.on_event("shutdown")
def shutdown() -> None:
    _worker_stop.set()
    if _worker_thread is not None:
        _worker_thread.join(timeout=3)


def _authorize(authorization: Optional[str]) -> None:
    token = os.environ.get("CODEMIND_RUNNER_TOKEN", "")
    supplied = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
    if not token or not hmac.compare_digest(supplied, token):
        raise HTTPException(status_code=401, detail="Invalid runner credentials.")


@app.get("/v1/health")
def health() -> Dict[str, str]:
    if _backend is None:
        raise HTTPException(status_code=503, detail="Isolated sandbox backend is not configured.")
    return {"status": "ok", "service": "codemind-runner"}


@app.post("/v1/deployments")
async def create_deployment(request: Request, authorization: Optional[str] = Header(default=None)) -> Dict[str, str]:
    _authorize(authorization)
    try:
        payload = await request.json()
    except Exception as error:
        raise HTTPException(status_code=400, detail="Request must contain valid JSON.") from error
    if not isinstance(payload, dict) or payload.get("protocol_version") != 1:
        raise HTTPException(status_code=400, detail="Unsupported runner protocol version.")

    snapshot_id = payload.get("snapshot_id")
    digest = payload.get("source_digest")
    key = request.headers.get("idempotency-key", "")
    expected_key = hashlib.sha256((str(snapshot_id) + ":" + str(digest).lower()).encode("utf-8")).hexdigest()
    if not isinstance(snapshot_id, str) or not ID_PATTERN.fullmatch(snapshot_id):
        raise HTTPException(status_code=400, detail="Malformed snapshot identifier.")
    if not isinstance(digest, str) or not DIGEST_PATTERN.fullmatch(digest):
        raise HTTPException(status_code=400, detail="Malformed source digest.")
    if not hmac.compare_digest(key, expected_key):
        raise HTTPException(status_code=400, detail="Idempotency key does not match this snapshot and digest.")

    plan = payload.get("plan")
    limits = payload.get("limits")
    encoded = payload.get("archive_base64")
    if not isinstance(plan, dict) or plan.get("status") != "candidate" or plan.get("requires_review"):
        raise HTTPException(status_code=422, detail="Only reviewed deployment candidates can be submitted.")
    candidates = plan.get("candidates")
    if not isinstance(candidates, list) or not candidates or len(candidates) > 8:
        raise HTTPException(status_code=422, detail="Deployment plan has no supported candidate.")
    if len(json.dumps(plan, separators=(",", ":")).encode("utf-8")) > MAX_PLAN_BYTES:
        raise HTTPException(status_code=413, detail="Deployment plan exceeds the size limit.")
    if not isinstance(limits, dict):
        raise HTTPException(status_code=400, detail="Runtime limits are required.")
    _validate_limits(limits)
    if not isinstance(encoded, str) or len(encoded) > ((MAX_ARCHIVE_BYTES + 2) // 3) * 4:
        raise HTTPException(status_code=413, detail="Encoded project archive exceeds the size limit.")
    try:
        archive = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise HTTPException(status_code=400, detail="Project archive is not valid base64.") from error
    if len(archive) > MAX_ARCHIVE_BYTES:
        raise HTTPException(status_code=413, detail="Project archive exceeds the size limit.")
    if not hmac.compare_digest(hashlib.sha256(archive).hexdigest(), digest.lower()):
        raise HTTPException(status_code=400, detail="Project archive digest verification failed.")

    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM deployments WHERE idempotency_key=?", (key,)).fetchone()
        if existing:
            if existing["snapshot_id"] != snapshot_id or existing["source_digest"] != digest.lower():
                raise HTTPException(status_code=409, detail="Idempotency key collision.")
            return _public(existing)

        deployment_id = uuid.uuid4().hex
        archive_path = ARCHIVE_DIR / (deployment_id + ".zip")
        fd = os.open(str(archive_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(archive)
                stream.flush()
                os.fsync(stream.fileno())
        except Exception:
            archive_path.unlink(missing_ok=True)
            raise
        now = _now()
        db.execute(
            """INSERT INTO deployments(id,idempotency_key,snapshot_id,source_digest,archive_path,
               plan_json,limits_json,status,message,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (deployment_id, key, snapshot_id, digest.lower(), str(archive_path),
             json.dumps(plan, separators=(",", ":")), json.dumps(limits, separators=(",", ":")),
             "queued", "Deployment request accepted; waiting for the isolated sandbox.", now, now),
        )
        row = db.execute("SELECT * FROM deployments WHERE id=?", (deployment_id,)).fetchone()
        return _public(row)


@app.get("/v1/deployments/{deployment_id}")
def get_deployment(deployment_id: str, authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    _authorize(authorization)
    if not ID_PATTERN.fullmatch(deployment_id):
        raise HTTPException(status_code=404, detail="Deployment not found.")
    with database() as db:
        row = db.execute("SELECT * FROM deployments WHERE id=?", (deployment_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Deployment not found.")
    return _public(row, include_id=True)


def _public(row: sqlite3.Row, include_id: bool = True) -> Dict[str, Any]:
    result = {
        "deployment_id": row["id"] if include_id else None,
        "status": row["status"],
        "message": row["message"][:MAX_MESSAGE_CHARS],
    }
    if row["url"]:
        result["url"] = row["url"]
    if row["logs"]:
        result["logs"] = row["logs"][:MAX_LOG_CHARS]
    if not include_id:
        result.pop("deployment_id", None)
    return result


def _validate_limits(limits: Dict[str, Any]) -> None:
    checks = {
        "cpu_millicores": (100, 8_000),
        "memory_mb": (128, 32_768),
        "disk_mb": (128, 131_072),
        "timeout_seconds": (10, 7_200),
        "max_processes": (8, 4_096),
    }
    for key, (minimum, maximum) in checks.items():
        value = limits.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            raise HTTPException(status_code=400, detail="Invalid runtime limits.")
    if not isinstance(limits.get("allow_outbound_network"), bool):
        raise HTTPException(status_code=400, detail="Invalid runtime limits.")


def _worker_loop() -> None:
    while not _worker_stop.is_set():
        try:
            _dispatch_one()
        except Exception as error:
            # Don't log raw backend exception text: it could contain source or credentials.
            logger.error("Sandbox dispatch failed (%s).", type(error).__name__)
        _worker_stop.wait(POLL_SECONDS)


def _dispatch_one() -> None:
    if _backend is None:
        return
    now = datetime.now(timezone.utc)
    now_text = now.isoformat()
    with database() as db:
        # The backend submission is idempotent on deployment_id. A durable,
        # expiring lease lets another process recover after a crash while
        # preventing two runner replicas from submitting the same row at once.
        db.execute("BEGIN IMMEDIATE")
        queued = db.execute(
            """SELECT * FROM deployments
               WHERE status IN ('queued','building') AND provider_id IS NULL
                 AND (next_submit_at IS NULL OR next_submit_at <= ?)
                 AND (submission_lease_until IS NULL OR submission_lease_until <= ?)
               ORDER BY created_at LIMIT 1""",
            (now_text, now_text),
        ).fetchone()
        if queued is not None:
            lease_until = (now + timedelta(seconds=DISPATCH_LEASE_SECONDS)).isoformat()
            claimed = db.execute(
                """UPDATE deployments SET status='building',
                   message='Submitting to the isolated sandbox.',
                   submission_lease_until=?,updated_at=?
                   WHERE id=? AND provider_id IS NULL
                     AND (submission_lease_until IS NULL OR submission_lease_until <= ?)""",
                (lease_until, now_text, queued["id"], now_text),
            ).rowcount
            if claimed:
                queued = db.execute("SELECT * FROM deployments WHERE id=?", (queued["id"],)).fetchone()
            else:
                queued = None
        active_jobs = db.execute(
            """SELECT * FROM deployments
               WHERE status IN ('queued','building','starting') AND provider_id IS NOT NULL
                 AND (next_status_poll_at IS NULL OR next_status_poll_at <= ?)
               ORDER BY updated_at LIMIT 100""",
            (now_text,),
        ).fetchall()
    if queued is not None:
        job = SandboxJob(dict(queued))
        try:
            result = _backend.submit(job)
            _apply_backend_result(job.deployment_id, result)
        except Exception as error:
            logger.error("Sandbox submit failed (%s).", type(error).__name__)
            _schedule_submission_retry(job.deployment_id)
    for active in active_jobs:
        try:
            result = _backend.status(active["provider_id"])
            _apply_backend_result(active["id"], result)
        except Exception as error:
            logger.error("Sandbox status check failed (%s).", type(error).__name__)
            _schedule_status_retry(active["id"])


def _retry_delay(failures: int) -> int:
    exponent = min(max(0, failures - 1), 8)
    return min(POLL_SECONDS * (2 ** exponent), MAX_POLL_BACKOFF_SECONDS)


def _schedule_submission_retry(deployment_id: str) -> None:
    now = datetime.now(timezone.utc)
    with database() as db:
        row = db.execute(
            "SELECT submission_failures FROM deployments WHERE id=? AND provider_id IS NULL",
            (deployment_id,),
        ).fetchone()
        if row is None:
            return
        failures = int(row["submission_failures"] or 0) + 1
        retry_at = (now + timedelta(seconds=_retry_delay(failures))).isoformat()
        db.execute(
            """UPDATE deployments SET status='queued',submission_failures=?,
               next_submit_at=?,submission_lease_until=NULL,
               message=?,updated_at=? WHERE id=? AND provider_id IS NULL""",
            (failures, retry_at,
             f"Sandbox submission is temporarily unavailable; retry {failures} is scheduled.",
             now.isoformat(), deployment_id),
        )


def _schedule_status_retry(deployment_id: str) -> None:
    now = datetime.now(timezone.utc)
    with database() as db:
        row = db.execute(
            "SELECT status,status_failures FROM deployments WHERE id=?",
            (deployment_id,),
        ).fetchone()
        if row is None or row["status"] in TERMINAL:
            return
        failures = int(row["status_failures"] or 0) + 1
        retry_at = (now + timedelta(seconds=_retry_delay(failures))).isoformat()
        db.execute(
            """UPDATE deployments SET status_failures=?,next_status_poll_at=?,
               message=?,updated_at=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')""",
            (failures, retry_at,
             f"Sandbox status is temporarily unavailable; retrying with backoff (attempt {failures}).",
             now.isoformat(), deployment_id),
        )


def _set_status(deployment_id: str, status: str, message: str) -> None:
    if status not in STATUSES:
        raise ValueError("Unsupported deployment status")
    with database() as db:
        db.execute(
            "UPDATE deployments SET status=?,message=?,updated_at=? WHERE id=?",
            (status, _redact(message)[:MAX_MESSAGE_CHARS], _now(), deployment_id),
        )


def _apply_backend_result(deployment_id: str, result: Dict[str, Any]) -> None:
    if not isinstance(result, dict):
        raise ValueError("Invalid sandbox result")
    status = result.get("status")
    provider_id = result.get("provider_id")
    message = result.get("message", "")
    logs = result.get("logs", "")
    url = result.get("url")
    if status not in STATUSES or not isinstance(message, str) or not isinstance(logs, str):
        raise ValueError("Invalid sandbox result fields")
    if status in {"queued", "building", "starting", "succeeded"} and (not isinstance(provider_id, str) or not ID_PATTERN.fullmatch(provider_id)):
        raise ValueError("Missing sandbox provider ID")
    message = _redact(message)[:MAX_MESSAGE_CHARS]
    logs = _redact(logs)[:MAX_LOG_CHARS]
    if status == "succeeded":
        url = _validate_deployment_url(url)
    elif url is not None:
        url = _validate_deployment_url(url)
    with database() as db:
        db.execute(
            """UPDATE deployments SET provider_id=?,status=?,message=?,url=?,logs=?,
               submission_lease_until=NULL,next_submit_at=NULL,submission_failures=0,
               next_status_poll_at=NULL,status_failures=0,updated_at=? WHERE id=?""",
            (provider_id, status, message, url, logs or None, _now(), deployment_id),
        )


def _redact(value: str) -> str:
    token = os.environ.get("CODEMIND_RUNNER_TOKEN", "")
    return value.replace(token, "[redacted]") if token else value


def _validate_deployment_url(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Sandbox success requires a URL")
    parsed = urlsplit(value)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or not hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Invalid deployment URL")
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", hostname) or hostname in {"localhost", "::1"}:
        raise ValueError("Invalid deployment URL")
    allowed = tuple(x.strip().lower().lstrip(".").rstrip(".") for x in os.environ.get("CODEMIND_DEPLOYMENT_DOMAINS", "").split(",") if x.strip())
    if not any(hostname == suffix or hostname.endswith("." + suffix) for suffix in allowed):
        raise ValueError("Deployment URL is outside the configured domain allowlist")
    return value
