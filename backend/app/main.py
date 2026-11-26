from __future__ import annotations

import os
import re
import uuid
import logging
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, constr

from . import auth, qa, store
from .intake import archive_upload, digest, safe_path
from .tasks import analyze_snapshot, prepare_deployment


app = FastAPI(title="CodeMind AI API", version="0.1.0")
allowed_origins = [origin.strip() for origin in os.environ.get("CODEMIND_CORS_ORIGINS", "http://localhost:5173").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-CSRF-Token"],
)
logger = logging.getLogger("codemind")
MAX_SOURCE_PREVIEW_BYTES = min(max(int(os.environ.get("CODEMIND_MAX_SOURCE_PREVIEW_BYTES", 512 * 1024)), 1024), 5 * 1024 * 1024)
MAX_SOURCE_PREVIEW_LINES = 200
store.initialize()
setup_token_path = auth.initialize_auth()
if setup_token_path:
    logger.warning("Initial admin setup code is available in the protected file: %s", setup_token_path)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Credentials(BaseModel):
    username: str
    password: str


class InitialSetup(Credentials):
    setup_token: str


class ProjectQuestion(BaseModel):
    snapshot_id: str
    question: constr(min_length=1, max_length=1000)


def require_same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        raise HTTPException(status_code=403, detail="A same-origin browser request is required.")
    parsed = urlsplit(origin)
    host_header = request.headers.get("host", "").lower()
    configured_origins = {origin.strip().rstrip("/").lower() for origin in os.environ.get("CODEMIND_CORS_ORIGINS", "").split(",") if origin.strip()}
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc
            or (parsed.netloc.lower() != host_header and origin.rstrip("/").lower() not in configured_origins)):
        raise HTTPException(status_code=403, detail="Cross-origin requests are not allowed.")


def current_user(request: Request) -> auth.UserSession:
    return auth.read_session(request)


def mutation_user(request: Request) -> auth.UserSession:
    user = auth.read_session(request)
    auth.require_csrf(request, user)
    return user


@app.get("/api/auth/status")
def auth_status() -> Dict[str, bool]:
    return {"setup_required": auth.setup_required()}


@app.post("/api/auth/setup")
def auth_setup(body: InitialSetup, request: Request, response: Response) -> dict:
    require_same_origin(request)
    if not auth.setup_required():
        raise HTTPException(status_code=409, detail="Initial setup has already been completed.")
    user = auth.complete_first_run_setup(body.setup_token, body.username, body.password)
    csrf_token = auth.issue_session(response, user["id"])
    return {"username": user["username"], "csrf_token": csrf_token}


@app.post("/api/auth/login")
def auth_login(body: Credentials, request: Request, response: Response) -> dict:
    require_same_origin(request)
    remote_address = request.client.host if request.client else "unknown"
    user = auth.authenticate(body.username, body.password, remote_address)
    csrf_token = auth.issue_session(response, user["id"])
    return {"username": user["username"], "csrf_token": csrf_token}


@app.get("/api/auth/session")
def auth_session(user: auth.UserSession = Depends(current_user)) -> dict:
    return {"username": user.username, "csrf_token": user.csrf_token, "expires_at": user.expires_at}


@app.post("/api/auth/logout")
def auth_logout(response: Response, user: auth.UserSession = Depends(mutation_user)) -> dict[str, bool]:
    auth.clear_session(response)
    return {"logged_out": True}


@app.get("/api/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "service": "codemind-api"}


@app.get("/api/projects")
def projects(user: auth.UserSession = Depends(current_user)) -> List[dict]:
    return store.list_projects()


@app.get("/api/projects/{project_id}")
def project(project_id: str, user: auth.UserSession = Depends(current_user)) -> dict:
    value = store.get_project(project_id)
    if value is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return value


@app.get("/api/projects/{project_id}/source")
def project_source(
    project_id: str,
    path: str,
    snapshot_id: Optional[str] = None,
    start_line: int = 1,
    end_line: Optional[int] = None,
    user: auth.UserSession = Depends(current_user),
) -> dict:
    """Return a bounded text preview from an authorized immutable snapshot."""
    snapshot = store.get_project_snapshot(project_id, snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Project snapshot not found.")
    normalized = safe_path(path)
    archive_path = Path(snapshot["archive_path"]).resolve()
    data_root = store.DATA_DIR.resolve()
    try:
        if os.path.commonpath([str(data_root), str(archive_path)]) != str(data_root):
            raise HTTPException(status_code=404, detail="Project source is unavailable.")
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Project source is unavailable.") from error
    try:
        with zipfile.ZipFile(str(archive_path), "r") as archive:
            try:
                member = archive.getinfo(normalized)
            except KeyError as error:
                raise HTTPException(status_code=404, detail="Source file not found in this snapshot.") from error
            if member.is_dir():
                raise HTTPException(status_code=404, detail="Source file not found in this snapshot.")
            if member.file_size > MAX_SOURCE_PREVIEW_BYTES:
                raise HTTPException(status_code=413, detail="This file is too large for an in-browser source preview.")
            with archive.open(member, "r") as source:
                raw = source.read(MAX_SOURCE_PREVIEW_BYTES + 1)
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise HTTPException(status_code=404, detail="Project source is unavailable.") from error
    if len(raw) > MAX_SOURCE_PREVIEW_BYTES or b"\x00" in raw:
        raise HTTPException(status_code=413, detail="This file cannot be safely shown as text.")
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise HTTPException(status_code=415, detail="This file is not UTF-8 text and cannot be previewed.") from error

    lines = content.splitlines()
    total_lines = len(lines)
    if start_line < 1 or start_line > max(1, total_lines):
        raise HTTPException(status_code=400, detail="The requested starting line is outside this file.")
    requested_end = end_line if end_line is not None else start_line + MAX_SOURCE_PREVIEW_LINES - 1
    if requested_end < start_line:
        raise HTTPException(status_code=400, detail="The requested line range is invalid.")
    if requested_end - start_line + 1 > MAX_SOURCE_PREVIEW_LINES:
        raise HTTPException(status_code=413, detail="A source preview can show at most 200 lines.")
    bounded_end = min(requested_end, total_lines)
    return {
        "path": normalized,
        "snapshot_id": snapshot["id"],
        "digest": snapshot["digest"],
        "start_line": start_line,
        "end_line": bounded_end,
        "total_lines": total_lines,
        "lines": [{"number": number, "text": lines[number - 1]} for number in range(start_line, bounded_end + 1)],
    }


@app.get("/api/qa/status")
def qa_status(user: auth.UserSession = Depends(current_user)) -> dict:
    """Expose whether an explicitly configured local model is available."""
    return qa.model_status()


@app.post("/api/projects/{project_id}/ask")
def ask_project(
    project_id: str,
    body: ProjectQuestion,
    user: auth.UserSession = Depends(mutation_user),
) -> dict:
    """Answer a bounded question from one immutable, analyzed snapshot."""
    if len(body.question) > qa.MAX_QUESTION_CHARS:
        raise HTTPException(status_code=413, detail="Questions can contain at most 1000 characters.")
    if not body.snapshot_id or len(body.snapshot_id) > 100:
        raise HTTPException(status_code=400, detail="A valid snapshot identifier is required.")
    try:
        return qa.answer_project_question(project_id, body.snapshot_id, body.question)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except qa.QAUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except qa.QAModelError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise HTTPException(status_code=400, detail="The selected source snapshot could not be read safely.") from error


@app.get("/api/jobs/{job_id}")
def job(job_id: str, user: auth.UserSession = Depends(current_user)) -> dict:
    value = store.get_job(job_id)
    if value is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    value.pop("project_id", None)
    value.pop("snapshot_id", None)
    return value


@app.post("/api/projects")
async def create_project(
    archive: Optional[UploadFile] = File(default=None),
    files: List[UploadFile] = File(default=[]),
    paths: List[str] = Form(default=[]),
    project_name: str = Form(default=""),
    analyze: bool = Form(default=True),
    deploy: bool = Form(default=False),
    allow_outbound_network: bool = Form(default=False),
    user: auth.UserSession = Depends(mutation_user),
) -> dict:
    if not analyze and not deploy:
        raise HTTPException(status_code=400, detail="Select Explain project, Deploy project, or both.")
    raw_name = project_name.strip() or (Path(archive.filename).stem if archive and archive.filename else "New project")
    name = re.sub(r"[\x00-\x1f\x7f]", "", raw_name).strip()[:100] or "New project"

    data, file_count, total_size = await archive_upload(archive, files, paths)
    project_id, snapshot_id = str(uuid.uuid4()), str(uuid.uuid4())
    timestamp = now()
    archive_path = store.DATA_DIR / "sources" / project_id / f"{snapshot_id}.zip"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        archive_path.parent.chmod(0o700)
    except OSError:
        pass
    descriptor = os.open(str(archive_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as archive_file:
            archive_file.write(data)
            archive_file.flush()
            os.fsync(archive_file.fileno())
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise

    created_jobs: list[dict] = []
    if analyze:
        created_jobs.append({
            "id": str(uuid.uuid4()), "project_id": project_id, "snapshot_id": snapshot_id,
            "kind": "analysis", "status": "queued", "message": "Building a project file inventory.",
            "created_at": timestamp, "updated_at": timestamp,
        })
    if deploy:
        created_jobs.append({
            "id": str(uuid.uuid4()), "project_id": project_id, "snapshot_id": snapshot_id,
            "kind": "deployment", "status": "queued",
            "message": "Inspecting stack and build requirements. Uploaded source will not be executed.",
            "created_at": timestamp, "updated_at": timestamp,
        })

    project_record = {"id": project_id, "name": name, "created_at": timestamp}
    snapshot_record = {
        "id": snapshot_id, "project_id": project_id, "archive_path": str(archive_path),
        "digest": digest(data), "file_count": file_count, "total_bytes": total_size, "created_at": timestamp,
    }
    try:
        store.add_project(project_record, snapshot_record, created_jobs)
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise

    for item in created_jobs:
        try:
            if item["kind"] == "analysis":
                analyze_snapshot.delay(item["id"], str(archive_path))
            elif item["kind"] == "deployment":
                prepare_deployment.delay(item["id"], str(archive_path), snapshot_id, snapshot_record["digest"], allow_outbound_network if deploy else False)
        except Exception:
            store.update_job(item["id"], "failed", "The background queue is unavailable. Start Redis and the worker, then try again.")

    return {
        "project": project_record,
        "snapshot": {"id": snapshot_id, "digest": snapshot_record["digest"], "file_count": file_count, "total_bytes": total_size},
        "jobs": [{key: value for key, value in item.items() if key != "project_id" and key != "snapshot_id"} for item in created_jobs],
    }
