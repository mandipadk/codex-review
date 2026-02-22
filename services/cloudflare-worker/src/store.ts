import { AppConfigOverrides, DashboardUser, Finding, PatchRecord, RepoRecord, RunRecord, RunWithRepo, TokenUsage } from './types.js';

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  installation_id: number;
  active: number;
}

interface RunRow {
  id: number;
  repo_id: number;
  pr_number: number;
  head_sha: string;
  base_branch: string;
  status: string;
  trigger: string;
  check_run_id: number | null;
}

interface FindingRow {
  id: string;
  run_id: number;
  role: string;
  severity: string;
  confidence: number;
  file_path: string;
  start_line: number;
  end_line: number;
  title: string;
  issue_key: string;
  evidence_json: string;
  dedupe_key: string;
}

interface PatchRow {
  finding_id: string;
  diff_text: string;
  suggestions_json: string;
  risk_notes: string | null;
}

interface UserRow {
  id: number;
  github_user_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  access_token: string;
}

interface SessionUserRow extends UserRow {
  expires_at: number;
}

interface SettingRow {
  key: string;
  value_json: string;
}

export class D1Store {
  constructor(private readonly db: D1Database) {}

  async countActiveRepos(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS count FROM repos WHERE active = 1').first<{ count: number | string }>();
    return Number(row?.count ?? 0);
  }

  async listRepos(): Promise<RepoRecord[]> {
    const result = await this.db
      .prepare('SELECT id, owner, name, installation_id, active FROM repos ORDER BY lower(owner), lower(name)')
      .all<RepoRow>();

    return (result.results ?? []).map(mapRepo);
  }

  async getRepoByOwnerAndName(owner: string, name: string): Promise<RepoRecord | null> {
    const row = await this.db
      .prepare('SELECT id, owner, name, installation_id, active FROM repos WHERE lower(owner) = lower(?) AND lower(name) = lower(?) LIMIT 1')
      .bind(owner, name)
      .first<RepoRow>();

    if (!row) {
      return null;
    }

    return mapRepo(row);
  }

  async upsertRepo(input: { owner: string; name: string; installationId: number; active?: boolean }): Promise<RepoRecord> {
    const active = input.active === false ? 0 : 1;

    await this.db
      .prepare(
        `INSERT INTO repos (owner, name, installation_id, active, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(owner, name)
         DO UPDATE SET
           installation_id = excluded.installation_id,
           active = excluded.active,
           updated_at = datetime('now')`
      )
      .bind(input.owner, input.name, input.installationId, active)
      .run();

    const repo = await this.getRepoByOwnerAndName(input.owner, input.name);
    if (!repo) {
      throw new Error('Repo upsert failed unexpectedly');
    }

    return repo;
  }

  async setRepoActive(repoId: number, active: boolean): Promise<void> {
    await this.db
      .prepare("UPDATE repos SET active = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(active ? 1 : 0, repoId)
      .run();
  }

  async setRepoActiveByOwnerAndName(owner: string, name: string, active: boolean): Promise<void> {
    await this.db
      .prepare("UPDATE repos SET active = ?, updated_at = datetime('now') WHERE lower(owner) = lower(?) AND lower(name) = lower(?)")
      .bind(active ? 1 : 0, owner, name)
      .run();
  }

  async cancelStaleRuns(repoId: number, prNumber: number, headSha: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runs
         SET
           status = 'canceled',
           ended_at = COALESCE(ended_at, datetime('now')),
           error_text = 'Superseded by newer head SHA',
           updated_at = datetime('now')
         WHERE
           repo_id = ?
           AND pr_number = ?
           AND head_sha <> ?
           AND status IN ('queued', 'running', 'cancel_requested')`
      )
      .bind(repoId, prNumber, headSha)
      .run();
  }

  async createRun(input: {
    repoId: number;
    prNumber: number;
    headSha: string;
    baseBranch: string;
    trigger: string;
  }): Promise<RunRecord> {
    const result = await this.db
      .prepare(
        `INSERT INTO runs (repo_id, pr_number, head_sha, base_branch, status, trigger, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, datetime('now'))`
      )
      .bind(input.repoId, input.prNumber, input.headSha, input.baseBranch, input.trigger)
      .run();

    const insertedId = Number(result.meta.last_row_id ?? 0);
    const run = await this.getRun(insertedId);
    if (!run) {
      throw new Error('Run create failed unexpectedly');
    }

    return run;
  }

  async getRun(runId: number): Promise<RunRecord | null> {
    const row = await this.db
      .prepare('SELECT id, repo_id, pr_number, head_sha, base_branch, status, trigger, check_run_id FROM runs WHERE id = ? LIMIT 1')
      .bind(runId)
      .first<RunRow>();

    if (!row) {
      return null;
    }

    return mapRun(row);
  }

  async getRunWithRepo(runId: number): Promise<RunWithRepo | null> {
    const row = await this.db
      .prepare(
        `SELECT
           r.id,
           r.repo_id,
           r.pr_number,
           r.head_sha,
           r.base_branch,
           r.status,
           r.trigger,
           r.check_run_id,
           re.owner,
           re.name,
           re.installation_id,
           re.active
         FROM runs r
         JOIN repos re ON re.id = r.repo_id
         WHERE r.id = ?
         LIMIT 1`
      )
      .bind(runId)
      .first<RunRow & { owner: string; name: string; installation_id: number; active: number }>();

    if (!row) {
      return null;
    }

    return {
      ...mapRun(row),
      repo: {
        id: Number(row.repo_id),
        owner: row.owner,
        name: row.name,
        installationId: Number(row.installation_id),
        active: Number(row.active) === 1
      }
    };
  }

  async getLatestRunWithRepoByPr(owner: string, name: string, prNumber: number): Promise<RunWithRepo | null> {
    const row = await this.db
      .prepare(
        `SELECT
           r.id,
           r.repo_id,
           r.pr_number,
           r.head_sha,
           r.base_branch,
           r.status,
           r.trigger,
           r.check_run_id,
           re.owner,
           re.name,
           re.installation_id,
           re.active
         FROM runs r
         JOIN repos re ON re.id = r.repo_id
         WHERE lower(re.owner) = lower(?) AND lower(re.name) = lower(?) AND r.pr_number = ?
         ORDER BY r.id DESC
         LIMIT 1`
      )
      .bind(owner, name, prNumber)
      .first<RunRow & { owner: string; name: string; installation_id: number; active: number }>();

    if (!row) {
      return null;
    }

    return {
      ...mapRun(row),
      repo: {
        id: Number(row.repo_id),
        owner: row.owner,
        name: row.name,
        installationId: Number(row.installation_id),
        active: Number(row.active) === 1
      }
    };
  }

  async findRunningRun(repoId: number, prNumber: number): Promise<RunRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, repo_id, pr_number, head_sha, base_branch, status, trigger, check_run_id
         FROM runs
         WHERE repo_id = ? AND pr_number = ? AND status IN ('running', 'cancel_requested')
         ORDER BY id DESC LIMIT 1`
      )
      .bind(repoId, prNumber)
      .first<RunRow>();

    if (!row) {
      return null;
    }

    return mapRun(row);
  }

  async updateRunStatus(runId: number, status: string, errorText?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runs
         SET
           status = ?,
           error_text = COALESCE(?, error_text),
           started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN datetime('now') ELSE started_at END,
           ended_at = CASE WHEN ? IN ('completed', 'failed', 'canceled') THEN datetime('now') ELSE ended_at END,
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(status, errorText ?? null, status, status, runId)
      .run();
  }

  async requestCancel(runId: number, reason?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runs
         SET
           status = CASE WHEN status IN ('queued', 'running') THEN 'cancel_requested' ELSE status END,
           error_text = COALESCE(?, error_text),
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(reason ?? 'Cancellation requested', runId)
      .run();
  }

  async isCancellationRequested(runId: number): Promise<boolean> {
    const row = await this.db.prepare('SELECT status FROM runs WHERE id = ? LIMIT 1').bind(runId).first<{ status: string }>();
    if (!row) {
      return false;
    }

    return row.status === 'cancel_requested' || row.status === 'canceled';
  }

  async setCheckRunId(runId: number, checkRunId: number): Promise<void> {
    await this.db
      .prepare('UPDATE runs SET check_run_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(checkRunId, runId)
      .run();
  }

  async recordTokenUsage(runId: number, usage: TokenUsage): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runs
         SET
           token_input = ?,
           token_output = ?,
           token_total = ?,
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(usage.inputTokens, usage.outputTokens, usage.totalTokens, runId)
      .run();
  }

  async insertEvent(runId: number, source: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.db
      .prepare('INSERT INTO events (run_id, source, event_type, payload_json) VALUES (?, ?, ?, ?)')
      .bind(runId, source, eventType, JSON.stringify(payload))
      .run();
  }

  async insertFinding(finding: Finding): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO findings
           (id, run_id, role, severity, confidence, file_path, start_line, end_line, title, issue_key, evidence_json, dedupe_key, disposition)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
      )
      .bind(
        finding.id,
        finding.runId,
        finding.role,
        finding.severity,
        finding.confidence,
        finding.filePath,
        finding.startLine,
        finding.endLine,
        finding.title,
        finding.issueKey,
        JSON.stringify({
          evidence: finding.evidence,
          supportingRoles: finding.supportingRoles,
          score: finding.score
        }),
        finding.dedupeKey
      )
      .run();
  }

  async listFindings(runId: number): Promise<Finding[]> {
    const result = await this.db
      .prepare(
        `SELECT id, run_id, role, severity, confidence, file_path, start_line, end_line, title, issue_key, evidence_json, dedupe_key
         FROM findings
         WHERE run_id = ?
         ORDER BY created_at ASC`
      )
      .bind(runId)
      .all<FindingRow>();

    return (result.results ?? []).map(mapFinding);
  }

  async getFinding(runId: number, findingId: string): Promise<Finding | null> {
    const row = await this.db
      .prepare(
        `SELECT id, run_id, role, severity, confidence, file_path, start_line, end_line, title, issue_key, evidence_json, dedupe_key
         FROM findings
         WHERE run_id = ? AND id = ?
         LIMIT 1`
      )
      .bind(runId, findingId)
      .first<FindingRow>();

    if (!row) {
      return null;
    }

    return mapFinding(row);
  }

  async deleteFindingsForRun(runId: number): Promise<void> {
    await this.db.prepare('DELETE FROM findings WHERE run_id = ?').bind(runId).run();
  }

  async insertPatch(patch: PatchRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO patches (finding_id, diff_text, suggestions_json, status, risk_notes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        patch.findingId,
        patch.diffText,
        JSON.stringify(patch.suggestions),
        patch.suggestions.length > 0 ? 'ready' : 'no_suggestion',
        patch.riskNotes
      )
      .run();
  }

  async listPatchesForFinding(findingId: string): Promise<PatchRecord[]> {
    const result = await this.db
      .prepare('SELECT finding_id, diff_text, suggestions_json, risk_notes FROM patches WHERE finding_id = ? ORDER BY id DESC')
      .bind(findingId)
      .all<PatchRow>();

    return (result.results ?? []).map(mapPatch);
  }

  async listPatchesForRun(runId: number): Promise<PatchRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT p.finding_id, p.diff_text, p.suggestions_json, p.risk_notes
         FROM patches p
         JOIN findings f ON f.id = p.finding_id
         WHERE f.run_id = ?
         ORDER BY p.id ASC`
      )
      .bind(runId)
      .all<PatchRow>();

    return (result.results ?? []).map(mapPatch);
  }

  async upsertDashboardUser(input: {
    githubUserId: number;
    login: string;
    name: string | null;
    avatarUrl: string | null;
    accessToken: string;
  }): Promise<DashboardUser> {
    await this.db
      .prepare(
        `INSERT INTO users (github_user_id, login, name, avatar_url, access_token, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(github_user_id)
         DO UPDATE SET
           login = excluded.login,
           name = excluded.name,
           avatar_url = excluded.avatar_url,
           access_token = excluded.access_token,
           updated_at = datetime('now')`
      )
      .bind(input.githubUserId, input.login, input.name, input.avatarUrl, input.accessToken)
      .run();

    const row = await this.db
      .prepare(
        `SELECT id, github_user_id, login, name, avatar_url, access_token
         FROM users
         WHERE github_user_id = ?
         LIMIT 1`
      )
      .bind(input.githubUserId)
      .first<UserRow>();

    if (!row) {
      throw new Error('Dashboard user upsert failed unexpectedly');
    }

    return mapDashboardUser(row);
  }

  async createSession(userId: number, tokenHash: string, expiresAt: number): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();

    await this.db
      .prepare('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .bind(userId, tokenHash, Math.floor(expiresAt))
      .run();
  }

  async getDashboardUserBySessionTokenHash(tokenHash: string): Promise<DashboardUser | null> {
    const row = await this.db
      .prepare(
        `SELECT
           u.id,
           u.github_user_id,
           u.login,
           u.name,
           u.avatar_url,
           u.access_token,
           s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > unixepoch()
         ORDER BY s.id DESC
         LIMIT 1`
      )
      .bind(tokenHash)
      .first<SessionUserRow>();

    if (!row) {
      return null;
    }

    return mapDashboardUser(row);
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }

  async pruneExpiredSessions(): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE expires_at <= unixepoch()').run();
  }

  async setAppSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key)
         DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = datetime('now')`
      )
      .bind(key, JSON.stringify(value))
      .run();
  }

  async getAppSettings(): Promise<Record<string, unknown>> {
    const result = await this.db.prepare('SELECT key, value_json FROM app_settings').all<SettingRow>();
    const output: Record<string, unknown> = {};

    for (const row of result.results ?? []) {
      output[row.key] = safeJsonParse(row.value_json);
    }

    return output;
  }

  async getConfigOverrides(): Promise<AppConfigOverrides> {
    const settings = await this.getAppSettings();
    const overrides: AppConfigOverrides = {};

    if (typeof settings.topPatchCount === 'number' && Number.isInteger(settings.topPatchCount) && settings.topPatchCount > 0) {
      overrides.topPatchCount = settings.topPatchCount;
    }

    if (typeof settings.model === 'string' && settings.model.trim()) {
      overrides.model = settings.model.trim();
    }

    if (typeof settings.autoOnboardWebhooks === 'boolean') {
      overrides.autoOnboardWebhooks = settings.autoOnboardWebhooks;
    }

    if (Array.isArray(settings.allowlist)) {
      const normalized = settings.allowlist
        .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
        .filter((entry) => entry.length > 0);
      overrides.allowlist = new Set(normalized);
    }

    return overrides;
  }
}

function mapRepo(row: RepoRow): RepoRecord {
  return {
    id: Number(row.id),
    owner: row.owner,
    name: row.name,
    installationId: Number(row.installation_id),
    active: Number(row.active) === 1
  };
}

function mapDashboardUser(row: UserRow): DashboardUser {
  return {
    id: Number(row.id),
    githubUserId: Number(row.github_user_id),
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    accessToken: row.access_token
  };
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: Number(row.id),
    repoId: Number(row.repo_id),
    prNumber: Number(row.pr_number),
    headSha: row.head_sha,
    baseBranch: row.base_branch,
    status: row.status,
    trigger: row.trigger,
    checkRunId: row.check_run_id === null ? null : Number(row.check_run_id)
  };
}

function mapFinding(row: FindingRow): Finding {
  const evidencePayload = safeJsonParse(row.evidence_json) as {
    evidence?: string;
    supportingRoles?: string[];
    score?: number;
  };

  const supportingRoles = Array.isArray(evidencePayload.supportingRoles)
    ? (evidencePayload.supportingRoles.filter((role) => role === 'correctness' || role === 'security' || role === 'maintainability') as Finding['supportingRoles'])
    : ([row.role] as Finding['supportingRoles']);

  return {
    id: row.id,
    runId: Number(row.run_id),
    role: asRole(row.role),
    severity: asSeverity(row.severity),
    confidence: Number(row.confidence),
    filePath: row.file_path,
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    title: row.title,
    issueKey: row.issue_key,
    evidence: evidencePayload.evidence ?? '',
    dedupeKey: row.dedupe_key,
    supportingRoles,
    score: typeof evidencePayload.score === 'number' ? evidencePayload.score : 0
  };
}

function mapPatch(row: PatchRow): PatchRecord {
  const suggestions = safeJsonParse(row.suggestions_json);

  return {
    findingId: row.finding_id,
    diffText: row.diff_text,
    suggestions: Array.isArray(suggestions)
      ? suggestions
          .filter((item) => item && typeof item === 'object')
          .map((item) => {
            const entry = item as Record<string, unknown>;
            return {
              filePath: String(entry.filePath ?? ''),
              startLine: Number(entry.startLine ?? 1),
              endLine: Number(entry.endLine ?? 1),
              body: String(entry.body ?? '')
            };
          })
      : [],
    riskNotes: row.risk_notes ?? 'Patch suggestion generated.'
  };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asRole(value: string): Finding['role'] {
  if (value === 'correctness' || value === 'security' || value === 'maintainability') {
    return value;
  }
  return 'correctness';
}

function asSeverity(value: string): Finding['severity'] {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return 'medium';
}
