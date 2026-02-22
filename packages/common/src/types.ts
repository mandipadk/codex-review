export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'cancel_requested';

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  installationId: number;
  active: boolean;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunRecord {
  id: number;
  repoId: number;
  prNumber: number;
  headSha: string;
  baseBranch: string;
  status: RunStatus;
  trigger: string;
  checkRunId: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  errorText: string | null;
  tokenInput: number;
  tokenOutput: number;
  tokenTotal: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunWithRepo extends RunRecord {
  repo: RepoRecord;
}

export interface ThreadRecord {
  id: number;
  runId: number;
  role: string;
  appThreadId: string;
  status: string;
  lastTurnId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersistedFindingInput {
  id: string;
  role: string;
  severity: string;
  confidence: number;
  filePath: string;
  startLine: number;
  endLine: number;
  title: string;
  evidence: Record<string, unknown>;
  dedupeKey: string;
  disposition?: string;
}

export interface FindingRecord {
  id: string;
  runId: number;
  role: string;
  severity: string;
  confidence: number;
  filePath: string;
  startLine: number;
  endLine: number;
  title: string;
  evidence: Record<string, unknown>;
  dedupeKey: string;
  disposition: string;
  createdAt: Date;
}

export interface PersistedPatchInput {
  findingId: string;
  threadId: number | null;
  diffText: string;
  suggestions: Array<Record<string, unknown>>;
  status: string;
  riskNotes?: string;
}

export interface PatchRecord {
  id: number;
  findingId: string;
  threadId: number | null;
  diffText: string;
  suggestions: Array<Record<string, unknown>>;
  status: string;
  riskNotes: string | null;
  createdAt: Date;
}

export interface EventRecord {
  id: number;
  runId: number;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
