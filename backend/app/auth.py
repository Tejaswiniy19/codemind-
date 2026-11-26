"""Single-admin authentication primitives for the self-hosted CodeMind API.

This module intentionally does not install middleware or add routes. See
backend/docs/auth-integration.md for the endpoint and startup contract.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response

from . import store


COOKIE_NAME = "codemind_session"
SESSION_TTL_SECONDS = 12 * 60 * 60
PASSWORD_ITERATIONS = 600_000
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_FAILURES = 5
SETUP_TOKEN_FILE = store.DATA_DIR / "setup.token"
USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_.-]{3,64}$")
PASSWORD_MIN_LENGTH = 12


@dataclass(frozen=True)
class UserSession:
    user_id: str
    username: str
    csrf_token: str
    issued_at: int
    expires_at: int


def initialize_auth() -> Optional[Path]:
    """Create auth tables/keys and return the one-time setup-code path if needed.

    The caller should invoke this at application startup. The setup code is
    written once with restrictive permissions and is not returned by any API
    status helper. On Compose, read it from inside the API container:
    `docker compose exec api cat /data/setup.token`.
    """
    setup_created = False
    with store.session() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS auth_users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_salt BLOB NOT NULL,
                password_hash BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                disabled INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS auth_meta (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS auth_login_limits (
                key TEXT PRIMARY KEY,
                window_start INTEGER NOT NULL,
                failures INTEGER NOT NULL
            );
            """
        )
        db.execute("BEGIN IMMEDIATE")
        if os.environ.get("CODEMIND_SESSION_SECRET"):
            key = os.environ["CODEMIND_SESSION_SECRET"].encode("utf-8")
            if len(key) < 32:
                raise RuntimeError("CODEMIND_SESSION_SECRET must be at least 32 bytes.")
            db.execute("INSERT OR REPLACE INTO auth_meta(key, value) VALUES('session_secret', ?)", (key,))
        else:
            row = db.execute("SELECT value FROM auth_meta WHERE key = 'session_secret'").fetchone()
            if row is None:
                db.execute(
                    "INSERT INTO auth_meta(key, value) VALUES('session_secret', ?)",
                    (secrets.token_bytes(48),),
                )
        users = db.execute("SELECT COUNT(*) AS count FROM auth_users").fetchone()["count"]
        bootstrap = db.execute("SELECT value FROM auth_meta WHERE key = 'bootstrap_token_hash'").fetchone()
        if not users:
            current_token = ""
            if SETUP_TOKEN_FILE.exists():
                try:
                    current_token = SETUP_TOKEN_FILE.read_text(encoding="utf-8").strip()
                except OSError:
                    current_token = ""
            if bootstrap is None or not current_token or not hmac.compare_digest(
                bytes(bootstrap["value"]) if bootstrap is not None else b"",
                hashlib.sha256(current_token.encode("utf-8")).digest(),
            ):
                token = secrets.token_urlsafe(32)
                SETUP_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
                flags = os.O_CREAT | os.O_TRUNC | os.O_WRONLY
                fd = os.open(str(SETUP_TOKEN_FILE), flags, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    stream.write(token + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.chmod(SETUP_TOKEN_FILE, 0o600)
                except OSError:
                    # Windows ACLs govern access there; keep startup portable.
                    pass
                db.execute(
                    "INSERT OR REPLACE INTO auth_meta(key, value) VALUES('bootstrap_token_hash', ?)",
                    (hashlib.sha256(token.encode("utf-8")).digest(),),
                )
                setup_created = True

    return SETUP_TOKEN_FILE if setup_created or (not users and SETUP_TOKEN_FILE.exists()) else None


def setup_required() -> bool:
    with store.session() as db:
        count = db.execute("SELECT COUNT(*) AS count FROM auth_users").fetchone()["count"]
        return count == 0


def complete_first_run_setup(setup_token: str, username: str, password: str) -> dict[str, str]:
    """Create the sole local admin account and consume the setup token."""
    normalized = username.strip().lower()
    if not USERNAME_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="Use 3–64 letters, digits, dots, dashes, or underscores for the admin name.")
    if len(setup_token) > 256:
        raise HTTPException(status_code=403, detail="The setup code is invalid or has already been used.")
    validate_new_password(password)
    supplied_hash = hashlib.sha256(setup_token.strip().encode("utf-8")).digest()
    user_id = secrets.token_hex(16)
    timestamp = int(time.time())

    try:
        with store.session() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM auth_users LIMIT 1").fetchone():
                raise HTTPException(status_code=409, detail="Initial setup has already been completed.")
            expected = db.execute("SELECT value FROM auth_meta WHERE key = 'bootstrap_token_hash'").fetchone()
            if expected is None or not hmac.compare_digest(bytes(expected["value"]), supplied_hash):
                raise HTTPException(status_code=403, detail="The setup code is invalid or has already been used.")
            salt = secrets.token_bytes(16)
            password_hash = _password_hash(password, salt)
            db.execute(
                "INSERT INTO auth_users(id, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                (user_id, normalized, salt, password_hash, timestamp),
            )
            db.execute("DELETE FROM auth_meta WHERE key = 'bootstrap_token_hash'")
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="That admin name is already in use.") from exc

    try:
        SETUP_TOKEN_FILE.unlink(missing_ok=True)
    except OSError:
        # The DB record is authoritative; a leftover token file cannot be reused.
        pass
    return {"id": user_id, "username": normalized}


def authenticate(username: str, password: str, remote_address: str) -> dict[str, str]:
    """Validate credentials with a small per-source failure limit."""
    if len(username) > 64 or len(password) > 1024:
        raise HTTPException(status_code=401, detail="The username or password is incorrect.")
    key = _login_limit_key(remote_address)
    now = int(time.time())
    failed = False
    user_value: Optional[dict[str, str]] = None
    with store.session() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT window_start, failures FROM auth_login_limits WHERE key = ?", (key,)).fetchone()
        if row and now - int(row["window_start"]) < LOGIN_WINDOW_SECONDS and int(row["failures"]) >= LOGIN_MAX_FAILURES:
            raise HTTPException(status_code=429, detail="Too many sign-in attempts. Wait 15 minutes and try again.")

        user = db.execute(
            "SELECT id, username, password_salt, password_hash, disabled FROM auth_users WHERE username = ? COLLATE NOCASE",
            (username.strip(),),
        ).fetchone()
        if user is None:
            # Perform a PBKDF2 operation for unknown usernames as well.
            _password_hash(password, b"codemind-unknown-user-salt")
            valid = False
        else:
            candidate = _password_hash(password, bytes(user["password_salt"]))
            valid = not bool(user["disabled"]) and hmac.compare_digest(candidate, bytes(user["password_hash"]))

        if not valid:
            _record_failed_attempt(db, key, now)
            failed = True
        else:
            db.execute("DELETE FROM auth_login_limits WHERE key = ?", (key,))
            user_value = {"id": user["id"], "username": user["username"]}
    if failed:
        raise HTTPException(status_code=401, detail="The username or password is incorrect.")
    if user_value is None:
        raise HTTPException(status_code=401, detail="The username or password is incorrect.")
    return user_value


def issue_session(response: Response, user_id: str, *, now: Optional[int] = None) -> str:
    """Set a signed HttpOnly session cookie and return its CSRF token."""
    current = int(time.time()) if now is None else now
    csrf = secrets.token_urlsafe(32)
    payload = {
        "sub": user_id,
        "iat": current,
        "exp": current + SESSION_TTL_SECONDS,
        "csrf": csrf,
        "v": 1,
    }
    encoded = _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _b64url(hmac.new(_session_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
    response.set_cookie(
        key=COOKIE_NAME,
        value=f"{encoded}.{signature}",
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=os.environ.get("CODEMIND_COOKIE_SECURE", "false").lower() in {"1", "true", "yes"},
        samesite="strict",
        path="/",
    )
    return csrf


def clear_session(response: Response) -> None:
    response.delete_cookie(key=COOKIE_NAME, path="/", httponly=True, samesite="strict")


def read_session(request: Request) -> UserSession:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in is required.")
    session = parse_session(token)
    if session is None:
        raise HTTPException(status_code=401, detail="Your sign-in session is invalid or expired.")
    with store.session() as db:
        user = db.execute("SELECT username, disabled FROM auth_users WHERE id = ?", (session.user_id,)).fetchone()
    if user is None or bool(user["disabled"]):
        raise HTTPException(status_code=401, detail="This account is unavailable.")
    return UserSession(session.user_id, user["username"], session.csrf_token, session.issued_at, session.expires_at)


def parse_session(token: str, *, now: Optional[int] = None) -> Optional[UserSession]:
    """Parse and authenticate a signed cookie. Invalid cookies return None."""
    try:
        encoded, signature = token.split(".", 1)
        expected = hmac.new(_session_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64url(signature)):
            return None
        payload = json.loads(_unb64url(encoded).decode("utf-8"))
        current = int(time.time()) if now is None else now
        issued = int(payload["iat"])
        expires = int(payload["exp"])
        if payload.get("v") != 1 or expires <= current or issued > current + 60 or expires - issued > SESSION_TTL_SECONDS:
            return None
        user_id = payload["sub"]
        csrf = payload["csrf"]
        if not isinstance(user_id, str) or not isinstance(csrf, str) or len(csrf) < 32:
            return None
        return UserSession(user_id, "", csrf, issued, expires)
    except (ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError, binascii.Error):
        return None


def require_csrf(request: Request, session: UserSession) -> None:
    """Require a session-bound CSRF header and a same-host browser Origin."""
    supplied = request.headers.get("x-csrf-token", "")
    if not supplied or not hmac.compare_digest(supplied, session.csrf_token):
        raise HTTPException(status_code=403, detail="The CSRF token is missing or invalid.")
    origin = request.headers.get("origin")
    if not origin:
        raise HTTPException(status_code=403, detail="A same-origin request is required.")
    parsed = urlsplit(origin)
    host = request.headers.get("host", "").lower()
    configured_origins = {
        value.strip().rstrip("/").lower()
        for value in os.environ.get("CODEMIND_CORS_ORIGINS", "").split(",")
        if value.strip()
    }
    if ((parsed.netloc.lower() != host and origin.rstrip("/").lower() not in configured_origins)
            or parsed.scheme not in {"http", "https"}):
        raise HTTPException(status_code=403, detail="Cross-origin requests are not allowed.")


def validate_new_password(password: str) -> None:
    if len(password) < PASSWORD_MIN_LENGTH:
        raise HTTPException(status_code=400, detail=f"Choose a password with at least {PASSWORD_MIN_LENGTH} characters.")
    if len(password) > 1024:
        raise HTTPException(status_code=400, detail="Password is too long.")


def _password_hash(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS, dklen=32)


def _session_secret() -> bytes:
    configured = os.environ.get("CODEMIND_SESSION_SECRET")
    if configured:
        key = configured.encode("utf-8")
        if len(key) < 32:
            raise RuntimeError("CODEMIND_SESSION_SECRET must be at least 32 bytes.")
        return key
    with store.session() as db:
        row = db.execute("SELECT value FROM auth_meta WHERE key = 'session_secret'").fetchone()
    if row is None:
        initialize_auth()
        with store.session() as db:
            row = db.execute("SELECT value FROM auth_meta WHERE key = 'session_secret'").fetchone()
    if row is None:
        raise RuntimeError("Session signing key is unavailable.")
    return bytes(row["value"])


def _record_failed_attempt(db: sqlite3.Connection, key: str, now: int) -> None:
    row = db.execute("SELECT window_start, failures FROM auth_login_limits WHERE key = ?", (key,)).fetchone()
    if row is None or now - int(row["window_start"]) >= LOGIN_WINDOW_SECONDS:
        db.execute(
            "INSERT OR REPLACE INTO auth_login_limits(key, window_start, failures) VALUES (?, ?, 1)",
            (key, now),
        )
    else:
        db.execute("UPDATE auth_login_limits SET failures = failures + 1 WHERE key = ?", (key,))


def _login_limit_key(remote_address: str) -> str:
    return hmac.new(_session_secret(), remote_address.encode("utf-8", errors="replace"), hashlib.sha256).hexdigest()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
