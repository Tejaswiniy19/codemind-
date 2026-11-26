"""Unprivileged runner adapter for the separately hosted sandboxd service."""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict
from urllib.parse import urlsplit


class SandboxdBackend:
    """Send immutable source snapshots to sandboxd over authenticated HTTP.

    This adapter does not import Docker and never receives an engine socket.
    Configure the API container's archive directory as a read-only bind mount
    into sandboxd at the same path, or use an authenticated private transport.
    """

    def __init__(self) -> None:
        self.base = os.environ.get("CODEMIND_SANDBOXD_URL", "").rstrip("/")
        self.token = os.environ.get("CODEMIND_SANDBOXD_TOKEN", "")
        parsed = urlsplit(self.base)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise RuntimeError("CODEMIND_SANDBOXD_URL must be an http(s) URL.")
        if parsed.scheme == "http":
            host = parsed.hostname.lower()
            try:
                private_address = ipaddress.ip_address(host).is_private or ipaddress.ip_address(host).is_loopback
            except ValueError:
                private_address = host == "localhost" or host.endswith(".internal") or host.endswith(".local")
            if not private_address:
                raise RuntimeError("sandboxd bearer credentials require HTTPS or a private/loopback HTTP address.")
        if len(self.token) < 32:
            raise RuntimeError("CODEMIND_SANDBOXD_TOKEN must be a random value with at least 32 characters.")

    def _request(self, path: str) -> Dict[str, Any]:
        request = urllib.request.Request(
            self.base + path,
            headers={"Authorization": "Bearer " + self.token, "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                body = response.read(1_048_577)
        except (urllib.error.URLError, TimeoutError) as error:
            raise RuntimeError("sandboxd is unreachable") from error
        if len(body) > 1_048_576:
            raise RuntimeError("sandboxd response exceeded its limit")
        value = json.loads(body.decode("utf-8"))
        if not isinstance(value, dict):
            raise RuntimeError("sandboxd returned an invalid response")
        return value

    def submit(self, job) -> Dict[str, Any]:
        path = Path(job.archive_path)
        if path.stat().st_size > 100 * 1024 * 1024:
            raise RuntimeError("source archive exceeds the sandbox upload limit")
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != job.source_digest.lower():
            raise RuntimeError("archive digest changed before sandbox submission")
        payload = {
            "deployment_id": job.deployment_id,
            "snapshot_id": job.snapshot_id,
            "source_digest": digest,
            "archive_base64": base64.b64encode(data).decode("ascii"),
            "plan": job.plan,
            "limits": job.limits,
        }
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self.base + "/v1/jobs", data=body, method="POST",
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read(1_048_577)
                if len(body) > 1_048_576:
                    raise RuntimeError("sandboxd response exceeded its limit")
                result = json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = "sandboxd rejected the job"
            try:
                detail = json.loads(error.read(4096).decode("utf-8")).get("detail", detail)
            except Exception:
                pass
            return {"provider_id": job.deployment_id, "status": "failed", "message": str(detail), "logs": ""}
        except (urllib.error.URLError, TimeoutError) as error:
            raise RuntimeError("sandboxd is unreachable") from error
        return self._adapt(result)

    def status(self, provider_id: str) -> Dict[str, Any]:
        from urllib.parse import quote
        return self._adapt(self._request("/v1/jobs/" + quote(provider_id, safe="")))

    @staticmethod
    def _adapt(result: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "provider_id": result.get("provider_id", result.get("deployment_id")),
            "status": result.get("status"),
            "message": result.get("message", ""),
            "logs": result.get("logs", ""),
            "url": result.get("url"),
        }
