import { ChangeEvent, DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  CircleHelp,
  Code2,
  Database,
  Download,
  FileArchive,
  FolderGit2,
  GitBranch,
  KeyRound,
  Layers3,
  LockKeyhole,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AnalysisExplorer, ArchitectureGraph, type AnalysisResult } from './AnalysisExplorer';
import './NetworkConsent.css';
import { ProjectQA } from './ProjectQA';

type PipelineStage = {
  name: string;
  status: 'passed' | 'blocked' | 'failed' | 'skipped';
  duration_ms: number;
  detail: string;
};

type Job = {
  id: string;
  kind: 'analysis' | 'deployment';
  status: string;
  message: string;
  result?: AnalysisResult | DeploymentPlanView | null;
};

type DeploymentPlanView = {
  status?: string;
  reason?: string;
  snapshot_id?: string;
  source_digest?: string;
  allow_outbound_network?: boolean;
  candidates?: {
    stack: string;
    runtime_family: string;
    build_recipe_id?: string | null;
    start_recipe_id?: string | null;
    package_manager?: string | null;
    entrypoint_hint?: string | null;
    manifest_paths?: string[];
    confidence?: string;
    notes?: string[];
  }[];
  stages?: PipelineStage[];
  limits?: {
    cpu_millicores: number;
    memory_mb: number;
    disk_mb: number;
    timeout_seconds: number;
  };
  requires_isolated_runner?: boolean;
  requires_review?: boolean;
  runner?: {
    status?: string;
    message?: string;
    url?: string | null;
    health_status?: string;
    logs?: string | null;
    checked_at?: string;
  };
};

type ArchitectureBrief = {
  summary: string;
  entrypoints: string[];
  core_modules: string[];
  data_flow: string;
  risks_and_notes: string[];
  model: string;
  generated_at: string;
};

type SnapshotInfo = {
  id: string;
  version_num: number;
  digest: string;
  file_count: number;
  total_bytes: number;
  created_at: string;
  brief?: ArchitectureBrief | null;
  jobs: Job[];
};

type Project = {
  id: string;
  name: string;
  source_type?: 'zip' | 'folder' | 'github' | 'sample';
  repo_url?: string | null;
  created_at: string;
  snapshot_id?: string;
  version_num?: number;
  snapshot_count?: number;
  digest?: string;
  file_count?: number;
  total_bytes?: number;
  jobs?: Job[];
  snapshots?: SnapshotInfo[];
};

type DeploymentHistoryItem = {
  id: string;
  project_id: string;
  project_name: string;
  snapshot_id: string;
  version_num: number;
  environment: string;
  status: string;
  stack: string;
  runtime_family: string;
  public_url: string | null;
  health_status: string;
  allow_outbound_network: boolean;
  cpu_millicores: number;
  memory_mb: number;
  logs_text: string | null;
  created_at: string;
};

type DeploymentListItem = {
  project_id: string;
  project_name: string;
  snapshot_id: string;
  version_num: number;
  digest: string;
  created_at: string;
  job: Job | null;
};

type ProjectEnvVar = {
  id: string;
  project_id: string;
  key_name: string;
  masked_value: string;
  is_secret: boolean;
  created_at: string;
};

type AuditLogEntry = {
  id: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: string;
  created_at: string;
};

type DatabaseTelemetry = {
  engine: string;
  path: string;
  db_file_bytes: number;
  total_snapshot_bytes: number;
  table_counts: Record<string, number>;
  quotas: { max_projects: number; storage_quota_mb: number };
};

type WorkspaceSettings = {
  workspaceName: string;
  defaultExplain: boolean;
  defaultDeploy: boolean;
  defaultAllowBuildDownloads: boolean;
  runnerMode: 'dry-run' | 'disabled';
  pollingIntervalMs: number;
  storageQuotaMb: number;
  maxProjectsQuota: number;
  qa?: { configured: boolean; model: string };
};

type NavSection = 'projects' | 'graph' | 'deployments' | 'database' | 'settings' | 'help';
type IntakeMode = 'upload' | 'github';

const API_URL = import.meta.env.VITE_API_URL ?? '';

function normalizeProjectDetail(data: Project): Project {
  const firstSnap = data.snapshots?.[0];
  return {
    ...data,
    snapshot_id: firstSnap?.id ?? data.snapshot_id,
    version_num: firstSnap?.version_num ?? data.version_num,
    digest: firstSnap?.digest ?? data.digest,
    file_count: firstSnap?.file_count ?? data.file_count,
    total_bytes: firstSnap?.total_bytes ?? data.total_bytes,
    jobs: firstSnap?.jobs ?? data.jobs ?? [],
  };
}

function App({
  csrfToken,
  onLogout,
  username,
}: {
  csrfToken: string;
  onLogout: () => Promise<void>;
  username: string;
}) {
  const [activeSection, setActiveSection] = useState<NavSection>('projects');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [activeSnapshotId, setActiveSnapshotId] = useState<string>('');
  const [explorerInitialView, setExplorerInitialView] = useState<'files' | 'graph'>('files');
  const [graphProjectDetail, setGraphProjectDetail] = useState<Project | null>(null);
  const [graphSelectedPath, setGraphSelectedPath] = useState('');
  const [deploymentsData, setDeploymentsData] = useState<{
    projects: DeploymentListItem[];
    history: DeploymentHistoryItem[];
  }>({ projects: [], history: [] });
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [dbStats, setDbStats] = useState<DatabaseTelemetry | null>(null);
  const [settings, setSettings] = useState<WorkspaceSettings>({
    workspaceName: 'My workspace',
    defaultExplain: true,
    defaultDeploy: false,
    defaultAllowBuildDownloads: false,
    runnerMode: 'dry-run',
    pollingIntervalMs: 5000,
    storageQuotaMb: 500,
    maxProjectsQuota: 50,
  });

  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [intakeMode, setIntakeMode] = useState<IntakeMode>('upload');
  const [githubUrl, setGithubUrl] = useState('');
  const [explain, setExplain] = useState(true);
  const [deploy, setDeploy] = useState(false);
  const [allowBuildDownloads, setAllowBuildDownloads] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');

  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(event.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/projects`, { credentials: 'same-origin' });
      if (response.status === 401) {
        window.location.reload();
        return [];
      }
      if (!response.ok) throw new Error('Could not load projects');
      const items: Project[] = await response.json();
      setProjects(items);
      return items;
    } catch {
      setError('API is not connected. Start the CodeMind API to create and analyze projects.');
      return [];
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/settings`, { credentials: 'same-origin' });
      if (!response.ok) return;
      const data: WorkspaceSettings = await response.json();
      setSettings(data);
      setExplain(data.defaultExplain);
      setDeploy(data.defaultDeploy);
      setAllowBuildDownloads(data.defaultAllowBuildDownloads);
    } catch {
      // Keep default local settings
    }
  }, []);

  const refreshDeployments = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/deployments`, { credentials: 'same-origin' });
      if (!response.ok) return;
      const data = await response.json();
      if (data && Array.isArray(data.projects)) {
        setDeploymentsData(data);
      }
    } catch {
      // Ignore transient error
    }
  }, []);

  const refreshDatabaseAndAudit = useCallback(async () => {
    try {
      const [statsRes, logsRes] = await Promise.all([
        fetch(`${API_URL}/api/database/stats`, { credentials: 'same-origin' }),
        fetch(`${API_URL}/api/audit-logs?limit=100`, { credentials: 'same-origin' }),
      ]);
      if (statsRes.ok) setDbStats(await statsRes.json());
      if (logsRes.ok) setAuditLogs(await logsRes.json());
    } catch {
      // Ignore transient error
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
    void refreshSettings();
    void refreshDeployments();
    void refreshDatabaseAndAudit();
  }, [refreshProjects, refreshSettings, refreshDeployments, refreshDatabaseAndAudit]);

  const loadProjectDetail = useCallback(async (projectId: string): Promise<Project | null> => {
    try {
      const response = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}`, {
        credentials: 'same-origin',
      });
      if (response.status === 401) {
        window.location.reload();
        return null;
      }
      if (!response.ok) return null;
      const data = (await response.json()) as Project;
      return normalizeProjectDetail(data);
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void loadProjectDetail(selectedProject.id).then((latest) => {
        if (alive && latest) setSelectedProject(latest);
      });
    }, settings.pollingIntervalMs || 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [selectedProject?.id, loadProjectDetail, settings.pollingIntervalMs]);

  useEffect(() => {
    if (activeSection !== 'graph') return;
    const targetId = selectedProject?.id ?? graphProjectDetail?.id ?? projects[0]?.id;
    if (!targetId) {
      setGraphProjectDetail(null);
      return;
    }
    let alive = true;
    void loadProjectDetail(targetId).then((detail) => {
      if (alive && detail) setGraphProjectDetail(detail);
    });
    return () => {
      alive = false;
    };
  }, [activeSection, selectedProject?.id, projects, loadProjectDetail]);

  useEffect(() => {
    if (activeSection === 'deployments') void refreshDeployments();
    if (activeSection === 'database') void refreshDatabaseAndAudit();
  }, [activeSection, refreshDeployments, refreshDatabaseAndAudit]);

  const filteredProjects = useMemo(
    () => projects.filter((project) => project.name.toLowerCase().includes(query.toLowerCase())),
    [projects, query],
  );

  function clearSource() {
    setZipFile(null);
    setFolderFiles([]);
    if (zipInput.current) zipInput.current.value = '';
    if (folderInput.current) folderInput.current.value = '';
  }

  function selectZip(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setZipFile(file);
    setFolderFiles([]);
    setProjectName((value) => value || file.name.replace(/\.zip$/i, ''));
    setError('');
  }

  function selectFolder(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setFolderFiles(files);
    setZipFile(null);
    setProjectName((value) => value || files[0].webkitRelativePath.split('/')[0] || 'New project');
    setError('');
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    const zip = files.find((file) => file.name.toLowerCase().endsWith('.zip'));
    if (zip) {
      setZipFile(zip);
      setFolderFiles([]);
      setProjectName((value) => value || zip.name.replace(/\.zip$/i, ''));
    } else if (files.length) {
      setError(
        'For folder drag and drop, choose “Select project folder” so relative paths are preserved. You can also drop a ZIP here.',
      );
    }
  }

  async function startProject(mode: 'upload' | 'github' | 'sample') {
    if (!explain && !deploy) {
      setError('Choose Explain project, Deploy project, or both.');
      return;
    }
    if (mode === 'upload' && !zipFile && folderFiles.length === 0) {
      setError('Select a ZIP archive or a project folder first.');
      return;
    }
    if (mode === 'github' && !githubUrl.trim()) {
      setError('Enter a public GitHub repository URL.');
      return;
    }

    setUploading(true);
    setError('');
    setNotice('');
    const form = new FormData();
    if (mode === 'sample') {
      form.append('sample', 'true');
      form.append('project_name', projectName.trim() || `sample-snapshot-${projects.length + 1}`);
    } else if (mode === 'github') {
      form.append('github_url', githubUrl.trim());
      if (projectName.trim()) form.append('project_name', projectName.trim());
    } else {
      if (zipFile) form.append('archive', zipFile);
      else {
        folderFiles.forEach((file) => {
          form.append('files', file, file.name);
          form.append('paths', file.webkitRelativePath);
        });
      }
      form.append('project_name', projectName.trim() || 'New project');
    }
    form.append('analyze', String(explain));
    form.append('deploy', String(deploy));
    form.append('allow_outbound_network', String(deploy && allowBuildDownloads));

    try {
      const response = await fetch(`${API_URL}/api/projects`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrfToken },
        body: form,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail ?? 'Project intake failed');
      const normalized = normalizeProjectDetail(result as Project);
      await Promise.all([refreshProjects(), refreshDeployments(), refreshDatabaseAndAudit()]);
      setExplorerInitialView('files');
      setSelectedProject(normalized);
      setActiveSnapshotId(normalized.snapshots?.[0]?.id ?? '');
      setActiveSection('projects');
      setNotice(`${normalized.name} captured as immutable snapshot v1.`);
      setProjectName('');
      setGithubUrl('');
      clearSource();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create project.');
    } finally {
      setUploading(false);
    }
  }

  async function openProject(projectId: string, initialExplorerView: 'files' | 'graph' = 'files') {
    setError('');
    const detail = await loadProjectDetail(projectId);
    if (!detail) {
      setError('Could not open project.');
      return;
    }
    setExplorerInitialView(initialExplorerView);
    setSelectedProject(detail);
    setActiveSnapshotId(detail.snapshots?.[0]?.id ?? '');
    setActiveSection('projects');
  }

  async function reanalyzeProject(projectId: string, snapshotId?: string) {
    setBusyAction(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/reanalyze`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ snapshot_id: snapshotId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? 'Could not re-analyze project.');
      setSelectedProject(normalizeProjectDetail(data));
      await Promise.all([refreshProjects(), refreshDatabaseAndAudit()]);
      setNotice('Static analysis refreshed from the immutable snapshot.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not re-analyze project.');
    } finally {
      setBusyAction(false);
    }
  }

  async function runDeploymentCheck(projectId: string, allowNetwork: boolean, snapshotId?: string) {
    setBusyAction(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/deploy`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ allow_outbound_network: allowNetwork, dry_run: true, snapshot_id: snapshotId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? 'Could not run deployment check.');
      if (selectedProject?.id === projectId) {
        setSelectedProject(normalizeProjectDetail(data));
      }
      await Promise.all([refreshProjects(), refreshDeployments(), refreshDatabaseAndAudit()]);
      setNotice('Deployment pipeline verification completed.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not run deployment check.');
    } finally {
      setBusyAction(false);
    }
  }

  async function addNewSnapshotVersion(projectId: string, file?: File, repoUrl?: string) {
    setBusyAction(true);
    setError('');
    try {
      const form = new FormData();
      if (file) form.append('archive', file);
      if (repoUrl) form.append('github_url', repoUrl);
      const response = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/snapshots`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrfToken },
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? 'Could not add snapshot version.');
      const normalized = normalizeProjectDetail(data);
      setSelectedProject(normalized);
      setActiveSnapshotId(normalized.snapshots?.[0]?.id ?? '');
      await Promise.all([refreshProjects(), refreshDatabaseAndAudit()]);
      setNotice(`Added snapshot v${normalized.snapshots?.[0]?.version_num ?? ''} to ${normalized.name}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add snapshot version.');
    } finally {
      setBusyAction(false);
    }
  }

  async function rollbackDeployment(deploymentId: string) {
    setBusyAction(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/deployments/${encodeURIComponent(deploymentId)}/rollback`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? 'Rollback failed.');
      setDeploymentsData(data);
      await Promise.all([refreshProjects(), refreshDatabaseAndAudit()]);
      setNotice('Deployment rolled back to the selected snapshot.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Rollback failed.');
    } finally {
      setBusyAction(false);
    }
  }

  async function verifyHealthProbe(deploymentId: string) {
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/deployments/${encodeURIComponent(deploymentId)}/health`, {
        credentials: 'same-origin',
      });
      const data = await response.json();
      if (!response.ok) throw new Error('Health probe failed');
      setNotice(
        `Health probe OK (${data.health_status}) for ${data.project_name} ${data.version} · ${data.limits?.cpu_millicores}m CPU / ${data.limits?.memory_mb}MB RAM.`,
      );
    } catch {
      setError('Health check endpoint did not respond.');
    }
  }

  async function removeProject(projectId: string) {
    setBusyAction(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail ?? 'Could not delete project.');
      }
      if (selectedProject?.id === projectId) setSelectedProject(null);
      if (graphProjectDetail?.id === projectId) setGraphProjectDetail(null);
      await Promise.all([refreshProjects(), refreshDeployments(), refreshDatabaseAndAudit()]);
      setNotice('Project deleted from SQLite database.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete project.');
    } finally {
      setBusyAction(false);
    }
  }

  async function saveWorkspaceSettings(nextSettings: WorkspaceSettings) {
    setBusyAction(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/settings`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(nextSettings),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? 'Could not save settings.');
      setSettings(data);
      setExplain(data.defaultExplain);
      setDeploy(data.defaultDeploy);
      setAllowBuildDownloads(data.defaultAllowBuildDownloads);
      await refreshDatabaseAndAudit();
      setNotice('Workspace settings saved to SQLite.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save settings.');
    } finally {
      setBusyAction(false);
    }
  }

  async function resetDemoData() {
    setBusyAction(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/workspace/reset-demo`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!response.ok) throw new Error('Could not restore sample project.');
      await Promise.all([refreshProjects(), refreshDeployments(), refreshDatabaseAndAudit()]);
      setNotice('Sample project restored to workspace.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not restore sample project.');
    } finally {
      setBusyAction(false);
    }
  }

  function exportWorkspaceSummary() {
    const payload = {
      exportedAt: new Date().toISOString(),
      workspaceName: settings.workspaceName,
      database: dbStats,
      projects,
      deployments: deploymentsData.history,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'codemind-workspace-report.json';
    link.click();
    URL.revokeObjectURL(url);
    setNotice('Exported workspace report JSON.');
  }

  const activeSnapshot: SnapshotInfo | undefined =
    selectedProject?.snapshots?.find((s) => s.id === activeSnapshotId) ?? selectedProject?.snapshots?.[0];

  const activeJobs = activeSnapshot?.jobs ?? selectedProject?.jobs ?? [];
  const analysisResult = activeJobs.find((job) => job.kind === 'analysis')?.result;
  const inventory = analysisResult && 'files' in analysisResult ? analysisResult : undefined;
  const deploymentResult = activeJobs.find((job) => job.kind === 'deployment')?.result;
  const deploymentPlan = deploymentResult && 'candidates' in deploymentResult ? deploymentResult : undefined;
  const selectedSource = zipFile ?? folderFiles[0];
  const sourceCount = zipFile ? 1 : folderFiles.length;

  const graphAnalysisRaw = graphProjectDetail?.jobs?.find((j) => j.kind === 'analysis')?.result;
  const graphInventory = graphAnalysisRaw && 'files' in graphAnalysisRaw ? graphAnalysisRaw : undefined;

  const breadcrumbLabel =
    activeSection === 'projects'
      ? (selectedProject?.name ?? 'Projects')
      : activeSection === 'graph'
        ? 'Architecture graph'
        : activeSection === 'deployments'
          ? 'Deployments'
          : activeSection === 'database'
            ? 'Database & Audit'
            : activeSection === 'settings'
              ? 'Settings'
              : 'Help & support';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div>
            <div className="brand-name">
              codemind<span>ai</span>
            </div>
            <div className="brand-caption">ENGINEERING PLATFORM</div>
          </div>
        </div>

        <div className="workspace-menu-wrap" ref={workspaceMenuRef}>
          <button
            type="button"
            className="workspace-select"
            aria-expanded={workspaceMenuOpen}
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
          >
            <div className="workspace-avatar">{settings.workspaceName.slice(0, 1).toUpperCase()}</div>
            <span>
              <strong>{settings.workspaceName}</strong>
              <small>SQLite · Self-hosted</small>
            </span>
            <ChevronDown size={15} />
          </button>
          {workspaceMenuOpen && (
            <div className="workspace-dropdown" role="menu">
              <div className="workspace-dropdown-meta">
                <strong>{settings.workspaceName}</strong>
                <span>
                  {projects.length} project{projects.length === 1 ? '' : 's'} · {username}
                </span>
              </div>
              <button
                type="button"
                className="workspace-dropdown-item"
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  setSelectedProject(null);
                  setActiveSection('projects');
                }}
              >
                <Plus size={14} /> New project snapshot
              </button>
              <button
                type="button"
                className="workspace-dropdown-item"
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  setSelectedProject(null);
                  setActiveSection('deployments');
                }}
              >
                <Activity size={14} /> Deployments console
              </button>
              <button
                type="button"
                className="workspace-dropdown-item"
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  setSelectedProject(null);
                  setActiveSection('database');
                }}
              >
                <Database size={14} /> Database &amp; audit
              </button>
              <button
                type="button"
                className="workspace-dropdown-item"
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  setSelectedProject(null);
                  setActiveSection('settings');
                }}
              >
                <Settings2 size={14} /> Workspace settings
              </button>
              <button
                type="button"
                className="workspace-dropdown-item"
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  void onLogout();
                }}
              >
                <LogOut size={14} /> Sign out
              </button>
            </div>
          )}
        </div>

        <div className="side-label">WORKSPACE</div>
        <nav className="primary-nav">
          <button
            type="button"
            className={`nav-item ${activeSection === 'projects' && !selectedProject ? 'active' : ''}`}
            onClick={() => {
              setSelectedProject(null);
              setActiveSection('projects');
            }}
          >
            <Layers3 size={17} />
            <span>Projects</span>
            <span className="nav-count">{projects.length}</span>
          </button>
          <button
            type="button"
            className={`nav-item ${activeSection === 'graph' ? 'active' : ''}`}
            onClick={() => {
              setActiveSection('graph');
              if (!graphProjectDetail && projects[0]) {
                void loadProjectDetail(selectedProject?.id ?? projects[0].id).then((d) => {
                  if (d) setGraphProjectDetail(d);
                });
              }
            }}
          >
            <Boxes size={17} />
            <span>Architecture graph</span>
          </button>
          <button
            type="button"
            className={`nav-item ${activeSection === 'deployments' ? 'active' : ''}`}
            onClick={() => {
              setSelectedProject(null);
              setActiveSection('deployments');
            }}
          >
            <Activity size={17} />
            <span>Deployments</span>
          </button>
          <button
            type="button"
            className={`nav-item ${activeSection === 'database' ? 'active' : ''}`}
            onClick={() => {
              setSelectedProject(null);
              setActiveSection('database');
            }}
          >
            <Database size={17} />
            <span>Database &amp; audit</span>
          </button>
        </nav>

        <div className="project-nav-head">
          <div className="side-label">YOUR PROJECTS</div>
          <button
            type="button"
            className="icon-button tiny"
            title="New project"
            onClick={() => {
              setSelectedProject(null);
              setActiveSection('projects');
              clearSource();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            <Plus size={15} />
          </button>
        </div>

        <div className="project-search">
          <Search size={14} />
          <input
            aria-label="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a project"
          />
          {query && (
            <button
              type="button"
              className="project-search-clear"
              aria-label="Clear project search"
              onClick={() => setQuery('')}
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="project-list">
          {filteredProjects.map((project) => (
            <button
              type="button"
              key={project.id}
              className={`project-link ${selectedProject?.id === project.id && activeSection === 'projects' ? 'selected' : ''}`}
              onClick={() => void openProject(project.id)}
            >
              <span className="project-dot" />
              <span className="project-link-name">{project.name}</span>
              <span className="project-branch">
                <GitBranch size={12} />
              </span>
            </button>
          ))}
          {filteredProjects.length === 0 && (
            <div className="empty-projects">{query ? 'No matching projects.' : 'Your projects will show here.'}</div>
          )}
        </div>

        <div className="sidebar-bottom">
          <div className="local-card">
            <div className="local-card-icon">
              <ShieldCheck size={16} />
            </div>
            <div>
              <strong>SQLite &amp; Sandbox Ready</strong>
              <span>Non-executing analysis engine</span>
            </div>
          </div>
          <button
            type="button"
            className={`nav-item muted ${activeSection === 'settings' ? 'active' : ''}`}
            onClick={() => {
              setSelectedProject(null);
              setActiveSection('settings');
            }}
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </button>
          <button
            type="button"
            className={`nav-item muted ${activeSection === 'help' ? 'active' : ''}`}
            onClick={() => {
              setSelectedProject(null);
              setActiveSection('help');
            }}
          >
            <CircleHelp size={17} />
            <span>Help &amp; support</span>
          </button>
          <div className="profile-row">
            <div className="profile-avatar">{username.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{username}</strong>
              <small>Local administrator</small>
            </div>
            <button
              type="button"
              className="icon-button tiny"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => void onLogout()}
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              type="button"
              className="breadcrumb-link"
              onClick={() => {
                setSelectedProject(null);
                setActiveSection('projects');
              }}
            >
              {settings.workspaceName}
            </button>
            <span className="crumb-separator">/</span>
            {selectedProject && activeSection === 'projects' && (
              <>
                <button type="button" className="breadcrumb-link" onClick={() => setSelectedProject(null)}>
                  Projects
                </button>
                <span className="crumb-separator">/</span>
              </>
            )}
            <strong>{breadcrumbLabel}</strong>
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                setSelectedProject(null);
                setActiveSection('projects');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              <Plus size={14} /> New Snapshot
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Help & documentation"
              title="Help & documentation"
              onClick={() => {
                setSelectedProject(null);
                setActiveSection('help');
              }}
            >
              <CircleHelp size={17} />
            </button>
            <button
              type="button"
              className="icon-button signout-button"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => void onLogout()}
            >
              <LogOut size={16} />
            </button>
            <div className="top-avatar" aria-label={`Signed in as ${username}`}>
              {username.slice(0, 1).toUpperCase()}
            </div>
          </div>
        </header>

        <div className="content-wrap">
          {error && (
            <div className="feedback error" style={{ marginBottom: 14 }}>
              <X size={15} />
              <span>{error}</span>
              <button type="button" aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={14} />
              </button>
            </div>
          )}
          {notice && (
            <div className="feedback notice" style={{ marginBottom: 14 }}>
              <Sparkles size={15} />
              <span>{notice}</span>
              <button type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}>
                <X size={14} />
              </button>
            </div>
          )}

          {activeSection === 'projects' && selectedProject && (
            <ProjectView
              project={selectedProject}
              activeSnapshot={activeSnapshot}
              onSelectSnapshot={(snapId) => setActiveSnapshotId(snapId)}
              inventory={inventory}
              deploymentPlan={deploymentPlan}
              explorerInitialView={explorerInitialView}
              csrfToken={csrfToken}
              busy={busyAction}
              onBack={() => setSelectedProject(null)}
              onReanalyze={() => void reanalyzeProject(selectedProject.id, activeSnapshot?.id)}
              onRunDeploy={(allowNet) => void runDeploymentCheck(selectedProject.id, allowNet, activeSnapshot?.id)}
              onAddSnapshot={(file, repo) => void addNewSnapshotVersion(selectedProject.id, file, repo)}
              onGenerateBrief={async () => {
                if (!activeSnapshot) return;
                setBusyAction(true);
                setError('');
                try {
                  const res = await fetch(
                    `${API_URL}/api/projects/${encodeURIComponent(selectedProject.id)}/ai-brief`,
                    {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                      body: JSON.stringify({ snapshot_id: activeSnapshot.id }),
                    },
                  );
                  const payload = await res.json();
                  if (!res.ok) throw new Error(payload.detail ?? 'Could not generate architecture brief.');
                  const refreshed = await loadProjectDetail(selectedProject.id);
                  if (refreshed) setSelectedProject(refreshed);
                  await refreshDatabaseAndAudit();
                  setNotice('Generated Gemini architecture brief.');
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : 'Could not generate architecture brief.');
                } finally {
                  setBusyAction(false);
                }
              }}
              onVerifyHealth={(depUrl) => {
                const id = depUrl.split('/')[3];
                if (id) void verifyHealthProbe(id);
              }}
              onDelete={() => void removeProject(selectedProject.id)}
              onNotice={setNotice}
              onError={setError}
            />
          )}

          {activeSection === 'projects' && !selectedProject && (
            <>
              <div className="hero-title-wrap" style={{ marginTop: 12 }}>
                <h1>
                  Universal AI Engineering
                  <br />
                  <span>&amp; Deployment Platform.</span>
                </h1>
                <p>
                  Understand any repository with evidence-backed static intelligence, ask source-grounded questions, and
                  verify isolated deployment pipelines from one immutable snapshot.
                </p>
              </div>

              <section className="setup-card" aria-label="Add a project">
                <div className="setup-header">
                  <div>
                    <div className="section-kicker">01. PROJECT INTAKE</div>
                    <h2>Import codebase or connect GitHub</h2>
                    <p>Upload a ZIP archive, select a local folder, or clone a public GitHub repository.</p>
                  </div>
                </div>

                <div className="intake-mode-tabs" role="tablist" aria-label="Project source type">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={intakeMode === 'upload'}
                    className={`intake-mode-tab ${intakeMode === 'upload' ? 'active' : ''}`}
                    onClick={() => setIntakeMode('upload')}
                  >
                    <Upload size={13} /> ZIP / Local Folder
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={intakeMode === 'github'}
                    className={`intake-mode-tab ${intakeMode === 'github' ? 'active' : ''}`}
                    onClick={() => setIntakeMode('github')}
                  >
                    <FolderGit2 size={13} /> GitHub Repository URL
                  </button>
                </div>

                {intakeMode === 'upload' ? (
                  <div
                    className={`dropzone ${dragging ? 'dragging' : ''} ${selectedSource ? 'has-file' : ''}`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={handleDrop}
                  >
                    <input
                      ref={zipInput}
                      className="visually-hidden"
                      type="file"
                      accept=".zip,application/zip"
                      onChange={selectZip}
                    />
                    <input
                      ref={folderInput}
                      className="visually-hidden"
                      type="file"
                      multiple
                      aria-label="Select a project folder"
                      {...({ webkitdirectory: '', directory: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>)}
                      onChange={selectFolder}
                    />
                    {selectedSource ? (
                      <>
                        <div className="file-icon">
                          <FileArchive size={20} />
                        </div>
                        <div className="selected-file">
                          <strong>{zipFile?.name ?? selectedSource.webkitRelativePath.split('/')[0]}</strong>
                          <span>
                            {zipFile ? formatBytes(zipFile.size) : `${sourceCount.toLocaleString()} files selected`} ·
                            ready to snapshot
                          </span>
                        </div>
                        <button
                          type="button"
                          className="icon-button remove-file"
                          title="Remove selected project"
                          onClick={(event) => {
                            event.stopPropagation();
                            clearSource();
                          }}
                        >
                          <X size={16} />
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="upload-symbol">
                          <Upload size={19} />
                        </div>
                        <div className="drop-copy">
                          <strong>Drop a project ZIP here</strong>
                          <span>choose a ZIP archive, local project folder, or load a sample snapshot</span>
                        </div>
                        <div className="source-actions">
                          <button
                            type="button"
                            className="button secondary small"
                            onClick={() => zipInput.current?.click()}
                          >
                            <FileArchive size={14} /> Browse ZIP
                          </button>
                          <button
                            type="button"
                            className="button secondary small"
                            onClick={() => folderInput.current?.click()}
                          >
                            <FolderGit2 size={14} /> Select folder
                          </button>
                          <button
                            type="button"
                            className="button secondary small"
                            disabled={uploading}
                            onClick={() => void startProject('sample')}
                          >
                            <Sparkles size={14} /> Load sample
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="github-intake-box">
                    <div className="github-intake-row">
                      <input
                        className="github-intake-input"
                        type="url"
                        value={githubUrl}
                        onChange={(event) => setGithubUrl(event.target.value)}
                        placeholder="https://github.com/owner/repository"
                        aria-label="Public GitHub repository URL"
                      />
                    </div>
                    <div className="github-intake-hint">
                      <span>Clones the repository into a verified SHA-256 ZIP snapshot without executing code.</span>
                      <button
                        type="button"
                        className="github-preset-btn"
                        onClick={() => setGithubUrl('https://github.com/Tejaswiniy19/codemind-')}
                      >
                        Use Tejaswiniy19/codemind-
                      </button>
                    </div>
                  </div>
                )}

                <div className="project-name-row">
                  <label htmlFor="project-name">PROJECT NAME</label>
                  <input
                    id="project-name"
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="e.g. inventory-dashboard (auto-detected if empty)"
                    maxLength={100}
                  />
                  <span>Optional</span>
                </div>

                <div className="capabilities-heading">
                  <div>
                    <div className="section-kicker">02. CAPABILITIES</div>
                    <h3>Select pipeline stages</h3>
                  </div>
                  <span className="independent-label">
                    <span className="tiny-check">
                      <Check size={10} />
                    </span>{' '}
                    Run either or both
                  </span>
                </div>

                <div className="capability-grid">
                  <CapabilityCard
                    selected={explain}
                    onClick={() => setExplain((value) => !value)}
                    icon={<Code2 size={20} />}
                    index="01"
                    title="Explain project"
                    description="Extract file roles, symbols, imports, frameworks, and interactive dependency graph with source evidence."
                    accent="mint"
                    tags={['FILE ROLES', 'SOURCE EVIDENCE']}
                  />
                  <CapabilityCard
                    selected={deploy}
                    onClick={() => setDeploy((value) => !value)}
                    icon={<ArrowDownToLine size={20} />}
                    index="02"
                    title="Deploy project"
                    description="Detect build/start recipes, validate env isolation, and run 4-stage sandbox health checks."
                    accent="violet"
                    tags={['STACK RECIPES', 'HEALTH PROBE']}
                    status={settings.runnerMode === 'dry-run' ? 'SANDBOX CHECK' : 'INSPECT ONLY'}
                  />
                </div>

                {deploy && (
                  <label className="network-consent">
                    <input
                      type="checkbox"
                      checked={allowBuildDownloads}
                      onChange={(event) => setAllowBuildDownloads(event.target.checked)}
                    />
                    <span>
                      <strong>Allow package downloads during build</strong>
                      <small>
                        Routes npm/pip/maven fetches through a restricted registry allowlist while keeping runtime
                        networking isolated.
                      </small>
                    </span>
                  </label>
                )}

                <div className="selection-summary">
                  <div className="selection-checks">
                    <span className={explain ? 'checked' : ''}>
                      {explain && <Check size={10} />}EXPLAIN
                    </span>
                    <span className="plus-sign">+</span>
                    <span className={deploy ? 'checked deploy-check' : ''}>
                      {deploy && <Check size={10} />}DEPLOY
                    </span>
                  </div>
                  <p>
                    {explain && deploy
                      ? 'Both capabilities will run against the same immutable project snapshot.'
                      : explain
                        ? 'Static code intelligence will run for this snapshot.'
                        : deploy
                          ? 'Deployment recipe verification will run for this snapshot.'
                          : 'Select at least one capability to continue.'}
                  </p>
                </div>

                <div className="submit-row">
                  <div className="security-note">
                    <ShieldCheck size={15} />
                    <span>Stored in SQLite · uploaded source code is never executed inside the API server</span>
                  </div>
                  <button
                    type="button"
                    className="button primary"
                    disabled={
                      uploading ||
                      (!explain && !deploy) ||
                      (intakeMode === 'upload' ? !selectedSource : !githubUrl.trim())
                    }
                    onClick={() => void startProject(intakeMode === 'github' ? 'github' : 'upload')}
                  >
                    {uploading ? (
                      <>
                        <span className="spinner" /> {intakeMode === 'github' ? 'Cloning repository…' : 'Creating snapshot…'}
                      </>
                    ) : (
                      <>
                        {intakeMode === 'github' ? 'Import & analyze repo' : 'Create project snapshot'}{' '}
                        <ArrowRight size={16} />
                      </>
                    )}
                  </button>
                </div>
              </section>

              {projects.length > 0 && (
                <section className="workspace-projects-section" aria-label="Workspace projects">
                  <div className="workspace-section-head">
                    <div>
                      <div className="section-kicker">WORKSPACE DIRECTORY</div>
                      <h3>Stored project snapshots</h3>
                    </div>
                    <span>
                      {projects.length} project{projects.length === 1 ? '' : 's'} in SQLite
                    </span>
                  </div>
                  <div className="projects-grid">
                    {projects.map((p) => {
                      const analysisJob = p.jobs?.find((j) => j.kind === 'analysis');
                      const deployJob = p.jobs?.find((j) => j.kind === 'deployment');
                      return (
                        <button
                          type="button"
                          key={p.id}
                          className="project-directory-card"
                          onClick={() => void openProject(p.id)}
                        >
                          <div className="project-directory-top">
                            <strong>{p.name}</strong>
                            <ArrowRight size={14} />
                          </div>
                          <div className="project-directory-meta">
                            <span>v{p.version_num ?? 1}</span>
                            <span>·</span>
                            <span>{(p.file_count ?? 0).toLocaleString()} files</span>
                            <span>·</span>
                            <span>{formatBytes(p.total_bytes ?? 0)}</span>
                            <span>·</span>
                            <span>{p.source_type ?? 'zip'}</span>
                          </div>
                          <div className="project-directory-badges">
                            {analysisJob && (
                              <StatusBadge status={analysisJob.status} label={`Analysis: ${analysisJob.status}`} />
                            )}
                            {deployJob && (
                              <StatusBadge status={deployJob.status} label={`Deploy: ${deployJob.status}`} />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}
            </>
          )}

          {activeSection === 'graph' && (
            <section className="view-page" aria-label="Architecture graph workspace">
              <div className="view-page-header">
                <div>
                  <div className="section-kicker">DEPENDENCY TOPOLOGY</div>
                  <h1>Architecture Graph</h1>
                  <p>Explore resolved file-to-file imports, module roles, and extracted symbols across snapshots.</p>
                </div>
              </div>

              {projects.length > 0 ? (
                <>
                  <div className="graph-project-bar">
                    <label>
                      ACTIVE PROJECT SNAPSHOT
                      <select
                        value={graphProjectDetail?.id ?? ''}
                        onChange={(event) => {
                          const id = event.target.value;
                          setGraphSelectedPath('');
                          void loadProjectDetail(id).then((d) => {
                            if (d) setGraphProjectDetail(d);
                          });
                        }}
                      >
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.file_count ?? 0} files)
                          </option>
                        ))}
                      </select>
                    </label>
                    {graphProjectDetail && (
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => void openProject(graphProjectDetail.id, 'files')}
                      >
                        Open full project view <ArrowRight size={14} />
                      </button>
                    )}
                  </div>

                  {graphInventory ? (
                    <ArchitectureGraph
                      result={graphInventory}
                      selectedPath={graphSelectedPath || graphInventory.files[0]?.path || ''}
                      onSelectPath={(path) => setGraphSelectedPath(path)}
                      onOpenFile={() => {
                        if (graphProjectDetail) {
                          void openProject(graphProjectDetail.id, 'files');
                        }
                      }}
                    />
                  ) : (
                    <div className="setup-card">
                      <p style={{ margin: 0, color: '#9ca8a3', fontSize: 12 }}>
                        This project does not have a completed static analysis yet.
                      </p>
                      {graphProjectDetail && (
                        <button
                          type="button"
                          className="button primary"
                          style={{ marginTop: 12 }}
                          disabled={busyAction}
                          onClick={() => void reanalyzeProject(graphProjectDetail.id)}
                        >
                          <RefreshCw size={14} /> Run static analysis now
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="setup-card">
                  <p style={{ margin: 0, color: '#9ca8a3', fontSize: 12 }}>
                    No project snapshots exist yet. Upload a project or import a GitHub repository first.
                  </p>
                  <button
                    type="button"
                    className="button primary"
                    style={{ marginTop: 12 }}
                    onClick={() => setActiveSection('projects')}
                  >
                    Go to Projects <ArrowRight size={14} />
                  </button>
                </div>
              )}
            </section>
          )}

          {activeSection === 'deployments' && (
            <section className="view-page" aria-label="Deployment recipes and rollback console">
              <div className="view-page-header">
                <div>
                  <div className="section-kicker">DEPLOYMENT ORCHESTRATION</div>
                  <h1>Deployments, Health &amp; Rollback</h1>
                  <p>
                    Run 4-stage sandbox pipeline checks, probe health endpoints, and roll back across snapshot versions.
                  </p>
                </div>
                <button type="button" className="button secondary small" onClick={() => void refreshDeployments()}>
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>

              <div className="deployments-list">
                {deploymentsData.projects.map((item) => {
                  const plan = item.job?.result as DeploymentPlanView | undefined;
                  return (
                    <article className="deployment-row-card" key={item.project_id}>
                      <div className="deployment-row-head">
                        <div>
                          <h3>{item.project_name}</h3>
                          <div className="deployment-row-sub">
                            Snapshot v{item.version_num} · {item.snapshot_id.slice(0, 8)} · sha256:
                            {item.digest.slice(0, 12)}
                          </div>
                        </div>
                        <div className="deployment-row-actions">
                          <StatusBadge status={item.job?.status ?? 'not_run'} />
                          {plan?.runner?.url && (
                            <button
                              type="button"
                              className="button secondary small"
                              onClick={() => {
                                const id = plan.runner?.url?.split('/')[3];
                                if (id) void verifyHealthProbe(id);
                              }}
                            >
                              <Activity size={13} /> Verify health
                            </button>
                          )}
                          <button
                            type="button"
                            className="button secondary small"
                            disabled={busyAction}
                            onClick={() => void runDeploymentCheck(item.project_id, true)}
                          >
                            <Play size={13} /> Run deploy check
                          </button>
                          <button
                            type="button"
                            className="button secondary small"
                            onClick={() => void openProject(item.project_id)}
                          >
                            Inspect project <ArrowRight size={13} />
                          </button>
                        </div>
                      </div>

                      <p style={{ margin: 0, fontSize: 11, color: '#9aa6a2' }}>
                        {item.job?.message ??
                          'Deployment inspection has not been run for this snapshot yet. Click "Run deploy check".'}
                      </p>

                      {plan?.stages && plan.stages.length > 0 && (
                        <div className="pipeline-stages">
                          {plan.stages.map((st) => (
                            <div className="pipeline-stage-row" key={st.name}>
                              <div>
                                <strong>{st.name}</strong>
                                <small>{st.detail}</small>
                              </div>
                              <div className="pipeline-stage-meta">
                                <span>{st.duration_ms}ms</span>
                                <StatusBadge status={st.status === 'passed' ? 'completed' : st.status} />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {plan?.runner?.logs && (
                        <details className="deployment-logs">
                          <summary>Sandbox pipeline &amp; health logs</summary>
                          <pre>{plan.runner.logs}</pre>
                        </details>
                      )}
                    </article>
                  );
                })}
              </div>

              {deploymentsData.history.length > 0 && (
                <div className="panel-card">
                  <h3>Deployment History &amp; Rollback Ledger</h3>
                  <div className="env-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>PROJECT</th>
                          <th>VERSION</th>
                          <th>STACK</th>
                          <th>STATUS</th>
                          <th>HEALTH</th>
                          <th>BOUNDS</th>
                          <th>TIMESTAMP</th>
                          <th>ACTIONS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deploymentsData.history.map((h) => (
                          <tr key={h.id}>
                            <td>
                              <strong>{h.project_name}</strong>
                            </td>
                            <td>
                              <code>v{h.version_num}</code>
                            </td>
                            <td>{h.stack}</td>
                            <td>
                              <StatusBadge status={h.status} />
                            </td>
                            <td>{h.health_status}</td>
                            <td className="tabular-num">
                              {h.cpu_millicores}m / {h.memory_mb}MB
                            </td>
                            <td className="tabular-num">{new Date(h.created_at).toLocaleString()}</td>
                            <td>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  type="button"
                                  className="button secondary small"
                                  onClick={() => void verifyHealthProbe(h.id)}
                                >
                                  Probe
                                </button>
                                <button
                                  type="button"
                                  className="button secondary small"
                                  disabled={busyAction}
                                  onClick={() => void rollbackDeployment(h.id)}
                                >
                                  <RotateCcw size={12} /> Rollback
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          )}

          {activeSection === 'database' && (
            <section className="view-page" aria-label="SQLite database telemetry and audit log">
              <div className="view-page-header">
                <div>
                  <div className="section-kicker">PERSISTENCE &amp; GOVERNANCE</div>
                  <h1>SQLite Database &amp; Audit Log</h1>
                  <p>Live relational storage telemetry, workspace quotas, and immutable security audit trail.</p>
                </div>
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => void refreshDatabaseAndAudit()}
                >
                  <RefreshCw size={14} /> Refresh telemetry
                </button>
              </div>

              {dbStats && (
                <>
                  <div className="db-stats-grid">
                    <div className="db-stat-card">
                      <span>DATABASE ENGINE</span>
                      <div className="db-stat-value" style={{ fontSize: 15 }}>
                        {dbStats.engine}
                      </div>
                    </div>
                    <div className="db-stat-card">
                      <span>SQLITE FILE SIZE</span>
                      <div className="db-stat-value">{formatBytes(dbStats.db_file_bytes)}</div>
                    </div>
                    <div className="db-stat-card">
                      <span>PROJECTS / QUOTA</span>
                      <div className="db-stat-value">
                        {dbStats.table_counts.projects ?? 0} / {dbStats.quotas.max_projects}
                      </div>
                    </div>
                    <div className="db-stat-card">
                      <span>SNAPSHOT STORAGE</span>
                      <div className="db-stat-value">
                        {formatBytes(dbStats.total_snapshot_bytes)} / {dbStats.quotas.storage_quota_mb} MB
                      </div>
                    </div>
                  </div>

                  <div className="panel-card">
                    <h3>Relational Table Row Counts</h3>
                    <div className="env-table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>TABLE</th>
                            <th>ROW COUNT</th>
                            <th>PURPOSE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            ['projects', 'Project workspaces and source metadata (ZIP / Folder / GitHub)'],
                            ['snapshots', 'Immutable versioned source archives and SHA-256 digests'],
                            ['jobs', 'Static analysis and deployment pipeline outputs'],
                            ['deployments', 'Sandbox deployment ledger, health status, and logs'],
                            ['project_env_vars', 'Isolated per-project runtime environment variables'],
                            ['qa_history', 'Persisted Gemini Q&A responses and verified citations'],
                            ['architecture_briefs', 'Cached AI architecture synthesis briefs'],
                            ['audit_logs', 'Security and governance event stream'],
                            ['users', 'Workspace administrator accounts (scrypt hashed)'],
                            ['sessions', 'Active signed HttpOnly session records'],
                          ].map(([table, desc]) => (
                            <tr key={table}>
                              <td>
                                <code>{table}</code>
                              </td>
                              <td className="tabular-num">
                                <strong>{dbStats.table_counts[table] ?? 0}</strong>
                              </td>
                              <td>{desc}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              <div className="panel-card">
                <h3>Security &amp; Operations Audit Log</h3>
                <div className="env-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>TIMESTAMP</th>
                        <th>ACTOR</th>
                        <th>ACTION</th>
                        <th>TARGET</th>
                        <th>DETAIL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.map((log) => (
                        <tr key={log.id}>
                          <td className="tabular-num">{new Date(log.created_at).toLocaleString()}</td>
                          <td>{log.actor}</td>
                          <td>
                            <code>{log.action}</code>
                          </td>
                          <td>
                            {log.target_type}:{log.target_id.slice(0, 8)}
                          </td>
                          <td>{log.detail}</td>
                        </tr>
                      ))}
                      {auditLogs.length === 0 && (
                        <tr>
                          <td colSpan={5} style={{ color: '#7d8985' }}>
                            No audit events recorded yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {activeSection === 'settings' && (
            <section className="view-page" aria-label="Workspace settings">
              <div className="view-page-header">
                <div>
                  <div className="section-kicker">WORKSPACE CONFIGURATION</div>
                  <h1>Settings &amp; Quotas</h1>
                  <p>Manage workspace defaults, deployment runner behavior, storage quotas, and diagnostics.</p>
                </div>
              </div>

              <div className="settings-grid">
                <div className="settings-card">
                  <h3>General, Quotas &amp; Capability Defaults</h3>
                  <p>Persisted directly in SQLite and applied to new project snapshots.</p>
                  <div className="settings-field">
                    <label htmlFor="ws-name">WORKSPACE NAME</label>
                    <input
                      id="ws-name"
                      type="text"
                      value={settings.workspaceName}
                      maxLength={60}
                      onChange={(event) => setSettings({ ...settings, workspaceName: event.target.value })}
                    />
                  </div>
                  <div className="settings-field">
                    <label htmlFor="ws-quota-proj">MAX PROJECTS QUOTA</label>
                    <input
                      id="ws-quota-proj"
                      type="number"
                      min={5}
                      max={500}
                      value={settings.maxProjectsQuota}
                      onChange={(event) =>
                        setSettings({ ...settings, maxProjectsQuota: Number(event.target.value) || 50 })
                      }
                    />
                  </div>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={settings.defaultExplain}
                      onChange={(event) => setSettings({ ...settings, defaultExplain: event.target.checked })}
                    />
                    <span>
                      <strong>Enable Explain project by default</strong>
                      <small>Automatically extract file roles, symbols, and dependency graph on intake.</small>
                    </span>
                  </label>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={settings.defaultDeploy}
                      onChange={(event) => setSettings({ ...settings, defaultDeploy: event.target.checked })}
                    />
                    <span>
                      <strong>Enable Deploy project by default</strong>
                      <small>Run 4-stage deployment recipe verification on new snapshots.</small>
                    </span>
                  </label>
                  <div className="settings-field">
                    <label htmlFor="ws-runner-mode">DEPLOYMENT VERIFICATION MODE</label>
                    <select
                      id="ws-runner-mode"
                      value={settings.runnerMode}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          runnerMode: event.target.value === 'disabled' ? 'disabled' : 'dry-run',
                        })
                      }
                    >
                      <option value="dry-run">Sandbox preflight verification (4-stage health check)</option>
                      <option value="disabled">Recipe inspection only (blocked until external runner)</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    className="button primary"
                    disabled={busyAction}
                    onClick={() => void saveWorkspaceSettings(settings)}
                  >
                    Save workspace settings
                  </button>
                </div>

                <div className="settings-card">
                  <h3>Platform Status &amp; Maintenance</h3>
                  <p>Active backend runtime, AI model status, and SQLite export tools.</p>
                  <div className="project-metrics" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <div>
                      <span>ADMINISTRATOR</span>
                      <strong style={{ textTransform: 'none' }}>{username}</strong>
                    </div>
                    <div>
                      <span>SNAPSHOTS</span>
                      <strong>{projects.length}</strong>
                    </div>
                    <div>
                      <span>AI ENGINE</span>
                      <strong className={settings.qa?.configured ? 'success-text' : 'muted-text'}>
                        {settings.qa?.configured ? settings.qa.model : 'Not configured'}
                      </strong>
                    </div>
                    <div>
                      <span>DATABASE</span>
                      <strong className="success-text">SQLite 3 WAL</strong>
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={busyAction}
                      onClick={() => void resetDemoData()}
                    >
                      <RefreshCw size={14} /> Restore sample project
                    </button>
                    <button type="button" className="button secondary small" onClick={exportWorkspaceSummary}>
                      <Download size={14} /> Export workspace JSON
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeSection === 'help' && (
            <section className="view-page" aria-label="Help and documentation">
              <div className="view-page-header">
                <div>
                  <div className="section-kicker">DOCUMENTATION</div>
                  <h1>Platform Architecture &amp; Guide</h1>
                  <p>End-to-end overview of CodeMind AI intake, intelligence, SQLite persistence, and isolation.</p>
                </div>
              </div>

              <div className="help-grid">
                <article className="help-card">
                  <h3>
                    <GitBranch size={16} /> Immutable Multi-Version Snapshots
                  </h3>
                  <p>
                    Upload ZIPs, local folders, or clone public GitHub repositories directly. Each intake creates a
                    SHA-256 verified snapshot version (v1, v2, …) stored in SQLite for reproducible analysis and rollback.
                  </p>
                </article>
                <article className="help-card">
                  <h3>
                    <Code2 size={16} /> Intelligence &amp; AI Briefs
                  </h3>
                  <ul>
                    <li>Lexical &amp; manifest analysis for Python, JS/TS, Java, and Docker</li>
                    <li>Interactive dependency topology &amp; file change-impact explorer</li>
                    <li>Gemini Architecture Brief &amp; persistent Source-Grounded Q&amp;A</li>
                  </ul>
                </article>
                <article className="help-card">
                  <h3>
                    <Server size={16} /> Isolated Deployment Pipeline
                  </h3>
                  <p>
                    4-stage pipeline validates snapshot digests, runtime recipes, per-project isolated env vars, and
                    health probes without ever executing untrusted code inside the API process.
                  </p>
                </article>
                <article className="help-card">
                  <h3>
                    <Database size={16} /> Relational SQLite &amp; Audit Trail
                  </h3>
                  <p>
                    Every project, snapshot, deployment, env variable, Q&amp;A transcript, and security event is stored
                    in relational SQLite tables with live telemetry in Database &amp; Audit.
                  </p>
                </article>
              </div>
            </section>
          )}

          <footer className="page-footer">
            <span>
              CODEMIND AI <i>·</i> UNIVERSAL AI ENGINEERING &amp; DEPLOYMENT PLATFORM
            </span>
            <span>
              {projects.length} PROJECT{projects.length === 1 ? '' : 'S'} <i>·</i> SQLITE PERSISTENCE
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}

function CapabilityCard({
  selected,
  onClick,
  icon,
  index,
  title,
  description,
  accent,
  tags,
  status,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  index: string;
  title: string;
  description: string;
  accent: string;
  tags: string[];
  status?: string;
}) {
  return (
    <button
      type="button"
      className={`capability-card ${selected ? 'selected' : ''} ${accent}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="card-index">{index} / CAPABILITY</span>
      <span className={`select-indicator ${selected ? 'on' : ''}`}>{selected && <Check size={12} />}</span>
      <span className="cap-icon">{icon}</span>
      <span className="cap-title-row">
        <strong>{title}</strong>
        {status && <span className="coming-badge">{status}</span>}
      </span>
      <span className="cap-description">{description}</span>
      <span className="cap-bottom">
        <span className="cap-tags">
          {tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </span>
        <span className="toggle-track">
          <span />
        </span>
      </span>
    </button>
  );
}

function ProjectView({
  project,
  activeSnapshot,
  onSelectSnapshot,
  inventory,
  deploymentPlan,
  explorerInitialView,
  csrfToken,
  busy,
  onBack,
  onReanalyze,
  onRunDeploy,
  onAddSnapshot,
  onGenerateBrief,
  onVerifyHealth,
  onDelete,
  onNotice,
  onError,
}: {
  project: Project;
  activeSnapshot?: SnapshotInfo;
  onSelectSnapshot: (id: string) => void;
  inventory?: AnalysisResult;
  deploymentPlan?: DeploymentPlanView | null;
  explorerInitialView: 'files' | 'graph';
  csrfToken: string;
  busy: boolean;
  onBack: () => void;
  onReanalyze: () => void;
  onRunDeploy: (allowNet: boolean) => void;
  onAddSnapshot: (file?: File, repoUrl?: string) => void;
  onGenerateBrief: () => void;
  onVerifyHealth: (url: string) => void;
  onDelete: () => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [envVars, setEnvVars] = useState<ProjectEnvVar[]>([]);
  const [envKey, setEnvKey] = useState('');
  const [envVal, setEnvVal] = useState('');
  const [envSecret, setEnvSecret] = useState(true);
  const newSnapInput = useRef<HTMLInputElement>(null);

  const loadEnvVars = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/projects/${encodeURIComponent(project.id)}/env`, {
        credentials: 'same-origin',
      });
      if (res.ok) setEnvVars(await res.json());
    } catch {
      // Ignore
    }
  }, [project.id]);

  useEffect(() => {
    void loadEnvVars();
  }, [loadEnvVars]);

  async function saveEnvVar(e: FormEvent) {
    e.preventDefault();
    if (!envKey.trim() || !envVal) return;
    try {
      const res = await fetch(`${API_URL}/api/projects/${encodeURIComponent(project.id)}/env`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ key_name: envKey, value: envVal, is_secret: envSecret }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? 'Could not save variable');
      setEnvKey('');
      setEnvVal('');
      await loadEnvVars();
      onNotice(`Saved isolated runtime variable ${data.key_name}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save variable');
    }
  }

  async function removeEnvVar(varId: string) {
    try {
      const res = await fetch(`${API_URL}/api/projects/${encodeURIComponent(project.id)}/env/${varId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (res.ok) {
        await loadEnvVars();
        onNotice('Removed runtime environment variable.');
      }
    } catch {
      // Ignore
    }
  }

  const jobs = activeSnapshot?.jobs ?? project.jobs ?? [];
  const analysis = jobs.find((job) => job.kind === 'analysis');
  const deployment = jobs.find((job) => job.kind === 'deployment');
  const brief = activeSnapshot?.brief;
  const snapshots = project.snapshots ?? [];

  return (
    <div className="project-view">
      <div className="project-view-top-bar">
        <button type="button" className="back-link" onClick={onBack}>
          ← All projects
        </button>
        <div className="project-actions-bar">
          <input
            ref={newSnapInput}
            type="file"
            accept=".zip,application/zip"
            className="visually-hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onAddSnapshot(f);
              if (newSnapInput.current) newSnapInput.current.value = '';
            }}
          />
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => newSnapInput.current?.click()}
          >
            <Upload size={13} /> New ZIP version
          </button>
          {project.repo_url && (
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => onAddSnapshot(undefined, project.repo_url!)}
            >
              <FolderGit2 size={13} /> Sync GitHub
            </button>
          )}
          <button type="button" className="button secondary small" disabled={busy} onClick={onReanalyze}>
            <RefreshCw size={13} /> Re-analyze
          </button>
          <button type="button" className="button secondary small" disabled={busy} onClick={() => onRunDeploy(true)}>
            <Play size={13} /> Run deploy check
          </button>
          {confirmDelete ? (
            <div className="inline-confirm">
              <span>Delete project?</span>
              <button type="button" className="confirm-yes" disabled={busy} onClick={onDelete}>
                Yes, delete
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button secondary small danger-outline"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      </div>

      <div className="project-view-heading">
        <div>
          <div className="section-kicker">PROJECT WORKSPACE</div>
          <h1>{project.name}</h1>
          <p>
            Source: {project.source_type ?? 'zip'}
            {project.repo_url ? ` · ${project.repo_url}` : ''} · {(activeSnapshot?.digest ?? project.digest ?? '').slice(0, 12)}
          </p>
        </div>
        <div className="snapshot-stamp">
          <span>VERSION</span>
          <strong>
            v{activeSnapshot?.version_num ?? project.version_num ?? 1} ·{' '}
            {(activeSnapshot?.id ?? project.snapshot_id ?? project.id).slice(0, 8)}
          </strong>
        </div>
      </div>

      {snapshots.length > 1 && (
        <div className="snapshot-version-bar">
          <div className="snapshot-version-left">
            <label htmlFor="snap-version-select">ACTIVE SNAPSHOT VERSION</label>
            <select
              id="snap-version-select"
              value={activeSnapshot?.id ?? ''}
              onChange={(e) => onSelectSnapshot(e.target.value)}
            >
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  v{s.version_num} · {s.file_count} files · {new Date(s.created_at).toLocaleString()}
                </option>
              ))}
            </select>
          </div>
          <span style={{ font: '10px var(--mono)', color: '#7d8a85' }}>
            {snapshots.length} immutable versions stored
          </span>
        </div>
      )}

      <div className="project-metrics">
        <div>
          <span>FILES RECEIVED</span>
          <strong>{(activeSnapshot?.file_count ?? project.file_count ?? inventory?.file_count ?? 0).toLocaleString()}</strong>
        </div>
        <div>
          <span>EXPANDED SIZE</span>
          <strong>{formatBytes(activeSnapshot?.total_bytes ?? project.total_bytes ?? 0)}</strong>
        </div>
        <div>
          <span>ANALYSIS</span>
          <strong className={analysis?.status === 'completed' ? 'success-text' : ''}>
            {analysis?.status ?? 'Not requested'}
          </strong>
        </div>
        <div>
          <span>DEPLOYMENT</span>
          <strong
            className={
              deployment?.status === 'completed'
                ? 'success-text'
                : deployment?.status === 'blocked'
                  ? 'muted-text'
                  : ''
            }
          >
            {deployment?.status ?? 'Not requested'}
          </strong>
        </div>
      </div>

      <div className="job-grid">
        {analysis ? (
          <div className="job-card">
            <div className="job-card-title">
              <span className="job-icon mint-icon">
                <Code2 size={17} />
              </span>
              <div>
                <strong>Project explanation</strong>
                <span>Static source analysis</span>
              </div>
              <StatusBadge status={analysis.status} />
            </div>
            <p>{analysis.message}</p>
            {inventory && (
              <div className="job-facts">
                <span>{inventory.symbol_count ?? 0} symbols</span>
                <span>{inventory.relationship_count ?? 0} references</span>
                <span>{inventory.analyzed_source_files ?? inventory.files.length} analyzed files</span>
              </div>
            )}
          </div>
        ) : (
          <div className="job-card">
            <div className="job-card-title">
              <span className="job-icon mint-icon">
                <Code2 size={17} />
              </span>
              <div>
                <strong>Project explanation</strong>
                <span>Static source analysis</span>
              </div>
              <StatusBadge status="not_run" label="NOT RUN" />
            </div>
            <p>Static analysis was not enabled when this snapshot was created.</p>
            <div className="job-card-actions">
              <button type="button" className="button secondary small" disabled={busy} onClick={onReanalyze}>
                <Play size={13} /> Run static analysis
              </button>
            </div>
          </div>
        )}

        {deployment ? (
          <div className="job-card">
            <div className="job-card-title">
              <span className="job-icon violet-icon">
                <Server size={17} />
              </span>
              <div>
                <strong>Project deployment</strong>
                <span>
                  {deploymentPlan?.runner?.status
                    ? `Sandbox · ${deploymentPlan.runner.status}`
                    : 'Stack recipe inspection'}
                </span>
              </div>
              <StatusBadge status={deployment.status} />
            </div>
            <p>{deployment.message}</p>
            {deploymentPlan?.candidates?.length ? (
              <div className="deployment-candidates">
                {deploymentPlan.candidates.map((candidate, index) => (
                  <div
                    className="candidate-card"
                    key={`${candidate.runtime_family}-${candidate.manifest_paths?.join('-')}-${index}`}
                  >
                    <strong>{candidate.stack}</strong>
                    <span>
                      {candidate.runtime_family} runtime
                      {candidate.package_manager ? ` · ${candidate.package_manager}` : ''}
                    </span>
                    <small>
                      {candidate.build_recipe_id ?? 'Build step needs configuration'} /{' '}
                      {candidate.start_recipe_id ?? 'Start step needs configuration'}
                    </small>
                    {candidate.manifest_paths?.map((path) => (
                      <code key={path}>{path}</code>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            {deploymentPlan?.stages && deploymentPlan.stages.length > 0 && (
              <div className="pipeline-stages">
                {deploymentPlan.stages.map((st) => (
                  <div className="pipeline-stage-row" key={st.name}>
                    <div>
                      <strong>{st.name}</strong>
                      <small>{st.detail}</small>
                    </div>
                    <div className="pipeline-stage-meta">
                      <span>{st.duration_ms}ms</span>
                      <StatusBadge status={st.status === 'passed' ? 'completed' : st.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {deploymentPlan?.runner?.url && (
              <div className="job-card-actions">
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => onVerifyHealth(deploymentPlan.runner!.url!)}
                >
                  <Activity size={13} /> Probe live health endpoint
                </button>
              </div>
            )}
            {deploymentPlan?.runner?.logs && (
              <details className="deployment-logs">
                <summary>Build and preflight logs</summary>
                <pre>{deploymentPlan.runner.logs}</pre>
              </details>
            )}
          </div>
        ) : (
          <div className="job-card">
            <div className="job-card-title">
              <span className="job-icon violet-icon">
                <Server size={17} />
              </span>
              <div>
                <strong>Project deployment</strong>
                <span>Stack recipe inspection</span>
              </div>
              <StatusBadge status="not_run" label="NOT RUN" />
            </div>
            <p>Inspect this snapshot to detect build manifests, runtime stacks, and health probes.</p>
            <div className="job-card-actions">
              <button type="button" className="button secondary small" disabled={busy} onClick={() => onRunDeploy(true)}>
                <Play size={13} /> Inspect &amp; verify deployment
              </button>
            </div>
          </div>
        )}
      </div>

      {analysis?.status === 'completed' && (
        <section className="ai-brief-card" aria-label="AI architecture brief">
          <div className="ai-brief-header">
            <div>
              <div className="section-kicker">GEMINI ARCHITECTURE SYNTHESIS</div>
              <h3>Executive Architecture Brief</h3>
            </div>
            <button type="button" className="button secondary small" disabled={busy} onClick={onGenerateBrief}>
              <Sparkles size={13} /> {brief ? 'Regenerate Brief' : 'Generate Architecture Brief'}
            </button>
          </div>
          {brief ? (
            <>
              <p className="ai-brief-summary">{brief.summary}</p>
              <div className="ai-brief-grid">
                <div className="ai-brief-col">
                  <h4>ENTRYPOINTS</h4>
                  <ul>
                    {brief.entrypoints.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="ai-brief-col">
                  <h4>CORE MODULES</h4>
                  <ul>
                    {brief.core_modules.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="ai-brief-col">
                  <h4>DATA &amp; CONTROL FLOW</h4>
                  <p>{brief.data_flow}</p>
                </div>
                <div className="ai-brief-col">
                  <h4>RISKS &amp; NOTES</h4>
                  <ul>
                    {brief.risks_and_notes.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 11, color: '#84908c' }}>
              Click &ldquo;Generate Architecture Brief&rdquo; to synthesize entrypoints, module responsibilities, data flow,
              and deployment considerations from the analyzed files.
            </p>
          )}
        </section>
      )}

      <section className="env-panel" aria-label="Project runtime environment variables">
        <div className="ai-brief-header">
          <div>
            <div className="section-kicker">ISOLATED RUNTIME CONFIGURATION</div>
            <h3>Target Project Environment Variables</h3>
          </div>
          <span style={{ font: '10px var(--mono)', color: '#7d8985' }}>
            <KeyRound size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Isolated from host secrets
          </span>
        </div>
        <form className="env-form" onSubmit={(e) => void saveEnvVar(e)}>
          <input
            type="text"
            placeholder="KEY_NAME (e.g. PORT)"
            value={envKey}
            onChange={(e) => setEnvKey(e.target.value)}
            maxLength={64}
          />
          <input
            type={envSecret ? 'password' : 'text'}
            placeholder="Value"
            value={envVal}
            onChange={(e) => setEnvVal(e.target.value)}
            maxLength={512}
          />
          <label className="env-secret-toggle">
            <input type="checkbox" checked={envSecret} onChange={(e) => setEnvSecret(e.target.checked)} />
            Mask value
          </label>
          <button type="submit" className="button secondary small" disabled={!envKey.trim() || !envVal}>
            <Plus size={13} /> Add variable
          </button>
        </form>
        {envVars.length > 0 && (
          <div className="env-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>KEY</th>
                  <th>VALUE</th>
                  <th>MODE</th>
                  <th>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {envVars.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <code>{v.key_name}</code>
                    </td>
                    <td>
                      <code>{v.masked_value}</code>
                    </td>
                    <td>{v.is_secret ? 'Secret (masked)' : 'Plaintext'}</td>
                    <td>
                      <button
                        type="button"
                        className="button secondary small danger-outline"
                        onClick={() => void removeEnvVar(v.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {analysis?.status === 'completed' && inventory && (
        <AnalysisExplorer
          result={inventory}
          projectId={project.id}
          snapshotId={activeSnapshot?.id ?? project.snapshot_id}
          initialView={explorerInitialView}
        />
      )}
      {analysis?.status === 'completed' && (
        <ProjectQA
          key={`${project.id}:${activeSnapshot?.id ?? project.snapshot_id ?? ''}`}
          projectId={project.id}
          snapshotId={activeSnapshot?.id ?? project.snapshot_id}
          csrfToken={csrfToken}
        />
      )}

      <div className="snapshot-details">
        <div>
          <span>CREATED</span>
          <strong>{(activeSnapshot?.created_at ?? project.created_at) ? new Date(activeSnapshot?.created_at ?? project.created_at).toLocaleString() : '—'}</strong>
        </div>
        <div>
          <span>SNAPSHOT SHA-256</span>
          <code>{activeSnapshot?.digest ?? project.digest ?? '—'}</code>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`status-badge ${status}`}>
      {status === 'completed' ? (
        <Check size={11} />
      ) : status === 'blocked' ? (
        <LockKeyhole size={11} />
      ) : (
        <span className="status-mini-dot" />
      )}
      {(label ?? status).toUpperCase()}
    </span>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default App;
