import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.resolve(process.env.CODEMIND_DATA_DIR || '/tmp/codemind-data');
const DB_PATH = path.join(DATA_DIR, 'codemind.sqlite3');

let dbInstance: DatabaseSync | null = null;

export function getDbPath(): string {
  return DB_PATH;
}

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'zip',
      repo_url TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version_num INTEGER NOT NULL DEFAULT 1,
      digest TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      archive_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      version_num INTEGER NOT NULL,
      environment TEXT NOT NULL DEFAULT 'sandbox',
      status TEXT NOT NULL,
      stack TEXT NOT NULL,
      runtime_family TEXT NOT NULL,
      public_url TEXT,
      health_status TEXT NOT NULL,
      allow_outbound_network INTEGER NOT NULL DEFAULT 0,
      cpu_millicores INTEGER NOT NULL DEFAULT 500,
      memory_mb INTEGER NOT NULL DEFAULT 512,
      logs_text TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_env_vars (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key_name TEXT NOT NULL,
      masked_value TEXT NOT NULL,
      raw_value TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, key_name)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qa_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      citations_json TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS architecture_briefs (
      snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
      brief_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `);
  dbInstance = db;
  return dbInstance;
}

export function getDatabaseTelemetry() {
  const db = getDb();
  const tables = [
    'users',
    'sessions',
    'projects',
    'snapshots',
    'jobs',
    'deployments',
    'project_env_vars',
    'audit_logs',
    'qa_history',
    'architecture_briefs',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number } | undefined;
    counts[table] = Number(row?.count ?? 0);
  }
  let fileSizeBytes = 0;
  try {
    fileSizeBytes = fs.statSync(DB_PATH).size;
  } catch {
    fileSizeBytes = 0;
  }
  const totalBytesRow = db.prepare('SELECT COALESCE(SUM(total_bytes), 0) AS bytes FROM snapshots').get() as
    | { bytes: number }
    | undefined;
  return {
    engine: 'SQLite 3 (WAL mode)',
    path: DB_PATH,
    db_file_bytes: fileSizeBytes,
    total_snapshot_bytes: Number(totalBytesRow?.bytes ?? 0),
    table_counts: counts,
  };
}
