from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional
from contextlib import contextmanager


DATA_DIR = Path(os.environ.get("CODEMIND_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
DB_PATH = DATA_DIR / "codemind.sqlite3"


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        DATA_DIR.chmod(0o700)
    except OSError:
        # Windows ACLs and mounted volumes control access when POSIX modes
        # are unavailable; the deployment guide still requires private storage.
        pass
    connection = sqlite3.connect(DB_PATH, timeout=15)
    try:
        DB_PATH.chmod(0o600)
    except OSError:
        pass
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


@contextmanager
def session():
    connection = connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize() -> None:
    with session() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                archive_path TEXT NOT NULL,
                digest TEXT NOT NULL,
                file_count INTEGER NOT NULL,
                total_bytes INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK(kind IN ('analysis', 'deployment')),
                status TEXT NOT NULL,
                message TEXT NOT NULL,
                result_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS jobs_snapshot_idx ON jobs(snapshot_id, created_at);
            CREATE INDEX IF NOT EXISTS snapshots_project_idx ON snapshots(project_id, created_at);
            """
        )


def add_project(project: Dict[str, Any], snapshot: Dict[str, Any], jobs: List[Dict[str, Any]]) -> None:
    with session() as db:
        db.execute(
            "INSERT INTO projects(id, name, created_at) VALUES (?, ?, ?)",
            (project["id"], project["name"], project["created_at"]),
        )
        db.execute(
            "INSERT INTO snapshots(id, project_id, archive_path, digest, file_count, total_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (snapshot["id"], snapshot["project_id"], snapshot["archive_path"], snapshot["digest"], snapshot["file_count"], snapshot["total_bytes"], snapshot["created_at"]),
        )
        db.executemany(
            "INSERT INTO jobs(id, project_id, snapshot_id, kind, status, message, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(j["id"], j["project_id"], j["snapshot_id"], j["kind"], j["status"], j["message"], None, j["created_at"], j["updated_at"]) for j in jobs],
        )


def list_projects() -> List[Dict[str, Any]]:
    with session() as db:
        rows = db.execute(
            """SELECT p.id, p.name, p.created_at, s.id AS snapshot_id, s.digest, s.file_count,
                      s.total_bytes, s.created_at AS snapshot_created_at,
                      (SELECT COUNT(*) FROM jobs j WHERE j.snapshot_id = s.id AND j.kind = 'analysis') AS analysis_jobs,
                      (SELECT COUNT(*) FROM jobs j WHERE j.snapshot_id = s.id AND j.kind = 'deployment') AS deployment_jobs
               FROM projects p JOIN snapshots s ON s.project_id = p.id
               WHERE s.created_at = (SELECT MAX(s2.created_at) FROM snapshots s2 WHERE s2.project_id = p.id)
               ORDER BY p.created_at DESC"""
        ).fetchall()
        return [dict(row) for row in rows]


def get_project(project_id: str) -> Optional[Dict[str, Any]]:
    with session() as db:
        project = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not project:
            return None
        snapshots = db.execute(
            "SELECT id, digest, file_count, total_bytes, created_at FROM snapshots WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
        snapshot_rows = []
        for snapshot in snapshots:
            row = dict(snapshot)
            row["jobs"] = [dict(job) for job in db.execute(
                "SELECT id, kind, status, message, result_json, created_at, updated_at FROM jobs WHERE snapshot_id = ? ORDER BY created_at",
                (row["id"],),
            ).fetchall()]
            for job in row["jobs"]:
                job["result"] = json.loads(job.pop("result_json")) if job.get("result_json") else None
            snapshot_rows.append(row)
        return {**dict(project), "snapshots": snapshot_rows}


def get_project_snapshot(project_id: str, snapshot_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Return one snapshot owned by a project, defaulting to its newest snapshot."""
    with session() as db:
        if snapshot_id:
            row = db.execute(
                "SELECT * FROM snapshots WHERE project_id = ? AND id = ?",
                (project_id, snapshot_id),
            ).fetchone()
        else:
            row = db.execute(
                "SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
                (project_id,),
            ).fetchone()
        return dict(row) if row else None


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    with session() as db:
        row = db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["result"] = json.loads(result.pop("result_json")) if result.get("result_json") else None
        return result


def get_snapshot_analysis(snapshot_id: str) -> Optional[Dict[str, Any]]:
    """Return the latest completed analysis for one immutable snapshot."""
    with session() as db:
        row = db.execute(
            "SELECT id, status, result_json FROM jobs WHERE snapshot_id = ? AND kind = 'analysis' ORDER BY created_at DESC LIMIT 1",
            (snapshot_id,),
        ).fetchone()
        if not row:
            return None
        result = dict(row)
        result["result"] = json.loads(result.pop("result_json")) if result.get("result_json") else None
        return result


def update_job(job_id: str, status: str, message: str, result: Optional[Dict[str, Any]] = None) -> None:
    from datetime import datetime, timezone

    with session() as db:
        db.execute(
            "UPDATE jobs SET status = ?, message = ?, result_json = ?, updated_at = ? WHERE id = ?",
            (status, message, json.dumps(result) if result is not None else None, datetime.now(timezone.utc).isoformat(), job_id),
        )
