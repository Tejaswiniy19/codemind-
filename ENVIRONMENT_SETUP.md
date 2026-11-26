# CodeMind AI environment setup

## Why the command failed

The command was entered as `docker compose up --build\`. The final backslash became part of the flag, so Docker received `--build\`, which it does not recognize. This is a command typo, not evidence that Docker is missing.

From PowerShell, run the command without a trailing slash:

```powershell
Set-Location D:\Codemind
docker compose up --build
```

Keep that terminal open while the services run. On first launch, get the one-time admin setup code in a second PowerShell terminal:

```powershell
Set-Location D:\Codemind
docker compose exec api cat /data/setup.token
```

Enter it in the setup screen and create an admin name and password (at least 12 characters), then open `http://localhost:8080`. The setup code is consumed once. Press `Ctrl+C` to stop the foreground stack. `docker compose down` stops containers but keeps project data in the named volume.

## Install once for the current app

For the simplest setup, install **Docker Desktop for Windows** with its WSL 2 backend, start Docker Desktop, and wait until it reports that the engine is running. Docker Desktop includes Docker Engine, the Docker CLI, and Docker Compose, so you do not need to install Node.js, Python, or Redis just to run the Compose deployment. The current stack downloads its own Linux images and dependencies during the build.

Check the CLI and engine from PowerShell:

```powershell
docker --version
docker compose version
docker info
```

The first two commands should print versions. `docker info` should show both client and server sections. If it says it cannot connect to the daemon, start Docker Desktop and retry. If `docker compose version` is not recognized, update or reinstall Docker Desktop; Compose is included with it.

Docker Desktop's current Windows requirements include a supported Windows 10/11 edition, hardware virtualization, WSL 2.1.5 or newer for the WSL backend, and at least 8 GB of system RAM. Check or update WSL from PowerShell:

```powershell
wsl --version
wsl --update
```

If WSL is not installed, `wsl --install` may require an elevated terminal and a Windows restart. Use the official Docker installation page for the current Windows requirements and installer choices.

## Environment for local development

You only need this section if you want to run the frontend, API, and worker directly from terminals instead of running the complete stack in Docker.

| Component | Install for local development | Used for |
| --- | --- | --- |
| Node.js 22 LTS and npm | Install Node.js 22 LTS; use `npm.cmd` in PowerShell if the `npm.ps1` script is blocked | React/Vite frontend; this matches the project's Node 22 container image |
| Python 3.11, 64-bit | Install Python 3.11 and make the Windows `py` launcher available | FastAPI API and Celery worker; this matches the project's Python 3.11 image |
| Docker Desktop | Already needed for the simplest run; also starts local Redis below | Containers, Redis, and self-hosted stack |
| Git | Optional for ZIP/folder upload; needed for normal source-control workflows | Version control and later GitHub repository connection |

PostgreSQL, pgvector, and separate Redis installations are **not required for the current Compose run**. The current API uses SQLite and Compose supplies Redis. PostgreSQL/pgvector is a planned later migration for richer graph and semantic retrieval.

### Start Redis for local development

From the project root, start only the Redis service:

```powershell
Set-Location D:\Codemind
docker compose up -d redis
```

### Set up and run the API

In a new PowerShell terminal:

```powershell
Set-Location D:\Codemind\backend
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

In a second backend terminal, activate the same environment and start the analysis worker:

```powershell
Set-Location D:\Codemind\backend
.\.venv\Scripts\Activate.ps1
celery -A app.tasks.celery_app worker --loglevel=INFO --concurrency=2
```

### Set up and run the frontend

In another PowerShell terminal:

```powershell
Set-Location D:\Codemind\frontend
npm.cmd ci
npm.cmd run dev
```

Open `http://localhost:5173`. The Vite development server forwards `/api` requests to the local API on port 8000.

## Configuration and stored data

The current Compose configuration has safe local defaults:

- Web app: `http://localhost:8080` (host port 8080, bound to loopback)
- API: private to the Compose network; proxied through the web app under `/api`
- Redis: private to the Compose network; port 6379 is bound to loopback for local development
- Project database and source snapshots: named volume `codemind-data`; the API provisions a one-time setup code on first boot
- Redis queue persistence: named volume `codemind-redis`

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEMIND_BIND` | `127.0.0.1` | Host interface for web port 8080. Keep the default until HTTPS and a trusted network boundary are configured. |
| `CODEMIND_DATA_DIR` | `/data` in Compose; `backend/data` locally | Directory for the SQLite database and private source archives. Compose mounts its named volume at `/data`; local development can override the path. |
| `CODEMIND_DATA_VOLUME` | `codemind-data` | Docker named volume used for the API database and immutable project archives. Set a new name to restore into a separate volume while preserving the old one. |
| `CODEMIND_MAX_ARCHIVE_BYTES` | 100 MiB | Maximum stored project archive size. |
| `CODEMIND_MAX_EXPANDED_BYTES` | 500 MiB | Maximum total uncompressed project content. |
| `CODEMIND_MAX_FILES` | 20,000 | Maximum file count per project snapshot. |
| `CODEMIND_MAX_SOURCE_PREVIEW_BYTES` | 512 KiB | Maximum size of an individual source file shown in the browser preview (clamped to 5 MiB). |
| `CODEMIND_MAX_ANALYSIS_FILE_BYTES` | 512 KiB | Maximum bytes read from one source or manifest file by static analysis. |
| `CODEMIND_MAX_TOTAL_ANALYSIS_BYTES` | 64 MiB | Maximum total source/manifest input read by one analysis job. |
| `CODEMIND_MAX_ANALYSIS_FILES` | 20,000 | Maximum archive entries processed by static analysis. |
| `CODEMIND_REDIS_URL` | `redis://localhost:6379/0` locally | Redis connection used by the API and Celery worker. Compose sets its internal Redis address automatically. |
| `CODEMIND_COOKIE_SECURE` | `false` for the local HTTP-only default | Set to `true` when the app is served through HTTPS, so browsers send the session cookie only over TLS. |
| `CODEMIND_SESSION_SECRET` | Generated and stored in the private SQLite database | Optional stable HMAC signing key (at least 32 bytes). If you set it, keep it secret and unchanged across restarts/replicas. |
| `CODEMIND_RUNNER_URL` | Empty | Optional HTTPS base URL for a separately operated isolated deployment runner. |
| `CODEMIND_RUNNER_TOKEN` | Empty | Optional bearer token for that runner. Configure it only in `.env` for the worker; do not put it in project files. |
| `CODEMIND_DEPLOYMENT_DOMAINS` | Empty | Comma-separated DNS suffix allowlist for deployment URLs returned by the runner. |
| `CODEMIND_LLM_BASE_URL` | Empty | Optional local/private OpenAI-compatible API base URL (for example `http://host.docker.internal:11434/v1` for a host-run Ollama endpoint). Q&A stays disabled when unset. |
| `CODEMIND_LLM_MODEL` | Empty | Model name understood by the configured local endpoint. |
| `CODEMIND_LLM_TIMEOUT_SECONDS` | 45 seconds | Bounded timeout for one local Q&A request (clamped to 5–90 seconds). |

### Optional local project Q&A

Q&A appears for a snapshot after its analysis completes. It retrieves a small, redacted set of source excerpts from that immutable snapshot and returns file/line citations. The source text is treated as untrusted data, and secret files such as `.env`, private keys, and credential directories are excluded. The API sends snippets only to the explicitly configured local/private endpoint; it does not use a hosted model by default.

For Docker Desktop, a local Ollama service on Windows is usually reachable from the API container at `http://host.docker.internal:11434/v1`. Set `CODEMIND_LLM_BASE_URL` and `CODEMIND_LLM_MODEL` in `.env`, then restart the stack. For an Ollama container on the same Compose network, use its service name and port, such as `http://ollama:11434/v1`. The model must expose the OpenAI-compatible `/chat/completions` endpoint. Q&A reports itself as disabled when either setting is missing.

## Backup and restore

The backup utility uses SQLite's online backup API and verifies every immutable source archive against the snapshot digest. The archive includes the local admin account and session signing key as well as project source, so protect it like a credential. Create `backups/` on the host first; on Linux, make it writable only by the API container's UID 10001 (`sudo chown 10001:10001 backups && chmod 700 backups`). Keep a second encrypted copy off the server.

From PowerShell, create and verify a backup while the app is running:

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
docker compose exec -T api python -m app.backup create --output "/backups/codemind-$stamp.tar.gz"
docker compose exec -T api python -m app.backup verify "/backups/codemind-$stamp.tar.gz"
```

Restore into a **new** named volume so the current volume remains available for recovery. Stop the stack, set `CODEMIND_DATA_VOLUME=codemind-restored` in `.env`, then use the API image as a one-off maintenance container:

```powershell
docker compose down
docker compose run --rm --no-deps --entrypoint python api -m app.backup restore /backups/codemind-backup.tar.gz --to /data
docker compose up --build
```

The restore command requires an empty volume, verifies the backup and database, and rewrites source archive paths for `/data`. Keep the previous volume until the restored workspace has been checked. Runner VM deployments and their SQLite state are separate and need their own backup policy.

Use `.env.example` as a starting point for Compose configuration. Do not commit `.env` or put runner credentials in project source.

The default Compose binding is localhost-only. The current app includes single-admin login with signed HttpOnly cookies, CSRF checks, and login throttling. Before exposing it to a public network, add HTTPS, configure `CODEMIND_COOKIE_SECURE=true`, restrict ingress, plan backups, and review the single-admin limitation. Uploaded code is never executed by the analyzer. The deploy option inspects stack recipes; real builds and live deployments require a separately isolated runner that is not included in this Compose stack. See [the runner protocol guide](backend/docs/remote-runner-protocol.md).

## What will be added in later phases

Keep language runtimes inside controlled adapter/build images rather than requiring every runtime on the Windows host. The current analyzer deeply parses Python and uses partial lexical analysis for JavaScript/TypeScript and Java. The separate, unverified Linux runner supports fixed Node, Python ASGI, and Maven recipes; broader adapters can follow. Do not install a collection of runtimes or expose a Docker daemon to the CodeMind API.

Future work includes multi-user access, PostgreSQL with pgvector, deployment-to-source diagnostics, scheduled backup retention, and broader language/stack adapters. The interactive graph and optional local-model Q&A are part of the current analysis explorer. PostgreSQL and pgvector are not needed for the current SQLite-based app.

## Official installation references

- [Docker Desktop on Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Desktop and WSL 2](https://docs.docker.com/desktop/features/wsl/)
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [Python downloads for Windows](https://www.python.org/downloads/windows/)
- [PostgreSQL downloads for Windows](https://www.postgresql.org/download/windows/)
