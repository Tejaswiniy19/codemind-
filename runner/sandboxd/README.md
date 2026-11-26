# CodeMind sandboxd (dedicated Linux VM)

This is a concrete but **not VM-verified** sandbox executor. It is a separate host service: the unprivileged runner API sends an archive and fixed metadata over authenticated HTTP; only this service uses the Docker Engine API. Do not mount `/var/run/docker.sock` into the runner API container. The daemon requires Docker's `runsc` runtime and preloaded recipe images and fails at startup when those are missing.

The service supports only these archive-detected recipes:

- Node: root `package.json`, root `package-lock.json`, and a `start` script. Optional `build` script. Build uses fixed `npm ci` and optional `npm run build`; runtime uses fixed `npm run start` with `PORT=8080` and `HOST=0.0.0.0`.
- Python: root `requirements.txt` and root `main.py` or `app.py`. Installs dependencies and starts the fixed ASGI target `main:app` or `app:app` with Uvicorn.
- Java: root `pom.xml`. Runs fixed Maven package command and starts a jar under `target/`.

The submitted plan is ignored for execution. The daemon independently checks the SHA-256 digest, safely validates ZIP paths and symlinks, bounds entry count and decompression, and chooses the recipe. User build/runtime code runs only inside a disposable `runsc` container with a read-only image filesystem, bounded tmpfs workspace, memory/CPU/pids limits, all Linux capabilities dropped, and no-new-privileges. The same isolated container holds the built workspace for its runtime. No application secrets are supplied. Apps get an internal Docker network and a host port bound to `127.0.0.1`; the daemon creates a Caddy host route and reports success only after a private health probe and a verified HTTPS request.

## What still requires an operator

This code does not provision a Linux VM, install Docker or gVisor, create a real DNS zone, issue certificates, install Caddy, or provision a restricted package egress proxy. The chosen `apps.example.com` domain is a placeholder and is rejected. Until a real domain, DNS, Caddy, and HTTPS reachability are configured, jobs fail with `needs_configuration` and never return a success URL. Build networking defaults to `none`. The supported recipes fetch dependencies, so they fail explicitly with `needs_configuration` when outbound access was not requested. To build those recipes, request controlled build egress and configure both `CODEMIND_EGRESS_PROXY` and an operator-created `CODEMIND_BUILD_NETWORK`. That Docker network must have host firewall rules that force traffic through the configured proxy and deny direct egress; the environment value is not itself an egress firewall.

The host has no Docker/runsc integration available in the development environment. No build, container, runsc isolation, Caddy route, DNS, or TLS behavior has been exercised here. Treat this daemon as an implementation candidate until it has been deployed and validated on the selected VM.

## VM setup

1. Provision a dedicated, patched Linux VM with enough disk/RAM for builds. Put only the sandbox daemon and its Docker Engine on this VM. Firewall its private API port so only the runner API's private VM/container address can reach it. Do not expose port 8082 publicly.
2. Install Docker Engine and the `runsc` runtime following the current gVisor and Docker installation guides. Configure Docker's `daemon.json` with a `runsc` runtime entry, restart Docker, then verify `docker info --format '{{json .Runtimes}}'` lists `runsc`. Do not start sandboxd until this succeeds.
3. Build or select trusted recipe images, pin them by SHA-256 digest, and preload those exact references into Docker. Set all three required variables in `/etc/codemind/sandboxd.env`:

   ```dotenv
   CODEMIND_IMAGE_NODE=registry.example/codemind/node:22@sha256:REPLACE_WITH_64_HEX_DIGEST
   CODEMIND_IMAGE_PYTHON=registry.example/codemind/python:3.12@sha256:REPLACE_WITH_64_HEX_DIGEST
   CODEMIND_IMAGE_JAVA=registry.example/codemind/maven:3.9-temurin-21@sha256:REPLACE_WITH_64_HEX_DIGEST
   ```

   Replace each placeholder with a real 64-character digest and load each exact `name@sha256:...` reference into Docker before starting the service. Startup refuses mutable tag-only references and checks the exact digest-pinned reference exists locally. sandboxd never pulls images. Recipe image contents must include the expected runtime/build tools and `timeout`.
4. Install Caddy on the host with a configured HTTP server named `srv0`, a loopback-only Admin API (default `127.0.0.1:2019`), and public listeners for HTTP/HTTPS. Configure wildcard DNS `*.YOUR_APPS_DOMAIN` to the VM's public ingress and arrange certificate issuance for each app hostname. Caddy's Admin API is privileged: keep it loopback-only and never publish it through a proxy. Set the real bare domain as `CODEMIND_PUBLIC_BASE_DOMAIN` and `http://127.0.0.1:2019` as `CODEMIND_CADDY_ADMIN_URL`.
5. Set a random 32+ character `CODEMIND_SANDBOXD_TOKEN`. Set the sandboxd listen address to the VM's private interface (example `10.20.0.5:8082`) and enforce ingress firewall allowlisting. The runner container must use the same token and call that private address. Plain HTTP is accepted by the runner adapter only for private, loopback, `.internal`, or `.local` addresses; prefer a private network with firewall allowlisting. Use HTTPS if traffic crosses an untrusted network.
6. Set admission/resource caps in the same environment file. Defaults are shown:

   ```dotenv
   CODEMIND_MAX_CONCURRENT_JOBS=4
   CODEMIND_MAX_ACTIVE_DEPLOYMENTS=32
   CODEMIND_ARCHIVE_QUOTA_MB=2048
   ```

   Concurrent jobs must be 1–32 and cannot exceed the active deployment cap (1–256). Active deployments include queued/building/starting jobs and healthy apps. sandboxd returns HTTP 503 before accepting an upload when the active cap is reached, and the upload admission semaphore and scheduler prevent unbounded worker threads. Keep one Uvicorn worker so the process-local build semaphore matches the configured limit. The archive quota counts retained upload files; if storage is full, operators must resolve retention before new submissions.
7. To permit package downloads, set `CODEMIND_EGRESS_PROXY` to a credential-free proxy URL and `CODEMIND_BUILD_NETWORK` to a Docker network whose host firewall rules allow only that proxy and deny all direct egress. Configure proxy-side destination allowlists. Without both values, a job that requests outbound access fails explicitly. With no outbound request, build networking is disabled.
8. Start sandboxd as a dedicated systemd service. Example unit (adjust paths and private bind address):

   ```ini
   [Unit]
   Description=CodeMind isolated sandbox daemon
   After=docker.service network-online.target
   Requires=docker.service

   [Service]
   Type=simple
   User=root
   Group=root
   WorkingDirectory=/opt/codemind/runner/sandboxd
   EnvironmentFile=/etc/codemind/sandboxd.env
   Environment=CODEMIND_SANDBOXD_DATA_DIR=/var/lib/codemind-sandboxd
   ExecStart=/opt/codemind/venv/bin/uvicorn app:app --host 10.20.0.5 --port 8082 --workers 1
   Restart=always
   RestartSec=3
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   ReadWritePaths=/var/lib/codemind-sandboxd
   PrivateTmp=true
   
   [Install]
   WantedBy=multi-user.target
   ```

   This daemon must access `/var/run/docker.sock`, which is equivalent to root on the VM. Keep it root-owned, restrict its API network ingress, and do not reuse this host for unrelated services. `ProtectSystem=strict` still permits the Docker socket; validate the exact unit against the chosen distribution's systemd/Docker configuration.

9. Configure runner API with `CODEMIND_SANDBOX_BACKEND=sandbox_backend.provider:SandboxdBackend`, `CODEMIND_SANDBOXD_URL=http://10.20.0.5:8082`, and the same token. Both systems need to share the upload protocol, not the Docker socket. Keep the runner API archive path private and delete/archive it according to retention policy.

## Explicit current constraints

- Caddy must already have a server named `srv0` with the Admin API enabled. The daemon appends a host route via the Caddy Admin API; route deletion is attempted when a deployment fails or expires.
- Apps use a deterministic opaque 24-character hostname under the configured domain. HTTPS success is checked before the runner is told a URL.
- `timeout_seconds` bounds build commands. A separate `CODEMIND_MAX_DEPLOYMENT_LIFETIME_SECONDS` policy controls service lifetime (default 30 days; set `0` to disable automatic expiry). The daemon health-checks running deployments and removes the runtime and Caddy route after expiry or failed health verification.
- Node package install lifecycle scripts, build scripts, Python package build hooks, and Maven plugins run only inside runsc.
- Recipe support is intentionally narrow. No Dockerfile, arbitrary command, custom shell entrypoint, multi-service stack, or database provisioning is accepted.
- SQLite job state and archives are stored under `/var/lib/codemind-sandboxd`, mode 0700. Backups and retention need operator policy. A service restart revalidates running containers, but an interrupted build is retried from its durable archive.
- `sandboxd` itself is a highly privileged daemon. Its API token, private network ACL, Caddy Admin API, Docker socket, image provenance, and OS updates are security boundaries.
- The recipe images are operator-provided. Their exact configured digest references are checked at startup; changing an image requires a reviewed digest update, local preload, and service restart.

## Local compile-only check

On a development machine, syntax can be checked without Docker:

```sh
python -m py_compile runner/sandboxd/app.py runner/sandbox_backend/provider.py
```

This does not install or validate Docker, runsc, network isolation, recipes, ingress, DNS, or HTTPS.
