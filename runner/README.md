# CodeMind isolated runner control service

This package implements the authenticated HTTPS runner API and durable job metadata used by CodeMind. It validates the source archive, verifies its SHA-256 digest, deduplicates submissions, and polls an explicitly installed sandbox backend. The API service never extracts or executes project source.

**Builds are unavailable until a sandbox backend is installed.** The package intentionally has no built-in host process, Docker, or Podman executor. It refuses to start without `CODEMIND_SANDBOX_BACKEND`. This prevents the control service from silently running project code on the runner host.

## Required deployment layout

Use a dedicated Linux VM for this service and its isolated execution infrastructure. Do not place CodeMind's API, SQLite database, source volume, or administrator secrets on this VM. A compatible sandbox backend must:

- create a disposable microVM or equivalent strong sandbox for each build and runtime;
- independently re-verify the source digest and detect supported recipes rather than trust the submitted plan;
- enforce CPU, memory, disk, process count, wall-clock, and network policy inside the sandbox;
- provide package download access through a controlled egress proxy, or document that offline builds are required;
- keep runtime deployments isolated from each other and from the control service;
- expose applications through a reverse proxy on the configured deployment domain and return an HTTPS URL;
- scrub secrets from bounded status messages and logs.

The runner control API has no host Docker socket mount and no code-execution path. A sandbox backend is an installed Python module that implements `submit(job)` and `status(provider_id)`. The `job` object exposes a private archive path, immutable snapshot/digest, detected plan, and requested limits. It must enqueue work in the isolated infrastructure and return quickly. Never implement this interface by calling a shell in the control-service container or mounting a general-purpose container-engine socket into it.

## Domains and TLS

Choose a real DNS zone before enabling deployment. The examples use placeholders:

- runner API: `runner.example.com` (A/AAAA record to the dedicated VM);
- deployed applications: `*.apps.example.com` (wildcard DNS record to the sandbox application's ingress).

Configure CodeMind with `CODEMIND_RUNNER_URL=https://runner.example.com` and `CODEMIND_DEPLOYMENT_DOMAINS=apps.example.com`. The sandbox backend must route wildcard application hostnames to the matching sandbox and return only HTTPS URLs within that suffix. Provide TLS for both API and app traffic. Caddy can terminate the runner API TLS; wildcard app certificates generally require DNS challenge support for the chosen DNS provider. A DNS record alone does not implement app routing.

## Install on the dedicated Linux VM

Copy this `runner/` directory and the separately reviewed sandbox backend package to the VM. Install Docker Engine and the Compose plugin on the runner VM if you use the supplied wrapper; this is independent of the CodeMind host. The wrapper publishes the API only on loopback and does not mount a Docker socket.

1. Copy `.env.example` to `.env` and set a randomly generated shared token (at least 32 characters), the actual domain suffix, and the installed backend module/class. Keep the file readable only by the operator account.
2. Install the backend package under `sandbox_backend/` or build a reviewed image that includes it. It must satisfy the interface and isolation requirements above.
3. Start the control service:

   ```sh
   docker compose -f compose.yaml up --build -d
   ```

4. Configure the host reverse proxy for `runner.example.com` to `127.0.0.1:8081`. Configure the sandbox backend's separate app ingress for `*.apps.example.com`.
5. Verify `https://runner.example.com/v1/health` returns `{"status":"ok","service":"codemind-runner"}` only after the backend imports successfully.
6. Set the same token in the CodeMind worker's private `.env`, set `CODEMIND_RUNNER_URL` and `CODEMIND_DEPLOYMENT_DOMAINS`, then restart the worker.

The API process runs as UID 10002, has resource limits and dropped Linux capabilities, and stores archives/database files with private permissions. Its writable state is limited to the named data volume. Keep the VM patched, firewall the runner API to the CodeMind worker and administrator ingress, and back up/expire deployment metadata and archives under your retention policy.

## Backend interface

The package loads a class using `CODEMIND_SANDBOX_BACKEND=package.module:ClassName`. The class is instantiated with no arguments and must implement:

```python
def submit(job) -> dict:
    # Queue job.deployment_id once; verify job.source_digest before use.
    # Return {"provider_id": "opaque-id", "status": "queued", "message": "...", "logs": ""}
    ...

def status(provider_id: str) -> dict:
    # Return provider_id, status, message, logs, and an HTTPS URL on success.
    ...
```

Allowed status values are `queued`, `building`, `starting`, `succeeded`, `failed`, and `cancelled`. A success without an allowlisted HTTPS URL is rejected. The backend must make submission idempotent by `job.deployment_id` and source digest. It must validate the archive/recipe itself; the plan received from CodeMind is only a hint.

## Operational limits

The API accepts archives up to 100 MiB and JSON requests up to roughly 136 MiB to allow base64 overhead. It stores source archives in its private data volume for the backend. Backend logs are limited to 32,000 characters, status messages to 2,000, and successful URLs to the configured HTTPS domain suffix. The controller polls the backend every five seconds. The CodeMind worker applies its own deployment timeout; the sandbox backend must also enforce the requested timeout itself.

This package supplies the runner protocol service and a sandbox extension point. It does **not** include a gVisor, Firecracker, Kata, or other sandbox provider, a wildcard app router, DNS records, TLS certificates, or an egress proxy. Until those components are installed and verified, do not configure this service as a deployment runner; CodeMind should remain fail-closed.
