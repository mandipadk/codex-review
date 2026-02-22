export type QueueJob =
  | { type: 'run_pr'; runId: number }
  | { type: 'cancel_run'; runId: number; reason?: string }
  | { type: 'explain_finding'; runId: number; findingId: string }
  | { type: 'patch_finding'; runId: number; findingId: string };

export interface AppConfig {
  maxRepos: number;
  topPatchCount: number;
  model: string;
  allowlist: Set<string>;
  autoOnboardWebhooks: boolean;
}

export interface AppConfigOverrides {
  topPatchCount?: number;
  model?: string;
  allowlist?: Set<string>;
  autoOnboardWebhooks?: boolean;
}

export interface Env {
  DB: D1Database;
  RUN_QUEUE: Queue<QueueJob>;

  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;

  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  APP_BASE_URL: string;

  MAX_REPOS?: string;
  TOP_PATCH_COUNT?: string;
  ALLOWED_REPOS?: string;
  AUTO_ONBOARD_WEBHOOKS?: string;
  SESSION_TTL_DAYS?: string;
}

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  installationId: number;
  active: boolean;
}

export interface RunRecord {
  id: number;
  repoId: number;
  prNumber: number;
  headSha: string;
  baseBranch: string;
  status: string;
  trigger: string;
  checkRunId: number | null;
}

export interface RunWithRepo extends RunRecord {
  repo: RepoRecord;
}

export type ReviewRole = 'correctness' | 'security' | 'maintainability';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  id: string;
  runId: number;
  role: ReviewRole;
  severity: Severity;
  confidence: number;
  filePath: string;
  startLine: number;
  endLine: number;
  title: string;
  issueKey: string;
  evidence: string;
  dedupeKey: string;
  supportingRoles: ReviewRole[];
  score: number;
}

export interface PatchSuggestion {
  filePath: string;
  startLine: number;
  endLine: number;
  body: string;
}

export interface PatchRecord {
  findingId: string;
  diffText: string;
  suggestions: PatchSuggestion[];
  riskNotes: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ParsedCommand {
  type: 'rerun' | 'explain' | 'patch' | 'stop';
  scope?: 'correctness' | 'security' | 'maintainability' | 'all';
  findingId?: string;
}

export interface DashboardUser {
  id: number;
  githubUserId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  accessToken: string;
}
