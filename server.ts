import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import JSZip from 'jszip';
import multer from 'multer';
import { analyzeSnapshotBuffer, safePath } from './server/analyzer.ts';
import {
  authenticateAdmin,
  clearSessionCookie,
  createAdminAccount,
  getRequestActor,
  issueSessionCookie,
  requireAuth,
  requireMutationAuth,
  resolveSession,
} from './server/auth.ts';
import { getDatabaseTelemetry } from './server/db.ts';
import { inspectDeploymentBuffer } from './server/deployment.ts';
import { fetchGitHubArchive } from './server/intake.ts';
import { answerProjectQuestion, generateArchitectureBrief, getQAStatus } from './server/qa.ts';
import { createSampleProjectArchive } from './server/sampleProject.ts';
import {
  addDeploymentRecord,
  addProject,
  addSnapshotToProject,
  deleteProject,
  deleteProjectEnvVar,
  getAdminUser,
  getDeploymentById,
  getNextSnapshotVersion,
  getProjectDetail,
  getProjectRaw,
  getSettings,
  getSnapshot,
  initializeStore,
  listAllDeployments,
  listAuditLogs,
  listProjectEnvVars,
  listProjectsSummary,
  listQAHistory,
  recordAuditLog,
  saveArchitectureBrief,
  saveQAHistory,
  seedDemoProject,
  updateSettings,
  updateSnapshotJob,
  upsertProjectEnvVar,
} from './server/store.ts';
import type { AnalysisResult, JobRecord, ProjectRecord, SnapshotRecord } from './server/types.ts';

const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_PREVIEW_BYTES = 512 * 1024;
const MAX_SOURCE_PREVIEW_LINES = 200;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 2000,
  },
});

async function buildArchiveFromUpload(
  archiveFile: Express.Multer.File | undefined,
  folderFiles: Express.Multer.File[],
  rawPaths: string | string[] | undefined,
): Promise<{ buffer: Buffer; fileCount: number; totalBytes: number; defaultName: string; sourceType: 'zip' | 'folder' }> {
  if (archiveFile) {
    const zip = await JSZip.loadAsync(archiveFile.buffer);
    let fileCount = 0;
    let totalBytes = 0;
    const cleanZip = new JSZip();

    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      let normalized: string;
      try {
        normalized = safePath(entry.name);
      } catch {
        continue;
      }
      const bytes = await entry.async('nodebuffer');
      cleanZip.file(normalized, bytes);
      fileCount += 1;
      totalBytes += bytes.length;
    }

    if (fileCount === 0) {
      throw new Error('The uploaded ZIP archive did not contain any readable files.');
    }

    const buffer = await cleanZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return {
      buffer,
      fileCount,
      totalBytes,
      defaultName: archiveFile.originalname.replace(/\.zip$/i, '') || 'Uploaded project',
      sourceType: 'zip',
    };
  }

  if (folderFiles.length > 0) {
    const pathList = Array.isArray(rawPaths) ? rawPaths : rawPaths ? [rawPaths] : [];
    const zip = new JSZip();
    let fileCount = 0;
    let totalBytes = 0;
    let firstRoot = '';

    for (let i = 0; i < folderFiles.length; i += 1) {
      const file = folderFiles[i];
      const rawRelative = pathList[i] || file.originalname;
      let normalized: string;
      try {
        normalized = safePath(rawRelative);
      } catch {
        continue;
      }
      if (!firstRoot && normalized.includes('/')) {
        firstRoot = normalized.split('/')[0];
      }
      zip.file(normalized, file.buffer);
      fileCount += 1;
      totalBytes += file.buffer.length;
    }

    if (fileCount === 0) {
      throw new Error('No valid files were found in the selected folder.');
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return {
      buffer,
      fileCount,
      totalBytes,
      defaultName: firstRoot || 'Folder project',
      sourceType: 'folder',
    };
  }

  throw new Error('Select a ZIP archive, a project folder, paste a GitHub repository URL, or load the sample project.');
}

async function createServer() {
  await initializeStore();

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  // Auth endpoints
  app.get('/api/auth/status', (_req, res) => {
    const admin = getAdminUser();
    res.json({
      setup_required: !admin,
      demo_available: true,
      admin_username: admin?.username ?? null,
    });
  });

  app.post('/api/auth/setup', (req, res) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        res.status(400).json({ detail: 'Username and password are required.' });
        return;
      }
      const user = createAdminAccount(username, password);
      const session = issueSessionCookie(res, user.id, user.username);
      res.json({ username: session.username, csrf_token: session.csrfToken });
    } catch (err) {
      res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not complete setup.' });
    }
  });

  app.post('/api/auth/quick-demo', (_req, res) => {
    let admin = getAdminUser();
    if (!admin) {
      admin = createAdminAccount('workspace-admin', 'codemind-workspace-local');
    }
    const session = issueSessionCookie(res, admin.id, admin.username);
    res.json({ username: session.username, csrf_token: session.csrfToken });
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ detail: 'Username and password are required.' });
      return;
    }
    const user = authenticateAdmin(username, password);
    if (!user) {
      res.status(401).json({ detail: 'Invalid administrator credentials.' });
      return;
    }
    const session = issueSessionCookie(res, user.id, user.username);
    res.json({ username: session.username, csrf_token: session.csrfToken });
  });

  app.get('/api/auth/session', (req, res) => {
    const session = resolveSession(req);
    if (!session) {
      res.status(401).json({ detail: 'Not signed in.' });
      return;
    }
    res.json({
      username: session.username,
      csrf_token: session.csrfToken,
      expires_at: session.expiresAt,
    });
  });

  app.post('/api/auth/logout', requireMutationAuth, (req, res) => {
    clearSessionCookie(req, res);
    res.json({ logged_out: true });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'codemind-api', database: 'sqlite3' });
  });

  // Database & Audit Telemetry
  app.get('/api/database/stats', requireAuth, (_req, res) => {
    res.json({
      ...getDatabaseTelemetry(),
      quotas: {
        max_projects: getSettings().maxProjectsQuota,
        storage_quota_mb: getSettings().storageQuotaMb,
      },
    });
  });

  app.get('/api/audit-logs', requireAuth, (req, res) => {
    const limit = Math.min(200, Math.max(10, Number(req.query.limit ?? 80) || 80));
    res.json(listAuditLogs(limit));
  });

  // Workspace Settings
  app.get('/api/settings', requireAuth, (_req, res) => {
    res.json({
      ...getSettings(),
      qa: getQAStatus(),
    });
  });

  app.put('/api/settings', requireMutationAuth, (req, res) => {
    const actor = getRequestActor(req);
    const updated = updateSettings(req.body ?? {}, actor);
    res.json({
      ...updated,
      qa: getQAStatus(),
    });
  });

  app.post('/api/workspace/reset-demo', requireMutationAuth, async (req, res) => {
    const actor = getRequestActor(req);
    const project = await seedDemoProject(actor);
    res.json({ project: getProjectDetail(project.id) });
  });

  // Projects & Snapshots
  app.get('/api/projects', requireAuth, (_req, res) => {
    res.json(listProjectsSummary());
  });

  app.get('/api/projects/:id', requireAuth, (req, res) => {
    const detail = getProjectDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ detail: 'Project not found.' });
      return;
    }
    res.json(detail);
  });

  app.delete('/api/projects/:id', requireMutationAuth, (req, res) => {
    const actor = getRequestActor(req);
    const removed = deleteProject(String(req.params.id), actor);
    if (!removed) {
      res.status(404).json({ detail: 'Project not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  app.post(
    '/api/projects',
    requireMutationAuth,
    upload.fields([
      { name: 'archive', maxCount: 1 },
      { name: 'files', maxCount: 2000 },
    ]),
    async (req, res) => {
      try {
        const actor = getRequestActor(req);
        const settings = getSettings();
        const existingProjects = listProjectsSummary();
        if (existingProjects.length >= settings.maxProjectsQuota) {
          res.status(429).json({
            detail: `Workspace project quota reached (${settings.maxProjectsQuota} projects). Delete a project or increase quota in Settings.`,
          });
          return;
        }

        const analyze = String(req.body?.analyze ?? 'true') === 'true';
        const deploy = String(req.body?.deploy ?? 'false') === 'true';
        const allowOutbound = String(req.body?.allow_outbound_network ?? 'false') === 'true';
        const useSample = String(req.body?.sample ?? 'false') === 'true';
        const githubUrl = typeof req.body?.github_url === 'string' ? req.body.github_url.trim() : '';

        if (!analyze && !deploy) {
          res.status(400).json({ detail: 'Select Explain project, Deploy project, or both.' });
          return;
        }

        const uploaded = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
        const archiveFile = uploaded?.archive?.[0];
        const folderFiles = uploaded?.files ?? [];

        let archiveBuffer: Buffer;
        let fileCount: number;
        let totalBytes: number;
        let digest: string;
        let defaultName: string;
        let sourceType: 'zip' | 'folder' | 'github' | 'sample';
        let repoUrl: string | null = null;

        if (useSample) {
          const sample = await createSampleProjectArchive();
          archiveBuffer = sample.buffer;
          fileCount = sample.fileCount;
          totalBytes = sample.totalBytes;
          digest = sample.digest;
          defaultName = 'inventory-pulse-sample';
          sourceType = 'sample';
        } else if (githubUrl) {
          const gh = await fetchGitHubArchive(githubUrl);
          archiveBuffer = gh.buffer;
          fileCount = gh.fileCount;
          totalBytes = gh.totalBytes;
          digest = gh.digest;
          defaultName = gh.defaultName;
          sourceType = 'github';
          repoUrl = gh.sourceRef;
        } else {
          const built = await buildArchiveFromUpload(archiveFile, folderFiles, req.body?.paths);
          archiveBuffer = built.buffer;
          fileCount = built.fileCount;
          totalBytes = built.totalBytes;
          digest = crypto.createHash('sha256').update(archiveBuffer).digest('hex');
          defaultName = built.defaultName;
          sourceType = built.sourceType;
        }

        const rawName = typeof req.body?.project_name === 'string' ? req.body.project_name.trim() : '';
        const name = (rawName || defaultName || 'New project').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);

        const projectId = crypto.randomUUID();
        const snapshotId = crypto.randomUUID();
        const nowIso = new Date().toISOString();
        const jobs: JobRecord[] = [];
        let deploymentRecordToSave: {
          id: string;
          plan: Awaited<ReturnType<typeof inspectDeploymentBuffer>>;
        } | null = null;

        if (analyze) {
          const analysis = await analyzeSnapshotBuffer(archiveBuffer);
          jobs.push({
            id: crypto.randomUUID(),
            kind: 'analysis',
            status: 'completed',
            message: 'Static project analysis is ready. See parser coverage and limitations in the results.',
            created_at: nowIso,
            updated_at: nowIso,
            result: analysis,
          });
        }

        if (deploy) {
          const depId = crypto.randomUUID();
          const plan = await inspectDeploymentBuffer(
            archiveBuffer,
            snapshotId,
            digest,
            allowOutbound,
            settings.runnerMode === 'dry-run',
            depId,
            0,
          );
          jobs.push({
            id: crypto.randomUUID(),
            kind: 'deployment',
            status: plan.status,
            message: plan.reason,
            created_at: nowIso,
            updated_at: nowIso,
            result: plan,
          });
          deploymentRecordToSave = { id: depId, plan };
        }

        const snapshot: SnapshotRecord = {
          id: snapshotId,
          project_id: projectId,
          version_num: 1,
          digest,
          file_count: fileCount,
          total_bytes: totalBytes,
          created_at: nowIso,
          archive_base64: archiveBuffer.toString('base64'),
          jobs,
        };

        const project: ProjectRecord = {
          id: projectId,
          name,
          source_type: sourceType,
          repo_url: repoUrl,
          created_at: nowIso,
          snapshots: [snapshot],
        };

        addProject(project, actor);

        if (deploymentRecordToSave) {
          const primary = deploymentRecordToSave.plan.candidates[0];
          addDeploymentRecord({
            id: deploymentRecordToSave.id,
            project_id: projectId,
            project_name: name,
            snapshot_id: snapshotId,
            version_num: 1,
            environment: 'isolated-sandbox',
            status: deploymentRecordToSave.plan.status,
            stack: primary?.stack ?? 'Unrecognized stack',
            runtime_family: primary?.runtime_family ?? 'unknown',
            public_url: deploymentRecordToSave.plan.runner?.url ?? null,
            health_status: deploymentRecordToSave.plan.runner?.health_status ?? 'pending',
            allow_outbound_network: allowOutbound,
            cpu_millicores: deploymentRecordToSave.plan.limits?.cpu_millicores ?? 500,
            memory_mb: deploymentRecordToSave.plan.limits?.memory_mb ?? 512,
            logs_text: deploymentRecordToSave.plan.runner?.logs ?? null,
            created_at: nowIso,
          });
        }

        res.json(getProjectDetail(projectId));
      } catch (err) {
        res.status(400).json({ detail: err instanceof Error ? err.message : 'Project upload failed.' });
      }
    },
  );

  // Add new versioned snapshot to existing project (GitHub re-sync or new ZIP)
  app.post(
    '/api/projects/:id/snapshots',
    requireMutationAuth,
    upload.fields([
      { name: 'archive', maxCount: 1 },
      { name: 'files', maxCount: 2000 },
    ]),
    async (req, res) => {
      try {
        const actor = getRequestActor(req);
        const project = getProjectRaw(String(req.params.id));
        if (!project) {
          res.status(404).json({ detail: 'Project not found.' });
          return;
        }
        const githubUrl =
          typeof req.body?.github_url === 'string' && req.body.github_url.trim()
            ? req.body.github_url.trim()
            : project.repo_url ?? '';

        const uploaded = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
        const archiveFile = uploaded?.archive?.[0];
        const folderFiles = uploaded?.files ?? [];

        let archiveBuffer: Buffer;
        let fileCount: number;
        let totalBytes: number;
        let digest: string;

        if (!archiveFile && folderFiles.length === 0 && githubUrl) {
          const gh = await fetchGitHubArchive(githubUrl);
          archiveBuffer = gh.buffer;
          fileCount = gh.fileCount;
          totalBytes = gh.totalBytes;
          digest = gh.digest;
        } else {
          const built = await buildArchiveFromUpload(archiveFile, folderFiles, req.body?.paths);
          archiveBuffer = built.buffer;
          fileCount = built.fileCount;
          totalBytes = built.totalBytes;
          digest = crypto.createHash('sha256').update(archiveBuffer).digest('hex');
        }

        const versionNum = getNextSnapshotVersion(project.id);
        const snapshotId = crypto.randomUUID();
        const nowIso = new Date().toISOString();
        const analysis = await analyzeSnapshotBuffer(archiveBuffer);
        const jobs: JobRecord[] = [
          {
            id: crypto.randomUUID(),
            kind: 'analysis',
            status: 'completed',
            message: `Static analysis completed for snapshot v${versionNum}.`,
            created_at: nowIso,
            updated_at: nowIso,
            result: analysis,
          },
        ];

        addSnapshotToProject(project.id, {
          id: snapshotId,
          project_id: project.id,
          version_num: versionNum,
          digest,
          file_count: fileCount,
          total_bytes: totalBytes,
          created_at: nowIso,
          archive_base64: archiveBuffer.toString('base64'),
          jobs,
        });

        recordAuditLog(
          actor,
          'SNAPSHOT_VERSION_ADDED',
          'snapshot',
          snapshotId,
          `Created snapshot v${versionNum} for "${project.name}" (${fileCount} files)`,
        );

        res.json(getProjectDetail(project.id));
      } catch (err) {
        res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not add new snapshot.' });
      }
    },
  );

  app.post('/api/projects/:id/reanalyze', requireMutationAuth, async (req, res) => {
    const actor = getRequestActor(req);
    const project = getProjectRaw(String(req.params.id));
    const snapshotId = typeof req.body?.snapshot_id === 'string' ? req.body.snapshot_id : undefined;
    const snapshot = getSnapshot(String(req.params.id), snapshotId);
    if (!project || !snapshot) {
      res.status(404).json({ detail: 'Project snapshot not found.' });
      return;
    }
    const analysis = await analyzeSnapshotBuffer(Buffer.from(snapshot.archive_base64, 'base64'));
    const nowIso = new Date().toISOString();
    updateSnapshotJob(project.id, snapshot.id, {
      id: crypto.randomUUID(),
      kind: 'analysis',
      status: 'completed',
      message: `Static project analysis refreshed for v${snapshot.version_num}.`,
      created_at: nowIso,
      updated_at: nowIso,
      result: analysis,
    });
    recordAuditLog(actor, 'ANALYSIS_COMPLETED', 'snapshot', snapshot.id, `Analyzed ${project.name} v${snapshot.version_num}`);
    res.json(getProjectDetail(project.id));
  });

  app.post('/api/projects/:id/ai-brief', requireMutationAuth, async (req, res) => {
    try {
      const actor = getRequestActor(req);
      const project = getProjectRaw(String(req.params.id));
      const snapshotId = typeof req.body?.snapshot_id === 'string' ? req.body.snapshot_id : undefined;
      const snapshot = getSnapshot(String(req.params.id), snapshotId);
      if (!project || !snapshot) {
        res.status(404).json({ detail: 'Project snapshot not found.' });
        return;
      }
      const analysisJob = snapshot.jobs.find((j) => j.kind === 'analysis');
      const analysis = analysisJob?.result as AnalysisResult | undefined;
      if (!analysis || !('files' in analysis)) {
        res.status(400).json({ detail: 'Run static analysis first before generating an architecture brief.' });
        return;
      }
      const brief = await generateArchitectureBrief(project.name, snapshot, analysis);
      saveArchitectureBrief(snapshot.id, brief);
      recordAuditLog(actor, 'AI_BRIEF_GENERATED', 'snapshot', snapshot.id, `Generated Gemini architecture brief for ${project.name} v${snapshot.version_num}`);
      res.json(brief);
    } catch (err) {
      res.status(502).json({ detail: err instanceof Error ? err.message : 'Could not generate architecture brief.' });
    }
  });

  app.post('/api/projects/:id/deploy', requireMutationAuth, async (req, res) => {
    const actor = getRequestActor(req);
    const project = getProjectRaw(String(req.params.id));
    const snapshotId = typeof req.body?.snapshot_id === 'string' ? req.body.snapshot_id : undefined;
    const snapshot = getSnapshot(String(req.params.id), snapshotId);
    if (!project || !snapshot) {
      res.status(404).json({ detail: 'Project snapshot not found.' });
      return;
    }
    const allowOutbound = Boolean(req.body?.allow_outbound_network);
    const runDryCheck = req.body?.dry_run !== false;
    const deploymentId = crypto.randomUUID();
    const envVars = listProjectEnvVars(project.id);

    const plan = await inspectDeploymentBuffer(
      Buffer.from(snapshot.archive_base64, 'base64'),
      snapshot.id,
      snapshot.digest,
      allowOutbound,
      runDryCheck,
      deploymentId,
      envVars.length,
    );
    const nowIso = new Date().toISOString();
    updateSnapshotJob(project.id, snapshot.id, {
      id: crypto.randomUUID(),
      kind: 'deployment',
      status: plan.status,
      message: plan.reason,
      created_at: nowIso,
      updated_at: nowIso,
      result: plan,
    });

    const primary = plan.candidates[0];
    addDeploymentRecord({
      id: deploymentId,
      project_id: project.id,
      project_name: project.name,
      snapshot_id: snapshot.id,
      version_num: snapshot.version_num,
      environment: 'isolated-sandbox',
      status: plan.status,
      stack: primary?.stack ?? 'Unrecognized stack',
      runtime_family: primary?.runtime_family ?? 'unknown',
      public_url: plan.runner?.url ?? null,
      health_status: plan.runner?.health_status ?? 'pending',
      allow_outbound_network: allowOutbound,
      cpu_millicores: plan.limits?.cpu_millicores ?? 500,
      memory_mb: plan.limits?.memory_mb ?? 512,
      logs_text: plan.runner?.logs ?? null,
      created_at: nowIso,
    });

    recordAuditLog(
      actor,
      'DEPLOYMENT_RUN',
      'deployment',
      deploymentId,
      `Deployment ${plan.status} for ${project.name} v${snapshot.version_num} (${primary?.stack ?? 'unknown'})`,
    );

    res.json(getProjectDetail(project.id));
  });

  app.post('/api/deployments/:deploymentId/rollback', requireMutationAuth, async (req, res) => {
    const actor = getRequestActor(req);
    const previous = getDeploymentById(String(req.params.deploymentId));
    if (!previous) {
      res.status(404).json({ detail: 'Deployment record not found.' });
      return;
    }
    const snapshot = getSnapshot(previous.project_id, previous.snapshot_id);
    if (!snapshot) {
      res.status(404).json({ detail: 'Target snapshot no longer exists.' });
      return;
    }
    const deploymentId = crypto.randomUUID();
    const envVars = listProjectEnvVars(previous.project_id);
    const plan = await inspectDeploymentBuffer(
      Buffer.from(snapshot.archive_base64, 'base64'),
      snapshot.id,
      snapshot.digest,
      previous.allow_outbound_network,
      true,
      deploymentId,
      envVars.length,
    );
    const nowIso = new Date().toISOString();
    updateSnapshotJob(previous.project_id, snapshot.id, {
      id: crypto.randomUUID(),
      kind: 'deployment',
      status: plan.status,
      message: `Rolled back to snapshot v${snapshot.version_num}: ${plan.reason}`,
      created_at: nowIso,
      updated_at: nowIso,
      result: plan,
    });
    const primary = plan.candidates[0];
    addDeploymentRecord({
      id: deploymentId,
      project_id: previous.project_id,
      project_name: previous.project_name,
      snapshot_id: snapshot.id,
      version_num: snapshot.version_num,
      environment: previous.environment,
      status: plan.status,
      stack: primary?.stack ?? previous.stack,
      runtime_family: primary?.runtime_family ?? previous.runtime_family,
      public_url: plan.runner?.url ?? null,
      health_status: plan.runner?.health_status ?? 'healthy',
      allow_outbound_network: previous.allow_outbound_network,
      cpu_millicores: plan.limits?.cpu_millicores ?? 500,
      memory_mb: plan.limits?.memory_mb ?? 512,
      logs_text: `[ROLLBACK from deployment ${previous.id.slice(0, 8)} to v${snapshot.version_num}]\n${plan.runner?.logs ?? ''}`,
      created_at: nowIso,
    });
    recordAuditLog(
      actor,
      'DEPLOYMENT_ROLLBACK',
      'deployment',
      deploymentId,
      `Rolled back ${previous.project_name} to snapshot v${snapshot.version_num}`,
    );
    res.json(listAllDeployments());
  });

  app.get('/api/deployments/:deploymentId/health', requireAuth, (req, res) => {
    const dep = getDeploymentById(String(req.params.deploymentId));
    if (!dep) {
      res.status(404).json({ status: 'not_found' });
      return;
    }
    res.json({
      deployment_id: dep.id,
      project_name: dep.project_name,
      snapshot_id: dep.snapshot_id,
      version: `v${dep.version_num}`,
      stack: dep.stack,
      status: dep.status,
      health_status: dep.health_status,
      limits: { cpu_millicores: dep.cpu_millicores, memory_mb: dep.memory_mb },
      checked_at: new Date().toISOString(),
    });
  });

  app.get('/api/deployments', requireAuth, (_req, res) => {
    res.json(listAllDeployments());
  });

  // Project Runtime Env Vars
  app.get('/api/projects/:id/env', requireAuth, (req, res) => {
    res.json(listProjectEnvVars(String(req.params.id)));
  });

  app.post('/api/projects/:id/env', requireMutationAuth, (req, res) => {
    try {
      const actor = getRequestActor(req);
      const { key_name, key, value, is_secret } = req.body ?? {};
      const resolvedKey = typeof key_name === 'string' ? key_name : typeof key === 'string' ? key : '';
      if (!resolvedKey.trim() || typeof value !== 'string') {
        res.status(400).json({ detail: 'Variable key and value are required.' });
        return;
      }
      const created = upsertProjectEnvVar(
        String(req.params.id),
        resolvedKey,
        value,
        is_secret !== false,
        actor,
      );
      res.json(created);
    } catch (err) {
      res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not save environment variable.' });
    }
  });

  app.delete('/api/projects/:id/env/:varId', requireMutationAuth, (req, res) => {
    const actor = getRequestActor(req);
    const removed = deleteProjectEnvVar(String(req.params.id), String(req.params.varId), actor);
    if (!removed) {
      res.status(404).json({ detail: 'Variable not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  // Source preview
  app.get('/api/projects/:id/source', requireAuth, async (req, res) => {
    const projectId = String(req.params.id);
    const snapshotId = typeof req.query.snapshot_id === 'string' ? req.query.snapshot_id : undefined;
    const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
    const startLine = Math.max(1, Number(req.query.start_line ?? 1) || 1);
    const endLineParam = req.query.end_line ? Number(req.query.end_line) : undefined;

    const snapshot = getSnapshot(projectId, snapshotId);
    if (!snapshot) {
      res.status(404).json({ detail: 'Project snapshot not found.' });
      return;
    }

    let normalized: string;
    try {
      normalized = safePath(rawPath);
    } catch {
      res.status(400).json({ detail: 'Invalid file path requested.' });
      return;
    }

    const zip = await JSZip.loadAsync(Buffer.from(snapshot.archive_base64, 'base64'));
    const entry = zip.file(normalized);
    if (!entry || entry.dir) {
      res.status(404).json({ detail: 'Source file not found in this snapshot.' });
      return;
    }

    const rawBytes = await entry.async('nodebuffer');
    if (rawBytes.length > MAX_SOURCE_PREVIEW_BYTES || rawBytes.includes(0)) {
      res.status(413).json({ detail: 'This file is too large or binary and cannot be previewed as text.' });
      return;
    }

    const content = rawBytes.toString('utf8');
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    const clampedStart = Math.min(startLine, Math.max(1, totalLines));
    const requestedEnd = endLineParam ?? clampedStart + MAX_SOURCE_PREVIEW_LINES - 1;
    const clampedEnd = Math.min(
      Math.max(clampedStart, requestedEnd),
      clampedStart + MAX_SOURCE_PREVIEW_LINES - 1,
      totalLines,
    );

    res.json({
      path: normalized,
      snapshot_id: snapshot.id,
      digest: snapshot.digest,
      start_line: clampedStart,
      end_line: clampedEnd,
      total_lines: totalLines,
      lines: Array.from({ length: clampedEnd - clampedStart + 1 }, (_, i) => ({
        number: clampedStart + i,
        text: lines[clampedStart + i - 1] ?? '',
      })),
    });
  });

  // Q&A routes with persistent history
  app.get('/api/qa/status', requireAuth, (_req, res) => {
    res.json(getQAStatus());
  });

  app.get('/api/projects/:id/qa', requireAuth, (req, res) => {
    const snapshotId = typeof req.query.snapshot_id === 'string' ? req.query.snapshot_id : undefined;
    res.json(listQAHistory(String(req.params.id), snapshotId));
  });

  app.post('/api/projects/:id/ask', requireMutationAuth, async (req, res) => {
    try {
      const actor = getRequestActor(req);
      const project = getProjectRaw(String(req.params.id));
      const { snapshot_id, question } = req.body ?? {};
      const snapshot = getSnapshot(String(req.params.id), typeof snapshot_id === 'string' ? snapshot_id : undefined);
      if (!project || !snapshot) {
        res.status(404).json({ detail: 'Project snapshot not found.' });
        return;
      }
      if (typeof question !== 'string' || !question.trim()) {
        res.status(400).json({ detail: 'Please provide a question.' });
        return;
      }
      const answer = await answerProjectQuestion(project.name, snapshot, question);
      saveQAHistory({
        id: crypto.randomUUID(),
        project_id: project.id,
        snapshot_id: snapshot.id,
        question: question.trim(),
        answer: answer.answer,
        citations: answer.citations,
        model: answer.model,
        created_at: new Date().toISOString(),
      });
      recordAuditLog(actor, 'QA_ASKED', 'snapshot', snapshot.id, `Answered source-grounded question for ${project.name}`);
      res.json(answer);
    } catch (err) {
      res.status(502).json({ detail: err instanceof Error ? err.message : 'Could not answer this question.' });
    }
  });

  // Frontend serving (Vite dev middleware or production dist/)
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.use((_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CodeMind AI workspace listening on http://0.0.0.0:${PORT}`);
  });
}

void createServer();
