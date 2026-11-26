"""Create, verify, and stage restore archives for a self-hosted CodeMind data volume.

Backups contain the SQLite database (including the local admin account and
session secret) plus every immutable source archive referenced by that DB.
Treat the resulting archive as a credential-bearing secret and copy it off-host.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Dict, Tuple

from . import store


MAX_BACKUP_BYTES = int(os.environ.get("CODEMIND_MAX_BACKUP_BYTES", 50 * 1024 * 1024 * 1024))
MAX_MEMBERS = 100_000
CHUNK_SIZE = 1024 * 1024


def _sha256_file(path: Path) -> Tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _copy_limited(source: BinaryIO, destination: BinaryIO, maximum: int, digest=None) -> int:
    actual = 0
    while True:
        chunk = source.read(CHUNK_SIZE)
        if not chunk:
            break
        actual += len(chunk)
        if actual > maximum:
            raise ValueError("Backup exceeds the configured size limit.")
        destination.write(chunk)
        if digest is not None:
            digest.update(chunk)
    return actual


def create_backup(destination: Path) -> Dict[str, object]:
    destination = destination.expanduser().absolute()
    data_root = store.DATA_DIR.resolve()
    if destination.exists():
        raise FileExistsError("Refusing to overwrite an existing backup: {}".format(destination))
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        destination.parent.resolve().relative_to(data_root)
    except ValueError:
        pass
    else:
        raise ValueError("Write backups outside the live CodeMind data directory.")
    if not store.DB_PATH.is_file():
        raise FileNotFoundError("CodeMind database does not exist yet.")

    with tempfile.TemporaryDirectory(prefix="codemind-backup-", dir=str(destination.parent)) as temporary:
        stage = Path(temporary)
        db_backup = stage / "codemind.sqlite3"
        source_db = sqlite3.connect(str(store.DB_PATH), timeout=30)
        target_db = sqlite3.connect(str(db_backup), timeout=30)
        try:
            source_db.backup(target_db, pages=256, sleep=0.1)
            check = target_db.execute("PRAGMA integrity_check").fetchone()
            if not check or check[0] != "ok":
                raise RuntimeError("The database backup failed its integrity check.")
            source_rows = target_db.execute("SELECT archive_path, digest FROM snapshots ORDER BY id").fetchall()
        finally:
            target_db.close()
            source_db.close()

        entries: Dict[str, Dict[str, object]] = {}
        db_hash, db_size = _sha256_file(db_backup)
        entries["codemind.sqlite3"] = {"sha256": db_hash, "bytes": db_size}
        total = db_size
        seen = set()
        for archive_value, expected_digest in source_rows:
            source = Path(archive_value)
            try:
                resolved = source.resolve(strict=True)
                relative = resolved.relative_to(data_root)
            except (OSError, ValueError) as error:
                raise ValueError("A referenced project snapshot is missing or outside the private data directory.") from error
            if not resolved.is_file() or source.is_symlink():
                raise ValueError("A referenced project snapshot is not a regular file.")
            member_name = relative.as_posix()
            if member_name in seen or not member_name.startswith("sources/"):
                raise ValueError("The database contains a duplicate or invalid source archive path.")
            seen.add(member_name)
            file_hash, file_size = _sha256_file(resolved)
            if file_hash != str(expected_digest).lower():
                raise ValueError("A stored project snapshot failed its database digest check.")
            total += file_size
            if total > MAX_BACKUP_BYTES:
                raise ValueError("Backup exceeds CODEMIND_MAX_BACKUP_BYTES.")
            staged = stage / member_name
            staged.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(resolved, staged)
            entries[member_name] = {"sha256": file_hash, "bytes": file_size}

        setup_token = store.DATA_DIR / "setup.token"
        if setup_token.is_file() and not setup_token.is_symlink():
            token_hash, token_size = _sha256_file(setup_token)
            shutil.copyfile(setup_token, stage / "setup.token")
            entries["setup.token"] = {"sha256": token_hash, "bytes": token_size}
            total += token_size
        if total > MAX_BACKUP_BYTES:
            raise ValueError("Backup exceeds CODEMIND_MAX_BACKUP_BYTES.")

        manifest = {
            "format_version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "database": "codemind.sqlite3",
            "files": entries,
        }
        manifest_text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        total += len(manifest_text.encode("utf-8"))
        if total > MAX_BACKUP_BYTES:
            raise ValueError("Backup exceeds CODEMIND_MAX_BACKUP_BYTES.")
        (stage / "manifest.json").write_text(manifest_text, encoding="utf-8")
        temporary_handle = tempfile.NamedTemporaryFile(
            prefix=destination.name + ".", suffix=".partial", dir=str(destination.parent), delete=False
        )
        temporary_output = Path(temporary_handle.name)
        temporary_handle.close()
        try:
            with tarfile.open(str(temporary_output), mode="w:gz") as archive:
                for name in sorted([*entries.keys(), "manifest.json"]):
                    item_path = stage / PurePosixPath(name)
                    info = archive.gettarinfo(str(item_path), arcname=name)
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mode = 0o600
                    with item_path.open("rb") as stream:
                        archive.addfile(info, stream)
            os.chmod(temporary_output, 0o600)
            with temporary_output.open("rb") as stream:
                os.fsync(stream.fileno())
            os.replace(temporary_output, destination)
        finally:
            try:
                temporary_output.unlink()
            except FileNotFoundError:
                pass
    return {"path": str(destination), "files": len(entries), "bytes": destination.stat().st_size}


def _safe_member(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (not name or "\\" in name or path.is_absolute() or
            any(part in ("", ".", "..") for part in path.parts)):
        raise ValueError("Backup contains an unsafe path.")
    return path


def _read_backup(archive_path: Path, extract_to: Path | None = None) -> Dict[str, object]:
    archive_path = archive_path.expanduser().resolve(strict=True)
    hashes: Dict[str, Dict[str, object]] = {}
    manifest_bytes = None
    total = 0
    names = set()
    db_temp = None
    try:
        with tempfile.NamedTemporaryFile(prefix="codemind-verify-db-", delete=False) as database_file:
            db_temp = Path(database_file.name)
        with tarfile.open(str(archive_path), mode="r:gz") as archive:
            members = archive.getmembers()
            if len(members) > MAX_MEMBERS:
                raise ValueError("Backup contains too many entries.")
            for member in members:
                relative = _safe_member(member.name)
                name = relative.as_posix()
                if name in names or not member.isfile():
                    raise ValueError("Backup contains duplicate paths or non-regular entries.")
                names.add(name)
                if name not in {"codemind.sqlite3", "manifest.json", "setup.token"} and not name.startswith("sources/"):
                    raise ValueError("Backup contains an unexpected file.")
                if name.startswith("sources/") and len(relative.parts) < 3:
                    raise ValueError("Backup contains an invalid source path.")
                if name == "manifest.json" and member.size > 4 * 1024 * 1024:
                    raise ValueError("Backup manifest is too large.")
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError("Backup contains an unreadable file.")
                digest = hashlib.sha256()
                actual = 0
                chunks = [] if name == "manifest.json" else None
                target = db_temp.open("wb") if name == "codemind.sqlite3" else None
                extracted = None
                if extract_to is not None:
                    extracted_path = extract_to / relative
                    extracted_path.parent.mkdir(parents=True, exist_ok=True)
                    extracted = extracted_path.open("wb")
                try:
                    while True:
                        chunk = source.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        actual += len(chunk)
                        total += len(chunk)
                        if total > MAX_BACKUP_BYTES or actual > member.size:
                            raise ValueError("Backup exceeds its size limit or has invalid entry metadata.")
                        digest.update(chunk)
                        if chunks is not None:
                            chunks.append(chunk)
                        if target is not None:
                            target.write(chunk)
                        if extracted is not None:
                            extracted.write(chunk)
                finally:
                    source.close()
                    if target is not None:
                        target.close()
                    if extracted is not None:
                        extracted.close()
                if actual != member.size:
                    raise ValueError("Backup entry size does not match its contents.")
                if chunks is not None:
                    manifest_bytes = b"".join(chunks)
                else:
                    hashes[name] = {"sha256": digest.hexdigest(), "bytes": actual}
        if manifest_bytes is None or "codemind.sqlite3" not in hashes:
            raise ValueError("Backup is missing its manifest or database.")
        manifest = json.loads(manifest_bytes.decode("utf-8"))
        if manifest.get("format_version") != 1 or manifest.get("database") != "codemind.sqlite3":
            raise ValueError("Backup format is not supported.")
        if manifest.get("files") != hashes:
            raise ValueError("Backup content does not match its manifest.")
        connection = sqlite3.connect(str(db_temp))
        try:
            check = connection.execute("PRAGMA integrity_check").fetchone()
            if not check or check[0] != "ok":
                raise ValueError("Backup database failed its integrity check.")
            snapshots = connection.execute("SELECT id, project_id, digest FROM snapshots").fetchall()
            referenced = set()
            for snapshot_id, project_id, expected_digest in snapshots:
                member_name = "sources/{}/{}.zip".format(project_id, snapshot_id)
                entry = hashes.get(member_name)
                if entry is None or entry["sha256"] != str(expected_digest).lower():
                    raise ValueError("Backup source archives do not match the snapshot records in its database.")
                referenced.add(member_name)
            actual_sources = {name for name in hashes if name.startswith("sources/")}
            if actual_sources != referenced:
                raise ValueError("Backup contains missing or unreferenced source archives.")
        finally:
            connection.close()
        return {"created_at": manifest.get("created_at"), "files": len(hashes), "bytes": total}
    except (tarfile.TarError, OSError, sqlite3.DatabaseError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("Backup could not be verified safely.") from error
    finally:
        if db_temp is not None:
            try:
                db_temp.unlink()
            except OSError:
                pass


def verify_backup(archive_path: Path) -> Dict[str, object]:
    return _read_backup(archive_path)


def restore_to_empty_directory(archive_path: Path, destination: Path) -> Dict[str, object]:
    destination = destination.expanduser().absolute()
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise FileExistsError("Restore destination must be a new or empty directory: {}".format(destination))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="codemind-restore-") as temporary:
        staging = Path(temporary) / "data"
        staging.mkdir(mode=0o700)
        summary = _read_backup(archive_path, staging)
        (staging / "manifest.json").unlink(missing_ok=True)
        connection = sqlite3.connect(str(staging / "codemind.sqlite3"))
        try:
            for snapshot_id, project_id in connection.execute("SELECT id, project_id FROM snapshots").fetchall():
                archive_path_in_data = destination / "sources" / project_id / (snapshot_id + ".zip")
                connection.execute(
                    "UPDATE snapshots SET archive_path = ? WHERE id = ?",
                    (str(archive_path_in_data), snapshot_id),
                )
            connection.commit()
        finally:
            connection.close()
        for path in staging.rglob("*"):
            try:
                os.chmod(path, 0o700 if path.is_dir() else 0o600)
            except OSError:
                pass
        if destination.exists():
            shutil.copytree(staging, destination, dirs_exist_ok=True)
        else:
            shutil.copytree(staging, destination)
    return {"path": str(destination), **summary}


def main() -> int:
    parser = argparse.ArgumentParser(description="Create and verify CodeMind self-hosted data backups.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create", help="Create a consistent database and snapshot backup.")
    create.add_argument("--output", required=True, type=Path)
    verify = subparsers.add_parser("verify", help="Verify file digests and SQLite integrity.")
    verify.add_argument("archive", type=Path)
    restore = subparsers.add_parser("restore", help="Restore to a new, empty staging directory.")
    restore.add_argument("archive", type=Path)
    restore.add_argument("--to", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = create_backup(args.output) if args.command == "create" else (
            verify_backup(args.archive) if args.command == "verify" else
            restore_to_empty_directory(args.archive, args.to)
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        print("CodeMind backup error: {}".format(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
