from __future__ import annotations

import os
import time

from celery import Celery

from . import store
from .analyzer import analyze_snapshot as run_static_analysis
from .deployment import (
    DeploymentUnavailable,
    DisabledDeploymentProvider,
    RuntimeLimits,
    SnapshotReference,
    configured_deployment_provider,
    inspect_deployment,
)


broker_url = os.environ.get("CODEMIND_REDIS_URL", "redis://localhost:6379/0")
celery_app = Celery("codemind", broker=broker_url)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_track_started=True,
    task_soft_time_limit=120,
    task_time_limit=180,
    broker_connection_retry_on_startup=True,
    broker_connection_timeout=3,
    broker_transport_options={"socket_connect_timeout": 3, "socket_timeout": 3},
    task_publish_retry=False,
)


@celery_app.task(bind=True, name="codemind.analyze_snapshot", max_retries=2)
def analyze_snapshot(task, job_id: str, archive_path: str) -> None:
    store.update_job(job_id, "running", "Inspecting the immutable project snapshot.")
    try:
        result = run_static_analysis(archive_path)
        store.update_job(job_id, "completed", "Static project analysis is ready. See parser coverage and limitations in the results.", result)
    except OSError as error:
        if task.request.retries < task.max_retries:
            store.update_job(job_id, "retrying", "A temporary storage error occurred. Retrying the inventory job.")
            raise task.retry(exc=error, countdown=3)
        store.update_job(job_id, "failed", "The source snapshot could not be read after repeated attempts.")
        raise
    except Exception:
        store.update_job(job_id, "failed", "The stored source snapshot could not be analyzed safely.")
        raise


@celery_app.task(bind=True, name="codemind.prepare_deployment", max_retries=2, soft_time_limit=570, time_limit=600)
def prepare_deployment(task, job_id: str, archive_path: str, snapshot_id: str, source_digest: str, allow_outbound_network: bool = False) -> None:
    store.update_job(job_id, "running", "Detecting supported stack recipes. No source code will be executed.")
    try:
        plan = inspect_deployment(archive_path, snapshot_id, source_digest)
        if plan.status == "candidate":
            provider = configured_deployment_provider()
            if isinstance(provider, DisabledDeploymentProvider):
                status = "blocked"
                message = "A deployment recipe was detected, but execution remains disabled until a separate isolated runner is configured."
                store.update_job(job_id, status, message, plan.to_dict())
                return
            limits = RuntimeLimits(allow_outbound_network=bool(allow_outbound_network))
            submission = provider.submit(SnapshotReference(snapshot_id, source_digest, archive_path), plan, limits)
            state = submission["status"]
            result = {**plan.to_dict(), "runner": submission}
            if state == "succeeded":
                store.update_job(job_id, "completed", str(submission.get("message") or "Deployment completed."), result)
            elif state in {"failed", "cancelled"}:
                store.update_job(job_id, "failed", str(submission.get("message") or "The isolated runner did not complete the deployment."), result)
            else:
                store.update_job(job_id, "running", str(submission.get("message") or "The isolated runner is building the selected snapshot."), result)
                deadline = int(time.time()) + limits.timeout_seconds + 60
                poll_deployment.apply_async(args=[job_id, str(submission["deployment_id"]), deadline], countdown=5)
            return
        elif plan.status == "review_required":
            status = "needs_review"
            message = plan.reason
        elif plan.status == "configuration_required":
            status = "needs_configuration"
            message = plan.reason
        else:
            status = "unsupported"
            message = plan.reason
        store.update_job(job_id, status, message, plan.to_dict())
    except OSError as error:
        if task.request.retries < task.max_retries:
            store.update_job(job_id, "retrying", "A temporary storage error occurred. Retrying deployment inspection.")
            raise task.retry(exc=error, countdown=3)
        store.update_job(job_id, "failed", "The deployment requirements could not be read after repeated attempts.")
        raise
    except Exception:
        store.update_job(job_id, "failed", "The project could not be safely inspected for deployment.")
        raise


@celery_app.task(name="codemind.poll_deployment", max_retries=0)
def poll_deployment(job_id: str, provider_deployment_id: str, deadline: int) -> None:
    """Poll a configured remote runner without executing source in this worker."""
    job = store.get_job(job_id)
    if job is None or job.get("status") not in {"running", "queued"}:
        return
    if int(time.time()) >= deadline:
        result = job.get("result") or {}
        runner_result = result.get("runner") if isinstance(result, dict) else None
        if isinstance(runner_result, dict):
            runner_result = {**runner_result, "status": "failed", "message": "Runner deployment exceeded its time limit."}
            result = {**result, "runner": runner_result}
        store.update_job(job_id, "failed", "The isolated runner exceeded its configured time limit.", result if isinstance(result, dict) else None)
        return
    try:
        provider = configured_deployment_provider()
        if isinstance(provider, DisabledDeploymentProvider):
            store.update_job(job_id, "failed", "The isolated runner configuration was removed while deployment was active.")
            return
        runner_result = provider.status(provider_deployment_id)
        if runner_result.get("deployment_id", provider_deployment_id) != provider_deployment_id:
            raise DeploymentUnavailable("The isolated runner returned a different deployment identifier.")
        job = store.get_job(job_id)
        if job is None:
            return
        result = job.get("result") or {}
        result = dict(result) if isinstance(result, dict) else {}
        result["runner"] = runner_result
        state = runner_result["status"]
        message = str(runner_result.get("message") or "Runner deployment status updated.")
        if state == "succeeded":
            store.update_job(job_id, "completed", message, result)
        elif state in {"failed", "cancelled"}:
            store.update_job(job_id, "failed", message, result)
        else:
            store.update_job(job_id, "running", message, result)
            poll_deployment.apply_async(args=[job_id, provider_deployment_id, deadline], countdown=5)
    except Exception:
        store.update_job(job_id, "failed", "The isolated deployment runner could not provide a valid status.")
