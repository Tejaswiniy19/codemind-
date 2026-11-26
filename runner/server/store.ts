import crypto from 'node:crypto';
import { getDb } from './db.ts';
import type {
  AdminUser,
  ArchitectureBrief,
  AuditLogEntry,
  DeploymentPlan,
  DeploymentRecord,
  JobRecord,
  ProjectEnvVar,
  ProjectRecord,
  QAHistoryEntry,
  SessionRecord,
  SnapshotRecord,
  WorkspaceSettings,
} from './types.ts';
import { analyzeSnapshotBuffer } from './analyzer.ts';
import { inspectDeploymentBuffer } from './deployment.ts';
import { createSampleProjectArchive } from './sampleProject.ts';

const DEFAULT_SETTINGS: WorkspaceSettings = {
  workspaceName: 'My workspace',
  defaultExplain: true,
  defaultDeploy: false,
  defaultAllowBuildDownloads: false,
  runnerMode: 'dry-run',
  pollingIntervalMs: 5000,
  storageQuotaMb: 500,
  maxProjectsQuota: 50,
};

let initialized = false;

export async function initializeStore(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM projects').get() as { cnt: number };
  if (Number(row.cnt) === 0) {
    await seedDemoProject('system');
  }
}

export function recordAuditLog(
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  detail: string,
): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO audit_logs (id, actor, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), actor, action, targetType, targetId, detail, new Date().toISOString());
}

export function listAuditLogs(limit = 100): AuditLogEntry[] {
  const db = getDb();
  return db
    .prepare(
      'SELECT id, actor, action, target_type, target_id, detail, created_at FROM audit_logs ORDER BY created_at DESC LIMIT ?',
    )
    .all(limit) as unknown as AuditLogEntry[];
}

export async function seedDemoProject(actor = 'system'): Promise<ProjectRecord> {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get('inventory-pulse-sample') as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(existing.id);
  }

  const sample = await createSampleProjectArchive();
  const projectId = crypto.randomUUID();
  const snapshotId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const analysis = await analyzeSnapshotBuffer(sample.buffer);
  const deploymentPlan = await inspectDeploymentBuffer(
    sample.buffer,
    snapshotId,
    sample.digest,
    true,
    true,
    deploymentId,
    0,
  );

  const jobs: JobRecord[] = [
    {
      id: crypto.randomUUID(),
      kind: 'analysis',
      status: 'completed',
      message: 'Static project analysis is ready. See parser coverage and limitations in the results.',
      created_at: nowIso,
      updated_at: nowIso,
      result: analysis,
    },
    {
      id: crypto.randomUUID(),
      kind: 'deployment',
      status: deploymentPlan.status,
      message: deploymentPlan.reason,
      created_at: nowIso,
      updated_at: nowIso,
      result: deploymentPlan,
    },
  ];

  const snapshot: SnapshotRecord = {
    id: snapshotId,
    project_id: projectId,
    version_num: 1,
    digest: sample.digest,
    file_count: sample.fileCount,
    total_bytes: sample.totalBytes,
    created_at: nowIso,
    archive_base64: sample.buffer.toString('base64'),
    jobs,
  };

  const project: ProjectRecord = {
    id: projectId,
    name: 'inventory-pulse-sample',
    source_type: 'sample',
    repo_url: null,
    created_at: nowIso,
    snapshots: [snapshot],
  };

  addProject(project, actor);

  const primary = deploymentPlan.candidates[0];
  addDeploymentRecord({
    id: deploymentId,
    project_id: projectId,
    project_name: project.name,
    snapshot_id: snapshotId,
    version_num: 1,
    environment: 'isolated-sandbox',
    status: deploymentPlan.status,
    stack: primary?.stack ?? 'Python ASGI + React',
    runtime_family: primary?.runtime_family ?? 'python',
    public_url: deploymentPlan.runner?.url ?? null,
    health_status: deploymentPlan.runner?.health_status ?? 'healthy',
    allow_outbound_network: true,
    cpu_millicores: deploymentPlan.limits?.cpu_millicores ?? 500,
    memory_mb: deploymentPlan.limits?.memory_mb ?? 512,
    logs_text: deploymentPlan.runner?.logs ?? null,
    created_at: nowIso,
  });

  return project;
}

export function getAdminUser(): AdminUser | null {
  const db = getDb();
  const row = db
    .prepare('SELECT id, username, password_hash, role, created_at FROM users ORDER BY created_at ASC LIMIT 1')
    .get() as { id: string; username: string; password_hash: string; role: string; created_at: string } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at,
  };
}

export function setAdminUser(user: AdminUser): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(user.id, user.username, user.passwordHash, user.role || 'admin', user.createdAt);
  recordAuditLog(user.username, 'ADMIN_SETUP', 'user', user.id, `Created local workspace administrator ${user.username}`);
}

export function getSession(sessionId: string): SessionRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT id, user_id, username, csrf_token, expires_at FROM sessions WHERE id = ?')
    .get(sessionId) as
    | { id: string; user_id: string; username: string; csrf_token: string; expires_at: string }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
  };
}

export function saveSession(session: SessionRecord): void {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO sessions (id, user_id, username, csrf_token, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(session.id, session.userId, session.username, session.csrfToken, session.expiresAt);
}

export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function listProjectsSummary() {
  const db = getDb();
  const projects = db
    .prepare('SELECT id, name, source_type, repo_url, created_at FROM projects ORDER BY created_at DESC')
    .all() as Array<{ id: string; name: string; source_type: string; repo_url: string | null; created_at: string }>;

  return projects.map((p) => {
    const latestSnap = db
      .prepare(
        'SELECT id, version_num, digest, file_count, total_bytes, created_at FROM snapshots WHERE project_id = ? ORDER BY version_num DESC, created_at DESC LIMIT 1',
      )
      .get(p.id) as
      | { id: string; version_num: number; digest: string; file_count: number; total_bytes: number; created_at: string }
      | undefined;
    const snapCountRow = db
      .prepare('SELECT COUNT(*) AS cnt FROM snapshots WHERE project_id = ?')
      .get(p.id) as { cnt: number };

    const jobs = latestSnap
      ? (db
          .prepare('SELECT id, kind, status, message FROM jobs WHERE snapshot_id = ?')
          .all(latestSnap.id) as Array<{ id: string; kind: string; status: string; message: string }>)
      : [];

    return {
      id: p.id,
      name: p.name,
      source_type: p.source_type,
      repo_url: p.repo_url,
      created_at: p.created_at,
      snapshot_id: latestSnap?.id,
      version_num: latestSnap?.version_num ?? 1,
      snapshot_count: Number(snapCountRow.cnt),
      digest: latestSnap?.digest,
      file_count: latestSnap?.file_count ?? 0,
      total_bytes: latestSnap?.total_bytes ?? 0,
      jobs,
    };
  });
}

export function getProjectDetail(projectId: string) {
  const db = getDb();
  const project = db
    .prepare('SELECT id, name, source_type, repo_url, created_at FROM projects WHERE id = ?')
    .get(projectId) as
    | { id: string; name: string; source_type: string; repo_url: string | null; created_at: string }
    | undefined;
  if (!project) return null;

  const snaps = db
    .prepare(
      'SELECT id, version_num, digest, file_count, total_bytes, created_at FROM snapshots WHERE project_id = ? ORDER BY version_num DESC, created_at DESC',
    )
    .all(projectId) as Array<{
    id: string;
    version_num: number;
    digest: string;
    file_count: number;
    total_bytes: number;
    created_at: string;
  }>;

  const snapshots = snaps.map((s) => {
    const jobRows = db
      .prepare(
        'SELECT id, kind, status, message, result_json, created_at, updated_at FROM jobs WHERE snapshot_id = ?',
      )
      .all(s.id) as Array<{
      id: string;
      kind: 'analysis' | 'deployment';
      status: string;
      message: string;
      result_json: string | null;
      created_at: string;
      updated_at: string;
    }>;

    const briefRow = db
      .prepare('SELECT brief_json FROM architecture_briefs WHERE snapshot_id = ?')
      .get(s.id) as { brief_json: string } | undefined;

    return {
      id: s.id,
      version_num: s.version_num,
      digest: s.digest,
      file_count: s.file_count,
      total_bytes: s.total_bytes,
      created_at: s.created_at,
      brief: briefRow ? (JSON.parse(briefRow.brief_json) as ArchitectureBrief) : null,
      jobs: jobRows.map((j) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        message: j.message,
        created_at: j.created_at,
        updated_at: j.updated_at,
        result: j.result_json ? JSON.parse(j.result_json) : null,
      })),
    };
  });

  return {
    ...project,
    snapshots,
  };
}

export function getProjectRaw(projectId: string): { id: string; name: string; source_type: string; repo_url: string | null; created_at: string } | null {
  const db = getDb();
  const row = db
    .prepare('SELECT id, name, source_type, repo_url, created_at FROM projects WHERE id = ?')
    .get(projectId) as
    | { id: string; name: string; source_type: string; repo_url: string | null; created_at: string }
    | undefined;
  return row ?? null;
}

export function getSnapshot(projectId: string, snapshotId?: string): SnapshotRecord | null {
  const db = getDb();
  const snap = snapshotId
    ? (db
        .prepare(
          'SELECT id, project_id, version_num, digest, file_count, total_bytes, archive_base64, created_at FROM snapshots WHERE project_id = ? AND id = ?',
        )
        .get(projectId, snapshotId) as
        | {
            id: string;
            project_id: string;
            version_num: number;
            digest: string;
            file_count: number;
            total_bytes: number;
            archive_base64: string;
            created_at: string;
          }
        | undefined)
    : (db
        .prepare(
          'SELECT id, project_id, version_num, digest, file_count, total_bytes, archive_base64, created_at FROM snapshots WHERE project_id = ? ORDER BY version_num DESC, created_at DESC LIMIT 1',
        )
        .get(projectId) as
        | {
            id: string;
            project_id: string;
            version_num: number;
            digest: string;
            file_count: number;
            total_bytes: number;
            archive_base64: string;
            created_at: string;
          }
        | undefined);

  if (!snap) return null;

  const jobRows = db
    .prepare('SELECT id, kind, status, message, result_json, created_at, updated_at FROM jobs WHERE snapshot_id = ?')
    .all(snap.id) as Array<{
    id: string;
    kind: 'analysis' | 'deployment';
    status: string;
    message: string;
    result_json: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return {
    ...snap,
    jobs: jobRows.map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      message: j.message,
      created_at: j.created_at,
      updated_at: j.updated_at,
      result: j.result_json ? JSON.parse(j.result_json) : null,
    })),
  };
}

export function addProject(project: ProjectRecord, actor = 'workspace-admin'): void {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, name, source_type, repo_url, created_at) VALUES (?, ?, ?, ?, ?)').run(
    project.id,
    project.name,
    project.source_type,
    project.repo_url,
    project.created_at,
  );
  for (const snap of project.snapshots) {
    addSnapshotToProject(project.id, snap);
  }
  recordAuditLog(
    actor,
    project.source_type === 'github' ? 'GITHUB_IMPORTED' : 'SNAPSHOT_CREATED',
    'project',
    project.id,
    `Created project "${project.name}" (${project.source_type}, ${project.snapshots[0]?.file_count ?? 0} files)`,
  );
}

export function addSnapshotToProject(projectId: string, snap: SnapshotRecord): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO snapshots (id, project_id, version_num, digest, file_count, total_bytes, archive_base64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    snap.id,
    projectId,
    snap.version_num,
    snap.digest,
    snap.file_count,
    snap.total_bytes,
    snap.archive_base64,
    snap.created_at,
  );
  for (const job of snap.jobs) {
    db.prepare(
      'INSERT INTO jobs (id, project_id, snapshot_id, kind, status, message, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      job.id,
      projectId,
      snap.id,
      job.kind,
      job.status,
      job.message,
      job.result ? JSON.stringify(job.result) : null,
      job.created_at,
      job.updated_at,
    );
  }
}

export function getNextSnapshotVersion(projectId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COALESCE(MAX(version_num), 0) AS max_v FROM snapshots WHERE project_id = ?').get(projectId) as {
    max_v: number;
  };
  return Number(row.max_v) + 1;
}

export function updateSnapshotJob(projectId: string, snapshotId: string, job: JobRecord): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM jobs WHERE snapshot_id = ? AND kind = ?')
    .get(snapshotId, job.kind) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE jobs SET status = ?, message = ?, result_json = ?, updated_at = ? WHERE id = ?').run(
      job.status,
      job.message,
      job.result ? JSON.stringify(job.result) : null,
      job.updated_at,
      existing.id,
    );
  } else {
    db.prepare(
      'INSERT INTO jobs (id, project_id, snapshot_id, kind, status, message, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      job.id,
      projectId,
      snapshotId,
      job.kind,
      job.status,
      job.message,
      job.result ? JSON.stringify(job.result) : null,
      job.created_at,
      job.updated_at,
    );
  }
}

export function deleteProject(projectId: string, actor = 'workspace-admin'): boolean {
  const db = getDb();
  const existing = getProjectRaw(projectId);
  const res = db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  const removed = Number(res.changes) > 0;
  if (removed && existing) {
    recordAuditLog(actor, 'PROJECT_DELETED', 'project', projectId, `Deleted project "${existing.name}"`);
  }
  return removed;
}

export function addDeploymentRecord(record: DeploymentRecord): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO deployments (
      id, project_id, snapshot_id, version_num, environment, status, stack, runtime_family,
      public_url, health_status, allow_outbound_network, cpu_millicores, memory_mb, logs_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.project_id,
    record.snapshot_id,
    record.version_num,
    record.environment,
    record.status,
    record.stack,
    record.runtime_family,
    record.public_url,
    record.health_status,
    record.allow_outbound_network ? 1 : 0,
    record.cpu_millicores,
    record.memory_mb,
    record.logs_text,
    record.created_at,
  );
}

export function getDeploymentById(deploymentId: string): DeploymentRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT d.*, p.name AS project_name
       FROM deployments d
       JOIN projects p ON p.id = d.project_id
       WHERE d.id = ?`,
    )
    .get(deploymentId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    project_name: String(row.project_name),
    snapshot_id: String(row.snapshot_id),
    version_num: Number(row.version_num),
    environment: String(row.environment),
    status: String(row.status),
    stack: String(row.stack),
    runtime_family: String(row.runtime_family),
    public_url: row.public_url ? String(row.public_url) : null,
    health_status: String(row.health_status),
    allow_outbound_network: Boolean(row.allow_outbound_network),
    cpu_millicores: Number(row.cpu_millicores),
    memory_mb: Number(row.memory_mb),
    logs_text: row.logs_text ? String(row.logs_text) : null,
    created_at: String(row.created_at),
  };
}

export function listAllDeployments() {
  const db = getDb();
  const projects = db
    .prepare('SELECT id, name, created_at FROM projects ORDER BY created_at DESC')
    .all() as Array<{ id: string; name: string; created_at: string }>;

  const history = db
    .prepare(
      `SELECT d.*, p.name AS project_name
       FROM deployments d
       JOIN projects p ON p.id = d.project_id
       ORDER BY d.created_at DESC
       LIMIT 40`,
    )
    .all() as Array<Record<string, unknown>>;

  const projectSummaries = projects.map((p) => {
    const snap = db
      .prepare('SELECT id, version_num, digest FROM snapshots WHERE project_id = ? ORDER BY version_num DESC LIMIT 1')
      .get(p.id) as { id: string; version_num: number; digest: string } | undefined;
    const jobRow = snap
      ? (db
          .prepare('SELECT id, kind, status, message, result_json FROM jobs WHERE snapshot_id = ? AND kind = ?')
          .get(snap.id, 'deployment') as
          | { id: string; kind: 'deployment'; status: string; message: string; result_json: string | null }
          | undefined)
      : undefined;
    return {
      project_id: p.id,
      project_name: p.name,
      snapshot_id: snap?.id ?? '',
      version_num: snap?.version_num ?? 1,
      digest: snap?.digest ?? '',
      created_at: p.created_at,
      job: jobRow
        ? {
            id: jobRow.id,
            kind: jobRow.kind,
            status: jobRow.status,
            message: jobRow.message,
            result: jobRow.result_json ? (JSON.parse(jobRow.result_json) as DeploymentPlan) : null,
          }
        : null,
    };
  });

  return {
    projects: projectSummaries,
    history: history.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      project_name: String(row.project_name),
      snapshot_id: String(row.snapshot_id),
      version_num: Number(row.version_num),
      environment: String(row.environment),
      status: String(row.status),
      stack: String(row.stack),
      runtime_family: String(row.runtime_family),
      public_url: row.public_url ? String(row.public_url) : null,
      health_status: String(row.health_status),
      allow_outbound_network: Boolean(row.allow_outbound_network),
      cpu_millicores: Number(row.cpu_millicores),
      memory_mb: Number(row.memory_mb),
      logs_text: row.logs_text ? String(row.logs_text) : null,
      created_at: String(row.created_at),
    })),
  };
}

export function listProjectEnvVars(projectId: string): ProjectEnvVar[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id, project_id, key_name, masked_value, is_secret, created_at FROM project_env_vars WHERE project_id = ? ORDER BY key_name ASC',
    )
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    project_id: String(r.project_id),
    key_name: String(r.key_name),
    masked_value: String(r.masked_value),
    is_secret: Boolean(r.is_secret),
    created_at: String(r.created_at),
  }));
}

export function upsertProjectEnvVar(
  projectId: string,
  keyName: string,
  value: string,
  isSecret: boolean,
  actor: string,
): ProjectEnvVar {
  const db = getDb();
  const cleanKey = keyName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!cleanKey) throw new Error('Environment variable key cannot be empty.');
  const masked = isSecret
    ? value.length <= 4
      ? '••••'
      : `${value.slice(0, 2)}${'•'.repeat(Math.min(12, value.length - 2))}`
    : value;
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_env_vars (id, project_id, key_name, masked_value, raw_value, is_secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, key_name) DO UPDATE SET
       masked_value = excluded.masked_value,
       raw_value = excluded.raw_value,
       is_secret = excluded.is_secret`,
  ).run(id, projectId, cleanKey, masked, value, isSecret ? 1 : 0, createdAt);

  recordAuditLog(actor, 'ENV_VAR_UPDATED', 'project', projectId, `Configured isolated runtime variable ${cleanKey}`);
  return { id, project_id: projectId, key_name: cleanKey, masked_value: masked, is_secret: isSecret, created_at: createdAt };
}

export function deleteProjectEnvVar(projectId: string, varId: string, actor: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT key_name FROM project_env_vars WHERE id = ? AND project_id = ?')
    .get(varId, projectId) as { key_name: string } | undefined;
  const res = db.prepare('DELETE FROM project_env_vars WHERE id = ? AND project_id = ?').run(varId, projectId);
  if (Number(res.changes) > 0 && row) {
    recordAuditLog(actor, 'ENV_VAR_DELETED', 'project', projectId, `Removed runtime variable ${row.key_name}`);
    return true;
  }
  return false;
}

export function saveArchitectureBrief(snapshotId: string, brief: ArchitectureBrief): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO architecture_briefs (snapshot_id, brief_json, created_at) VALUES (?, ?, ?)').run(
    snapshotId,
    JSON.stringify(brief),
    brief.generated_at,
  );
}

export function listQAHistory(projectId: string, snapshotId?: string): QAHistoryEntry[] {
  const db = getDb();
  const rows = snapshotId
    ? (db
        .prepare(
          'SELECT id, project_id, snapshot_id, question, answer, citations_json, model, created_at FROM qa_history WHERE project_id = ? AND snapshot_id = ? ORDER BY created_at DESC LIMIT 25',
        )
        .all(projectId, snapshotId) as Array<Record<string, unknown>>)
    : (db
        .prepare(
          'SELECT id, project_id, snapshot_id, question, answer, citations_json, model, created_at FROM qa_history WHERE project_id = ? ORDER BY created_at DESC LIMIT 25',
        )
        .all(projectId) as Array<Record<string, unknown>>);

  return rows.map((r) => ({
    id: String(r.id),
    project_id: String(r.project_id),
    snapshot_id: String(r.snapshot_id),
    question: String(r.question),
    answer: String(r.answer),
    citations: JSON.parse(String(r.citations_json || '[]')),
    model: String(r.model),
    created_at: String(r.created_at),
  }));
}

export function saveQAHistory(entry: QAHistoryEntry): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO qa_history (id, project_id, snapshot_id, question, answer, citations_json, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    entry.id,
    entry.project_id,
    entry.snapshot_id,
    entry.question,
    entry.answer,
    JSON.stringify(entry.citations),
    entry.model,
    entry.created_at,
  );
}

export function getSettings(): WorkspaceSettings {
  const db = getDb();
  const row = db.prepare('SELECT value_json FROM workspace_settings WHERE key = ?').get('default') as
    | { value_json: string }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value_json) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function updateSettings(patch: Partial<WorkspaceSettings>, actor = 'workspace-admin'): WorkspaceSettings {
  const current = getSettings();
  const next: WorkspaceSettings = {
    ...current,
    ...(typeof patch.workspaceName === 'string' && patch.workspaceName.trim()
      ? { workspaceName: patch.workspaceName.trim().slice(0, 60) }
      : {}),
    ...(typeof patch.defaultExplain === 'boolean' ? { defaultExplain: patch.defaultExplain } : {}),
    ...(typeof patch.defaultDeploy === 'boolean' ? { defaultDeploy: patch.defaultDeploy } : {}),
    ...(typeof patch.defaultAllowBuildDownloads === 'boolean'
      ? { defaultAllowBuildDownloads: patch.defaultAllowBuildDownloads }
      : {}),
    ...(patch.runnerMode === 'dry-run' || patch.runnerMode === 'disabled' ? { runnerMode: patch.runnerMode } : {}),
    ...(typeof patch.pollingIntervalMs === 'number' && patch.pollingIntervalMs >= 2000 && patch.pollingIntervalMs <= 60000
      ? { pollingIntervalMs: patch.pollingIntervalMs }
      : {}),
    ...(typeof patch.storageQuotaMb === 'number' && patch.storageQuotaMb >= 50 && patch.storageQuotaMb <= 5000
      ? { storageQuotaMb: patch.storageQuotaMb }
      : {}),
    ...(typeof patch.maxProjectsQuota === 'number' && patch.maxProjectsQuota >= 5 && patch.maxProjectsQuota <= 500
      ? { maxProjectsQuota: patch.maxProjectsQuota }
      : {}),
  };
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO workspace_settings (key, value_json) VALUES (?, ?)').run(
    'default',
    JSON.stringify(next),
  );
  recordAuditLog(actor, 'SETTINGS_UPDATED', 'workspace', 'default', `Updated workspace settings (${next.runnerMode} mode)`);
  return next;
}
