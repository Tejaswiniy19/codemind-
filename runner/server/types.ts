export type Evidence = {
  path?: string;
  line?: number | null;
  line_start?: number;
  line_end?: number;
  method?: string;
  claim?: string;
};

export type AnalysisFile = {
  path: string;
  language: string;
  parser: string;
  lines?: number;
  bytes?: number;
  role: string;
  role_confidence?: number;
  role_evidence?: Evidence;
};

export type AnalysisSymbol = {
  id?: string;
  path: string;
  name: string;
  qualified_name?: string;
  kind: string;
  line_start: number;
  line_end?: number;
  evidence?: Evidence;
};

export type AnalysisRelationship = {
  type: string;
  source_path: string;
  target_path?: string | null;
  target_module?: string;
  target_name?: string;
  resolved: boolean;
  confidence?: number;
  evidence?: Evidence;
};

export type AnalysisFramework = {
  name: string;
  confidence?: number;
  evidence?: Evidence[];
};

export type AnalysisFeature = {
  name: string;
  grouping_basis?: string;
  files: string[];
  observed_symbols?: number;
  symbols?: number;
  confidence?: number;
};

export type AnalysisResult = {
  status?: string;
  file_count?: number;
  analyzed_source_files?: number;
  symbol_count?: number;
  relationship_count?: number;
  files: AnalysisFile[];
  symbols?: AnalysisSymbol[];
  relationships?: AnalysisRelationship[];
  frameworks?: AnalysisFramework[];
  features?: AnalysisFeature[];
  languages?: {
    supported_languages?: Record<string, { analyzed_files?: number; parser?: string; depth?: string; limitations?: string[] }>;
    detected_languages?: Record<string, number>;
    unsupported_language_extensions?: Record<string, number>;
    skipped_ignored_files?: number;
    skipped_oversized_files?: number;
    skipped_analysis_budget_files?: number;
    skipped_binary_or_non_utf8_files?: number;
  };
  limitations?: string[];
};

export type RecipeCandidate = {
  stack: string;
  runtime_family: string;
  build_recipe_id: string | null;
  start_recipe_id: string | null;
  package_manager: string | null;
  entrypoint_hint: string | null;
  manifest_paths: string[];
  confidence: string;
  notes: string[];
};

export type PipelineStage = {
  name: string;
  status: 'passed' | 'blocked' | 'failed' | 'skipped';
  duration_ms: number;
  detail: string;
};

export type DeploymentPlan = {
  snapshot_id: string;
  source_digest: string;
  status: string;
  reason: string;
  candidates: RecipeCandidate[];
  project_files: string[];
  requires_isolated_runner: boolean;
  requires_review: boolean;
  allow_outbound_network?: boolean;
  stages?: PipelineStage[];
  limits?: {
    cpu_millicores: number;
    memory_mb: number;
    disk_mb: number;
    timeout_seconds: number;
  };
  runner?: {
    status: string;
    message: string;
    url: string | null;
    health_status?: string;
    logs: string | null;
    checked_at?: string;
  };
};

export type JobRecord = {
  id: string;
  kind: 'analysis' | 'deployment';
  status: string;
  message: string;
  created_at: string;
  updated_at: string;
  result?: AnalysisResult | DeploymentPlan | null;
};

export type SnapshotRecord = {
  id: string;
  project_id: string;
  version_num: number;
  digest: string;
  file_count: number;
  total_bytes: number;
  created_at: string;
  archive_base64: string;
  jobs: JobRecord[];
};

export type ProjectRecord = {
  id: string;
  name: string;
  source_type: 'zip' | 'folder' | 'github' | 'sample';
  repo_url: string | null;
  created_at: string;
  snapshots: SnapshotRecord[];
};

export type DeploymentRecord = {
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

export type ProjectEnvVar = {
  id: string;
  project_id: string;
  key_name: string;
  masked_value: string;
  is_secret: boolean;
  created_at: string;
};

export type AuditLogEntry = {
  id: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: string;
  created_at: string;
};

export type QAHistoryEntry = {
  id: string;
  project_id: string;
  snapshot_id: string;
  question: string;
  answer: string;
  citations: Array<{ path: string; start_line: number; end_line: number }>;
  model: string;
  created_at: string;
};

export type ArchitectureBrief = {
  summary: string;
  entrypoints: string[];
  core_modules: string[];
  data_flow: string;
  risks_and_notes: string[];
  model: string;
  generated_at: string;
};

export type WorkspaceSettings = {
  workspaceName: string;
  defaultExplain: boolean;
  defaultDeploy: boolean;
  defaultAllowBuildDownloads: boolean;
  runnerMode: 'dry-run' | 'disabled';
  pollingIntervalMs: number;
  storageQuotaMb: number;
  maxProjectsQuota: number;
};

export type AdminUser = {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  createdAt: string;
};

export type SessionRecord = {
  id: string;
  userId: string;
  username: string;
  csrfToken: string;
  expiresAt: string;
};
