# CodeMind AI

Self-hosted software intelligence and deployment workspace.

For Windows installation prerequisites, environment variables, and development setup, see [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md).

## Product workflow

Each project snapshot can run either capability independently or both together:

- **Explain project** builds an evidence-backed inventory of files, technologies, and project structure.
- **Deploy project** requests an automated build and deployment. You can explicitly allow dependency downloads through the runner's restricted package proxy; the deployed app itself starts without outbound networking.
- **Both** uses the same immutable snapshot for analysis and deployment.

## Phase plan

1. **Workspace foundation** — project intake, immutable snapshots, persistent Redis/Celery jobs, capability selection, and the workspace UI.
2. **Project intelligence (implemented)** — Python AST analysis; partial lexical analysis for JavaScript, TypeScript, and Java; evidence-backed file roles, symbols, imports, relationships, framework clues, feature groupings, and bounded results.
3. **Deployment (implementation candidate)** — recipe inspection and an optional remote runner control service are implemented. A separate gVisor sandbox daemon has fixed Node, Python ASGI, and Maven recipes with build/runtime checks and HTTPS ingress. It has not been validated on a Linux VM; it requires a real DNS domain, Caddy, controlled package egress, Docker configured with runsc, and pinned build images. Deployment remains disabled in the default Compose stack. See [sandboxd VM setup](runner/sandboxd/README.md).
4. **Unified product (partial)** — searchable file and symbol exploration, a bounded interactive relationship graph, relationship evidence, conservative impact hints, and optional source-grounded Q&A with citations through a configured local model. Deployment-to-source diagnostics remain future work.
5. **Self-hosted hardening (partial)** — first-run single-admin setup, signed HttpOnly sessions, CSRF checks, login throttling, private local storage, resource-limited services, and verified backup/restore tooling. Multi-user access, scheduled backup retention, high availability, and hardened public ingress remain future work.

Analysis never executes uploaded code. Deployment selection inspects the same immutable snapshot and reports detected recipes, review needs, and missing configuration. An optional authenticated runner client can submit supported snapshots and poll status, but a compatible separately isolated runner service must be operated and configured before a build can execute. The default Compose stack has no runner and reports candidate deployments as blocked.

## Run locally

Install the API and worker dependencies, then start Redis:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..
docker compose up -d redis
```

Start the API in one terminal:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000
```

On first local launch, open the Vite app and read the setup code from `backend/data/setup.token` in a second terminal. Create the local administrator in the setup screen.

Start the worker in another terminal:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
celery -A app.tasks.celery_app worker --loglevel=INFO --concurrency=2
```

### Web app

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

The Vite development server proxies `/api` requests to `http://localhost:8000`.

## Run as a self-hosted service

Docker Compose starts the web app, API, Redis queue, and analysis worker together. The API and queue stay on the private Compose network, and the web app binds to loopback by default; open it at `http://localhost:8080`. Set `CODEMIND_BIND=0.0.0.0` only when you have configured a trusted network boundary and access control.

```powershell
docker compose up --build
```

The stack has safe defaults without a `.env` file. To change limits or enable HTTPS cookie behavior, copy `.env.example` to `.env` and adjust the values before starting. Keep `.env` private; it is excluded from version control.

On first launch, create the workspace administrator. In a second PowerShell terminal, retrieve the one-time setup code:

```powershell
Set-Location D:\Codemind
docker compose exec api cat /data/setup.token
```

Enter that code in the setup screen and choose an admin name and password of at least 12 characters. The code is single-use. For an HTTPS reverse proxy, set `CODEMIND_COOKIE_SECURE=true` in `.env` before starting the stack.

The Deploy option inspects recipes by default and stays blocked until a compatible isolated runner is configured. CodeMind has an optional remote HTTPS runner client; setup and the runner-side requirements are in [backend/docs/remote-runner-protocol.md](backend/docs/remote-runner-protocol.md). There is no runner service in this Compose file.

## Authentication and storage

The API stores its SQLite database and immutable source archives under `CODEMIND_DATA_DIR` (default: `backend/data`). On first launch, use the setup screen to create the local administrator. The one-time setup code is available in `backend/data/setup.token` for local development or with `docker compose exec api cat /data/setup.token` for Compose. Keep the data directory private and create regular verified backups using the procedure in [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md). The current authentication model is a single local administrator; multi-user access, project memberships, and password recovery are not implemented. Keep the default Compose web binding on loopback until you have configured HTTPS and a trusted network boundary.
