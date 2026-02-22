export type ReviewRole = 'correctness' | 'security' | 'maintainability';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  id: string;
  repo: string;
  prNumber: number;
  role: ReviewRole;
  severity: Severity;
  confidence: number;
  file: string;
  startLine: number;
  endLine: number;
  title: string;
  issueKey: string;
  evidence: Record<string, unknown>;
  dedupeKey: string;
}

export interface RankedFinding extends Finding {
  score: number;
  supportingRoles: ReviewRole[];
}

export interface PatchSuggestion {
  findingId: string;
  diff: string;
  suggestions: GithubSuggestion[];
  riskNotes: string;
}

export interface RunState {
  runId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface GithubSuggestion {
  filePath: string;
  startLine: number;
  endLine: number;
  body: string;
}

export type ChatOpsCommand =
  | { type: 'rerun'; scope: 'correctness' | 'security' | 'maintainability' | 'all' }
  | { type: 'explain'; findingId: string }
  | { type: 'patch'; findingId: string }
  | { type: 'stop' };
