# Remote isolated deployment runner protocol

CodeMind includes an optional HTTPS client for a deployment runner hosted outside the API and analysis worker. The default configuration has no runner and keeps deployment execution disabled. A remote runner is **not included** in the Compose stack; configuring these variables is not enough unless a compatible runner exists and has been hardened by its operator.

## CodeMind worker configuration

Set these variables on the Celery worker only. Do not set them on the API or web service.

| Variable | Required | Meaning |
| --- | --- | --- |
| `CODEMIND_RUNNER_URL` | Yes | Runner base URL, HTTPS on port 443, with no URL credentials, query, or fragment. |
| `CODEMIND_RUNNER_TOKEN` | Yes | Shared bearer token, at least 32 characters; provision it out of band and keep it secret. |
| `CODEMIND_DEPLOYMENT_DOMAINS` | Recommended | Comma-separated allowed DNS suffixes for deployment URLs returned to the UI. If empty, any returned URL is rejected. |

Keep the runner URL on a trusted network. TLS certificate verification is enabled. The client never follows a URL returned by project data; it contacts only the configured endpoint. For HTTPS behind a reverse proxy, expose the runner API only to the CodeMind worker network and firewall all other access.

The worker sends an immutable source archive in a JSON POST as Base64. The client reads at most the configured archive limit and verifies SHA-256 against the snapshot digest before sending. Operators should account for Base64 transfer overhead (about one third) and set request-size limits accordingly. Do not put runner credentials in a project archive or in the frontend.

## Request and response contract, version 1

CodeMind sends:

```http
POST /v1/deployments
Authorization: Bearer <shared token>
Idempotency-Key: <stable key for snapshot_id and source_digest>
Content-Type: application/json
```

```json
{
  "protocol_version": 1,
  "snapshot_id": "immutable-snapshot-id",
  "source_digest": "64-character SHA-256 hex digest of the ZIP bytes",
  "archive_base64": "...",
  "plan": { "status": "candidate", "candidates": [], "...": "..." },
  "limits": {
    "cpu_millicores": 1000,
    "memory_mb": 1024,
    "disk_mb": 2048,
    "timeout_seconds": 900,
    "max_processes": 128,
    "allow_outbound_network": false
  }
}
```

The runner must independently:

1. Authenticate the bearer token, enforce request and archive size bounds, decode the archive, and verify its SHA-256 digest before queuing work.
2. Treat the source, manifests, scripts, Dockerfiles, build plugins, and detected plan as untrusted input. Never interpret the plan as trusted shell text.
3. Execute each build in a disposable, strongly isolated environment with enforced CPU, memory, disk, process, wall-clock, and network limits. The runner owns and must enforce these limits; the request values alone are not a security boundary.
4. Keep deployment secrets out of build environments unless explicitly configured for a particular deployment. Never return credentials in logs or status responses.
5. Make deployment creation idempotent for a repeated `Idempotency-Key` and `(snapshot_id, source_digest)`, and bind every resulting deployment to that digest. CodeMind derives the key deterministically from the immutable snapshot ID and source digest so Celery redelivery does not start duplicate builds.
6. Expose only an authenticated status endpoint. Logs and messages must be bounded and scrubbed for secrets.

The POST response is JSON, at most 1 MiB, with an opaque identifier and one of the supported states:

```json
{ "deployment_id": "safe-id_123", "status": "queued", "message": "Build queued" }
```

CodeMind polls:

```http
GET /v1/deployments/{deployment_id}
Authorization: Bearer <shared token>
Accept: application/json
```

Allowed states are `queued`, `building`, `starting`, `succeeded`, `failed`, and `cancelled`. A successful result may include an HTTPS `url` whose DNS name matches `CODEMIND_DEPLOYMENT_DOMAINS`. An optional `logs` field is limited to 32,000 characters; messages are limited to 2,000 characters. The client rejects malformed IDs, unlisted states, oversized values, HTTP URLs, IP/local URLs, and URLs outside the configured allowlist.

## Isolation requirement

Do not mount the host Docker socket into the API or analysis worker. A runner that uses a container engine must be a separate security boundary with its own narrowly scoped engine access and isolated worker hosts, or use a stronger sandbox/VM backend. A shared container on the same host is not equivalent to a hardened disposable build environment. If no runner meets these requirements, leave the deployment provider unconfigured; CodeMind will report the candidate as blocked and will not execute it.
