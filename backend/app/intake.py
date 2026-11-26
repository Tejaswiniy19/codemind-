from __future__ import annotations

import hashlib
import io
import os
import re
import stat
import zipfile
from pathlib import PurePosixPath
from typing import List, Optional, Tuple

from fastapi import HTTPException, UploadFile


MAX_ARCHIVE_BYTES = int(os.environ.get("CODEMIND_MAX_ARCHIVE_BYTES", 100 * 1024 * 1024))
MAX_EXPANDED_BYTES = int(os.environ.get("CODEMIND_MAX_EXPANDED_BYTES", 500 * 1024 * 1024))
MAX_FILES = int(os.environ.get("CODEMIND_MAX_FILES", 20_000))
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_PATH_DEPTH = 50


def safe_path(value: str) -> str:
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
    if (not normalized or normalized.startswith("/") or "\x00" in normalized
            or ":" in normalized or any(ord(char) < 32 for char in normalized)
            or any(char in '<>"|?*' for char in normalized)
            or len(normalized) > 1024
            or any(len(part) > 255 or part in (".", "..", "") for part in normalized.split("/"))
            or any(part.endswith((".", " ")) or part.split(".")[0].upper() in reserved for part in path.parts)
            or len(path.parts) > MAX_PATH_DEPTH):
        raise HTTPException(status_code=400, detail=f"Unsafe project path: {value[:120]}")
    return normalized


async def archive_upload(archive: Optional[UploadFile], files: List[UploadFile], paths: List[str]) -> Tuple[bytes, int, int]:
    if archive is not None and (files or paths):
        raise HTTPException(status_code=400, detail="Send a ZIP archive or a project folder, not both.")
    if archive is None and (not files or len(files) != len(paths)):
        raise HTTPException(status_code=400, detail="Select a ZIP archive or a non-empty project folder.")

    output = io.BytesIO()
    total_size = 0
    count = 0
    try:
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as target:
            if archive is not None:
                content = await archive.read(MAX_ARCHIVE_BYTES + 1)
                if len(content) > MAX_ARCHIVE_BYTES:
                    raise HTTPException(status_code=413, detail="The compressed project exceeds the upload limit.")
                if not zipfile.is_zipfile(io.BytesIO(content)):
                    raise HTTPException(status_code=400, detail="The selected file is not a valid ZIP archive.")
                try:
                    with zipfile.ZipFile(io.BytesIO(content)) as source:
                        if len(source.infolist()) > MAX_FILES * 2:
                            raise HTTPException(status_code=413, detail="The project archive contains too many entries.")
                        seen: set[str] = set()
                        for member in source.infolist():
                            path = safe_path(member.filename.rstrip("/") if member.is_dir() else member.filename)
                            normalized_key = path.casefold()
                            if normalized_key in seen:
                                raise HTTPException(status_code=400, detail=f"Duplicate project path: {path}")
                            seen.add(normalized_key)
                            if member.is_dir():
                                continue
                            mode = (member.external_attr >> 16) & 0xFFFF
                            if stat.S_ISLNK(mode):
                                raise HTTPException(status_code=400, detail=f"Symbolic links are not accepted: {path}")
                            if member.flag_bits & 0x1:
                                raise HTTPException(status_code=400, detail=f"Encrypted files are not supported: {path}")
                            if member.file_size > MAX_FILE_BYTES:
                                raise HTTPException(status_code=413, detail=f"A project file exceeds the per-file limit: {path}")
                            total_size += member.file_size
                            count += 1
                            if count > MAX_FILES or total_size > MAX_EXPANDED_BYTES:
                                raise HTTPException(status_code=413, detail="The expanded project exceeds the configured limits.")
                            if member.file_size and member.compress_size == 0:
                                raise HTTPException(status_code=400, detail=f"Invalid compressed size for: {path}")
                            if member.compress_size and member.file_size / member.compress_size > 1_000:
                                raise HTTPException(status_code=413, detail=f"Suspicious compression ratio for: {path}")
                            with source.open(member) as stream:
                                data = stream.read(member.file_size + 1)
                            if len(data) != member.file_size:
                                raise HTTPException(status_code=400, detail=f"Could not verify project file: {path}")
                            target.writestr(path, data)
                except zipfile.BadZipFile as exc:
                    raise HTTPException(status_code=400, detail="The ZIP archive is damaged or could not be read.") from exc
            else:
                seen: set[str] = set()
                for upload, raw_path in zip(files, paths):
                    path = safe_path(raw_path)
                    if path in seen:
                        raise HTTPException(status_code=400, detail=f"Duplicate project path: {path}")
                    seen.add(path)
                    data = await upload.read(MAX_FILE_BYTES + 1)
                    if len(data) > MAX_FILE_BYTES:
                        raise HTTPException(status_code=413, detail=f"A project file exceeds the per-file limit: {path}")
                    total_size += len(data)
                    count += 1
                    if count > MAX_FILES or total_size > MAX_EXPANDED_BYTES:
                        raise HTTPException(status_code=413, detail="The project folder exceeds the configured limits.")
                    target.writestr(path, data)
    except (OSError, RuntimeError, zipfile.LargeZipFile) as exc:
        raise HTTPException(status_code=400, detail="The project archive could not be safely processed.") from exc

    result = output.getvalue()
    if len(result) > MAX_ARCHIVE_BYTES:
        raise HTTPException(status_code=413, detail="The stored project archive exceeds the configured limit.")
    if count == 0:
        raise HTTPException(status_code=400, detail="The project contains no files.")
    return result, count, total_size


def inspect_archive(archive_path: str) -> dict[str, object]:
    extensions: dict[str, int] = {}
    manifests: list[str] = []
    files: list[dict[str, str]] = []
    key_files: list[dict[str, str]] = []
    file_count = 0
    try:
        with zipfile.ZipFile(archive_path) as source:
            for member in source.infolist():
                if member.is_dir():
                    continue
                path = safe_path(member.filename)
                file_count += 1
                basename = PurePosixPath(path).name.lower()
                extension = PurePosixPath(path).suffix.lower() or "[no extension]"
                extensions[extension] = extensions.get(extension, 0) + 1
                if basename in {"dockerfile", "docker-compose.yml", "compose.yml", "makefile", "justfile"}:
                    role = "Build or runtime setup"
                elif basename in {"package.json", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle", "go.mod", "cargo.toml", "composer.json"}:
                    manifests.append(path)
                    role = "Build or dependency manifest"
                elif basename in {"readme", "readme.md", "readme.rst", "readme.txt"}:
                    role = "Project documentation"
                elif basename in {"main.py", "app.py", "manage.py", "server.py", "main.ts", "main.tsx", "main.js", "main.jsx", "index.ts", "index.tsx", "index.js", "index.jsx", "server.ts", "server.js", "application.java"}:
                    role = "Likely application entry point"
                elif basename in {"index.html", "wsgi.py", "asgi.py", "main.go", "lib.rs", "index.php", "program.cs", "bootstrap.java"}:
                    role = "Likely application entry point"
                elif basename in {".env.example", ".env.sample", "config.py", "settings.py", "application.yml", "application.yaml", "vite.config.ts", "webpack.config.js"}:
                    role = "Configuration"
                elif any(part in {"routes", "routers", "controllers", "handlers", "api"} for part in PurePosixPath(path).parts[:-1]):
                    role = "Likely API route or handler"
                elif any(part in {"services", "service"} for part in PurePosixPath(path).parts[:-1]):
                    role = "Likely service or business logic"
                elif any(part in {"models", "model", "entities", "schemas"} for part in PurePosixPath(path).parts[:-1]):
                    role = "Likely data model or schema"
                elif any(part in {"components", "pages", "views"} for part in PurePosixPath(path).parts[:-1]):
                    role = "Likely UI component or page"
                elif any(part in {"tests", "test", "__tests__"} for part in PurePosixPath(path).parts[:-1]) or basename.startswith("test_") or ".test." in basename or ".spec." in basename:
                    role = "Test file"
                elif "migrations" in PurePosixPath(path).parts[:-1]:
                    role = "Database migration"
                else:
                    role = "Source file" if extension in {".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".go", ".rs", ".c", ".cc", ".cpp", ".cs", ".php"} else "Project file"
                if role not in {"Source file", "Project file"} and len(key_files) < 200:
                    key_files.append({"path": path, "role": role})
                if len(files) < 5_000:
                    files.append({"path": path, "extension": extension})
    except (OSError, zipfile.BadZipFile) as exc:
        raise RuntimeError("Stored source snapshot failed integrity checks") from exc
    return {"file_count": file_count, "extensions": extensions, "manifests": manifests, "key_files": key_files, "files": files}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
