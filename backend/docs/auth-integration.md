# Authentication implementation

The FastAPI application wires `app.auth` into the current workspace routes. This is a single local administrator account, not a multi-user membership system.

## First-run setup

At startup, `main.py` initializes the SQLite store and calls `initialize_auth()`. When no administrator exists, it writes a one-time setup code to `CODEMIND_DATA_DIR/setup.token` with restrictive file permissions where supported. The setup endpoint accepts the code once, validates the administrator name and password, stores a salted PBKDF2-SHA-256 password hash, and removes the setup file.

For Docker Compose:

```powershell
docker compose exec api cat /data/setup.token
```

For local API development, read `backend/data/setup.token` from the project root. The code is never returned by the auth status endpoint.

## Current routes

- `GET /api/auth/status` reports whether first-run setup is required.
- `POST /api/auth/setup` completes one-time setup and issues a session.
- `POST /api/auth/login` validates credentials and issues a session.
- `GET /api/auth/session` returns the signed-in account and CSRF token.
- `POST /api/auth/logout` checks CSRF and clears the session.
- Project and job reads require a valid session. Project upload requires both a valid session and CSRF token.

Sessions use a signed HttpOnly cookie with `SameSite=Strict`, a 12-hour expiry, and a separate CSRF token. Password authentication is rate-limited by peer address. Cross-origin state changes are rejected; the configured development origin can be allowed explicitly for local frontend development.

## Configuration and limits

- Set `CODEMIND_COOKIE_SECURE=true` when HTTPS terminates in front of CodeMind.
- `CODEMIND_SESSION_SECRET` is optional. If set, it must be at least 32 bytes and stable across restarts and API replicas. If omitted, a random signing key is stored in the private SQLite database.
- Keep `CODEMIND_DATA_DIR` private and backed up. It contains administrator credentials, the session signing key, and project snapshots.
- Rate limiting uses the direct peer address. Do not trust forwarded IP headers unless the reverse proxy is explicitly configured as trusted.
- The current implementation has one administrator. Multi-user accounts, project-level membership/RBAC, password reset, recovery codes, and external identity providers are not implemented.
- The analysis worker shares the SQLite data volume to update job records, but does not execute uploaded source code. A deployment runner must be separately isolated and must not receive the session signing key.
