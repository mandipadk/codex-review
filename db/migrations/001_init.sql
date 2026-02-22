create table if not exists repos (
  id serial primary key,
  owner text not null,
  name text not null,
  installation_id bigint not null,
  active boolean not null default true,
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner, name)
);

create table if not exists runs (
  id bigserial primary key,
  repo_id integer not null references repos(id) on delete cascade,
  pr_number integer not null,
  head_sha text not null,
  base_branch text not null,
  status text not null,
  trigger text not null default 'webhook',
  check_run_id bigint,
  started_at timestamptz,
  ended_at timestamptz,
  error_text text,
  token_input bigint not null default 0,
  token_output bigint not null default 0,
  token_total bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_runs_repo_pr_created on runs (repo_id, pr_number, id desc);
create index if not exists idx_runs_status on runs (status);

create table if not exists threads (
  id bigserial primary key,
  run_id bigint not null references runs(id) on delete cascade,
  role text not null,
  app_thread_id text not null,
  status text not null default 'active',
  last_turn_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, app_thread_id)
);

create table if not exists findings (
  id text primary key,
  run_id bigint not null references runs(id) on delete cascade,
  role text not null,
  severity text not null,
  confidence real not null,
  file_path text not null,
  start_line integer not null,
  end_line integer not null,
  title text not null,
  evidence_json jsonb not null,
  dedupe_key text not null,
  disposition text not null default 'open',
  created_at timestamptz not null default now()
);

create index if not exists idx_findings_run on findings (run_id);
create index if not exists idx_findings_dedupe on findings (run_id, dedupe_key);

create table if not exists patches (
  id bigserial primary key,
  finding_id text not null references findings(id) on delete cascade,
  thread_id bigint references threads(id) on delete set null,
  diff_text text not null,
  suggestions_json jsonb not null,
  status text not null,
  risk_notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_patches_finding on patches (finding_id);

create table if not exists events (
  id bigserial primary key,
  run_id bigint not null references runs(id) on delete cascade,
  source text not null,
  event_type text not null,
  payload_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_run on events (run_id, created_at);
