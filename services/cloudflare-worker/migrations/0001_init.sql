CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner, name)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'webhook',
  check_run_id INTEGER,
  started_at TEXT,
  ended_at TEXT,
  error_text TEXT,
  token_input INTEGER NOT NULL DEFAULT 0,
  token_output INTEGER NOT NULL DEFAULT 0,
  token_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_pr ON runs(repo_id, pr_number, id DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence REAL NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  title TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_dedupe ON findings(run_id, dedupe_key);

CREATE TABLE IF NOT EXISTS patches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT NOT NULL,
  diff_text TEXT NOT NULL,
  suggestions_json TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(finding_id) REFERENCES findings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_patches_finding ON patches(finding_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, created_at);
