import { Pool } from 'pg';

import {
  EventRecord,
  FindingRecord,
  PatchRecord,
  PersistedFindingInput,
  PersistedPatchInput,
  RepoRecord,
  RunRecord,
  RunStatus,
  RunWithRepo,
  ThreadRecord,
  TokenUsageTotals
} from './types.js';

interface CreateRunInput {
  repoId: number;
  prNumber: number;
  headSha: string;
  baseBranch: string;
  trigger: string;
}

interface UpsertRepoInput {
  owner: string;
  name: string;
  installationId: number;
  config?: Record<string, unknown>;
}

const mapRepo = (row: Record<string, unknown>): RepoRecord => ({
  id: Number(row.id),
  owner: String(row.owner),
  name: String(row.name),
  installationId: Number(row.installation_id),
  active: Boolean(row.active),
  config: (row.config_json as Record<string, unknown>) ?? {},
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at))
});

const mapRun = (row: Record<string, unknown>): RunRecord => ({
  id: Number(row.id),
  repoId: Number(row.repo_id),
  prNumber: Number(row.pr_number),
  headSha: String(row.head_sha),
  baseBranch: String(row.base_branch),
  status: String(row.status) as RunStatus,
  trigger: String(row.trigger),
  checkRunId: row.check_run_id === null ? null : Number(row.check_run_id),
  startedAt: row.started_at ? new Date(String(row.started_at)) : null,
  endedAt: row.ended_at ? new Date(String(row.ended_at)) : null,
  errorText: row.error_text ? String(row.error_text) : null,
  tokenInput: Number(row.token_input),
  tokenOutput: Number(row.token_output),
  tokenTotal: Number(row.token_total),
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at))
});

const mapThread = (row: Record<string, unknown>): ThreadRecord => ({
  id: Number(row.id),
  runId: Number(row.run_id),
  role: String(row.role),
  appThreadId: String(row.app_thread_id),
  status: String(row.status),
  lastTurnId: row.last_turn_id ? String(row.last_turn_id) : null,
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at))
});

const mapFinding = (row: Record<string, unknown>): FindingRecord => ({
  id: String(row.id),
  runId: Number(row.run_id),
  role: String(row.role),
  severity: String(row.severity),
  confidence: Number(row.confidence),
  filePath: String(row.file_path),
  startLine: Number(row.start_line),
  endLine: Number(row.end_line),
  title: String(row.title),
  evidence: (row.evidence_json as Record<string, unknown>) ?? {},
  dedupeKey: String(row.dedupe_key),
  disposition: String(row.disposition),
  createdAt: new Date(String(row.created_at))
});

const mapPatch = (row: Record<string, unknown>): PatchRecord => ({
  id: Number(row.id),
  findingId: String(row.finding_id),
  threadId: row.thread_id === null ? null : Number(row.thread_id),
  diffText: String(row.diff_text),
  suggestions: (row.suggestions_json as Array<Record<string, unknown>>) ?? [],
  status: String(row.status),
  riskNotes: row.risk_notes ? String(row.risk_notes) : null,
  createdAt: new Date(String(row.created_at))
});

const mapEvent = (row: Record<string, unknown>): EventRecord => ({
  id: Number(row.id),
  runId: Number(row.run_id),
  source: String(row.source),
  eventType: String(row.event_type),
  payload: (row.payload_json as Record<string, unknown>) ?? {},
  createdAt: new Date(String(row.created_at))
});

export class RunStore {
  constructor(private readonly pool: Pool) {}

  async upsertRepo(input: UpsertRepoInput): Promise<RepoRecord> {
    const query = `
      insert into repos (owner, name, installation_id, config_json, active)
      values ($1, $2, $3, $4::jsonb, true)
      on conflict (owner, name)
      do update set
        installation_id = excluded.installation_id,
        config_json = excluded.config_json,
        active = true,
        updated_at = now()
      returning *
    `;

    const result = await this.pool.query(query, [
      input.owner,
      input.name,
      input.installationId,
      JSON.stringify(input.config ?? {})
    ]);

    return mapRepo(result.rows[0]);
  }

  async countActiveRepos(): Promise<number> {
    const result = await this.pool.query<{ count: string }>('select count(*)::text as count from repos where active = true');
    return Number(result.rows[0]?.count ?? '0');
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const query = `
      insert into runs (repo_id, pr_number, head_sha, base_branch, status, trigger)
      values ($1, $2, $3, $4, 'queued', $5)
      returning *
    `;

    const result = await this.pool.query(query, [
      input.repoId,
      input.prNumber,
      input.headSha,
      input.baseBranch,
      input.trigger
    ]);

    return mapRun(result.rows[0]);
  }

  async cancelStaleRuns(repoId: number, prNumber: number, headSha: string): Promise<number[]> {
    const result = await this.pool.query<{ id: number }>(
      `
        update runs
        set
          status = 'canceled',
          ended_at = coalesce(ended_at, now()),
          error_text = 'Superseded by newer head SHA',
          updated_at = now()
        where
          repo_id = $1
          and pr_number = $2
          and head_sha <> $3
          and status in ('queued', 'running', 'cancel_requested')
        returning id
      `,
      [repoId, prNumber, headSha]
    );

    return result.rows.map((row) => Number(row.id));
  }

  async getRun(runId: number): Promise<RunRecord | null> {
    const result = await this.pool.query('select * from runs where id = $1', [runId]);
    if (result.rowCount === 0) {
      return null;
    }

    return mapRun(result.rows[0]);
  }

  async getRunWithRepo(runId: number): Promise<RunWithRepo | null> {
    const run = await this.getRun(runId);
    if (!run) {
      return null;
    }

    const repo = await this.getRepoById(run.repoId);
    if (!repo) {
      return null;
    }

    return { ...run, repo };
  }

  async getRepoById(repoId: number): Promise<RepoRecord | null> {
    const result = await this.pool.query('select * from repos where id = $1', [repoId]);
    if (result.rowCount === 0) {
      return null;
    }

    return mapRepo(result.rows[0]);
  }

  async getRepoByOwnerAndName(owner: string, name: string): Promise<RepoRecord | null> {
    const result = await this.pool.query('select * from repos where lower(owner) = lower($1) and lower(name) = lower($2)', [
      owner,
      name
    ]);

    if (result.rowCount === 0) {
      return null;
    }

    return mapRepo(result.rows[0]);
  }

  async getLatestRunForPr(repoId: number, prNumber: number): Promise<RunRecord | null> {
    const result = await this.pool.query(
      `
      select *
      from runs
      where repo_id = $1 and pr_number = $2
      order by id desc
      limit 1
      `,
      [repoId, prNumber]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRun(result.rows[0]);
  }

  async getLatestRunWithRepoByPr(owner: string, name: string, prNumber: number): Promise<RunWithRepo | null> {
    const result = await this.pool.query(
      `
      select r.*
      from runs r
      join repos re on re.id = r.repo_id
      where lower(re.owner) = lower($1)
        and lower(re.name) = lower($2)
        and r.pr_number = $3
      order by r.id desc
      limit 1
      `,
      [owner, name, prNumber]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const run = mapRun(result.rows[0]);
    const repo = await this.getRepoById(run.repoId);
    if (!repo) {
      return null;
    }

    return { ...run, repo };
  }

  async findRunningRun(repoId: number, prNumber: number): Promise<RunRecord | null> {
    const result = await this.pool.query(
      `
      select *
      from runs
      where repo_id = $1
        and pr_number = $2
        and status in ('running', 'cancel_requested')
      order by id desc
      limit 1
      `,
      [repoId, prNumber]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRun(result.rows[0]);
  }

  async updateRunStatus(runId: number, status: RunStatus, errorText?: string): Promise<void> {
    const shouldSetStarted = status === 'running';
    const shouldSetEnded = status === 'completed' || status === 'failed' || status === 'canceled';

    await this.pool.query(
      `
      update runs
      set
        status = $2,
        error_text = coalesce($3, error_text),
        started_at = case
          when $4 and started_at is null then now()
          else started_at
        end,
        ended_at = case
          when $5 then now()
          else ended_at
        end,
        updated_at = now()
      where id = $1
      `,
      [runId, status, errorText ?? null, shouldSetStarted, shouldSetEnded]
    );
  }

  async requestCancel(runId: number, reason?: string): Promise<void> {
    await this.pool.query(
      `
      update runs
      set
        status = case
          when status in ('queued', 'running') then 'cancel_requested'
          else status
        end,
        error_text = coalesce($2, error_text),
        updated_at = now()
      where id = $1
      `,
      [runId, reason ?? 'Cancellation requested']
    );
  }

  async isCancellationRequested(runId: number): Promise<boolean> {
    const result = await this.pool.query<{ status: string }>('select status from runs where id = $1', [runId]);
    if (result.rowCount === 0) {
      return false;
    }

    const status = result.rows[0]?.status;
    return status === 'cancel_requested' || status === 'canceled';
  }

  async setCheckRunId(runId: number, checkRunId: number): Promise<void> {
    await this.pool.query('update runs set check_run_id = $2, updated_at = now() where id = $1', [runId, checkRunId]);
  }

  async recordTokenUsage(runId: number, totals: TokenUsageTotals): Promise<void> {
    await this.pool.query(
      `
      update runs
      set
        token_input = $2,
        token_output = $3,
        token_total = $4,
        updated_at = now()
      where id = $1
      `,
      [runId, totals.inputTokens, totals.outputTokens, totals.totalTokens]
    );
  }

  async insertThread(runId: number, role: string, appThreadId: string, status = 'active'): Promise<ThreadRecord> {
    const result = await this.pool.query(
      `
      insert into threads (run_id, role, app_thread_id, status)
      values ($1, $2, $3, $4)
      returning *
      `,
      [runId, role, appThreadId, status]
    );

    return mapThread(result.rows[0]);
  }

  async updateThreadTurn(runId: number, appThreadId: string, turnId: string, status?: string): Promise<void> {
    await this.pool.query(
      `
      update threads
      set
        last_turn_id = $3,
        status = coalesce($4, status),
        updated_at = now()
      where run_id = $1 and app_thread_id = $2
      `,
      [runId, appThreadId, turnId, status ?? null]
    );
  }

  async insertEvent(runId: number, source: string, eventType: string, payload: Record<string, unknown>): Promise<EventRecord> {
    const result = await this.pool.query(
      `
      insert into events (run_id, source, event_type, payload_json)
      values ($1, $2, $3, $4::jsonb)
      returning *
      `,
      [runId, source, eventType, JSON.stringify(payload)]
    );

    return mapEvent(result.rows[0]);
  }

  async insertFindings(runId: number, findings: PersistedFindingInput[]): Promise<void> {
    if (findings.length === 0) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('begin');

      for (const finding of findings) {
        await client.query(
          `
          insert into findings (
            id,
            run_id,
            role,
            severity,
            confidence,
            file_path,
            start_line,
            end_line,
            title,
            evidence_json,
            dedupe_key,
            disposition
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
          on conflict (id)
          do update set
            role = excluded.role,
            severity = excluded.severity,
            confidence = excluded.confidence,
            file_path = excluded.file_path,
            start_line = excluded.start_line,
            end_line = excluded.end_line,
            title = excluded.title,
            evidence_json = excluded.evidence_json,
            dedupe_key = excluded.dedupe_key,
            disposition = excluded.disposition
          `,
          [
            finding.id,
            runId,
            finding.role,
            finding.severity,
            finding.confidence,
            finding.filePath,
            finding.startLine,
            finding.endLine,
            finding.title,
            JSON.stringify(finding.evidence),
            finding.dedupeKey,
            finding.disposition ?? 'open'
          ]
        );
      }

      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async listFindings(runId: number): Promise<FindingRecord[]> {
    const result = await this.pool.query('select * from findings where run_id = $1 order by created_at asc', [runId]);
    return result.rows.map(mapFinding);
  }

  async getFinding(runId: number, findingId: string): Promise<FindingRecord | null> {
    const result = await this.pool.query('select * from findings where run_id = $1 and id = $2', [runId, findingId]);
    if (result.rowCount === 0) {
      return null;
    }

    return mapFinding(result.rows[0]);
  }

  async insertPatch(input: PersistedPatchInput): Promise<PatchRecord> {
    const result = await this.pool.query(
      `
      insert into patches (finding_id, thread_id, diff_text, suggestions_json, status, risk_notes)
      values ($1, $2, $3, $4::jsonb, $5, $6)
      returning *
      `,
      [
        input.findingId,
        input.threadId,
        input.diffText,
        JSON.stringify(input.suggestions),
        input.status,
        input.riskNotes ?? null
      ]
    );

    return mapPatch(result.rows[0]);
  }

  async listPatchesForFinding(findingId: string): Promise<PatchRecord[]> {
    const result = await this.pool.query('select * from patches where finding_id = $1 order by id desc', [findingId]);
    return result.rows.map(mapPatch);
  }

  async listPatchesForRun(runId: number): Promise<PatchRecord[]> {
    const result = await this.pool.query(
      `
      select p.*
      from patches p
      join findings f on f.id = p.finding_id
      where f.run_id = $1
      order by p.id asc
      `,
      [runId]
    );

    return result.rows.map(mapPatch);
  }

  async listEvents(runId: number): Promise<EventRecord[]> {
    const result = await this.pool.query('select * from events where run_id = $1 order by created_at asc', [runId]);
    return result.rows.map(mapEvent);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
