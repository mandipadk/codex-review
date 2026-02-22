import { applyConfigOverrides, readConfig } from './config.js';
import { shortHash } from './crypto.js';
import {
  createCheckRun,
  createInstallationToken,
  createIssueComment,
  listPullRequestFiles,
  updateCheckRun
} from './github.js';
import { runOpenAIStructuredOutput } from './openai.js';
import { dedupeAndRankFindings } from './ranking.js';
import {
  renderConsolidatedComment,
  renderExplainComment,
  renderPatchComment,
  renderSummary
} from './render.js';
import { D1Store } from './store.js';
import {
  Env,
  Finding,
  PatchRecord,
  PatchSuggestion,
  PullRequestFile,
  QueueJob,
  ReviewRole,
  RunWithRepo,
  Severity,
  TokenUsage
} from './types.js';

const ROLE_PROMPTS: Array<{ role: ReviewRole; systemPrompt: string }> = [
  {
    role: 'correctness',
    systemPrompt:
      'You are a strict correctness reviewer. Focus on behavior regressions, logic bugs, data corruption risks, and race conditions. Ignore cosmetic style issues.'
  },
  {
    role: 'security',
    systemPrompt:
      'You are a security reviewer. Focus on injection, authn/authz flaws, secret leakage, unsafe deserialization, SSRF, and privilege escalation.'
  },
  {
    role: 'maintainability',
    systemPrompt:
      'You are a maintainability reviewer. Focus on brittle abstractions, dangerous coupling, unclear ownership, and high-change-risk code smells.'
  }
];

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'confidence', 'filePath', 'startLine', 'endLine', 'issueKey', 'evidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          filePath: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          issueKey: { type: 'string' },
          evidence: { type: 'string' }
        }
      }
    }
  }
} as const;

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['riskNotes', 'suggestions'],
  properties: {
    riskNotes: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['filePath', 'startLine', 'endLine', 'body'],
        properties: {
          filePath: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          body: { type: 'string' }
        }
      }
    }
  }
} as const;

interface PersonaOutput {
  findings: Finding[];
  usage: TokenUsage;
}

interface PatchOutput {
  riskNotes: string;
  suggestions: PatchSuggestion[];
}

export async function handleQueueJob(env: Env, job: QueueJob): Promise<void> {
  switch (job.type) {
    case 'run_pr':
      await runPullRequestAnalysis(env, job.runId);
      return;
    case 'cancel_run':
      await cancelRun(env, job.runId, job.reason);
      return;
    case 'explain_finding':
      await explainFinding(env, job.runId, job.findingId);
      return;
    case 'patch_finding':
      await postPatchForFinding(env, job.runId, job.findingId);
      return;
    default:
      return;
  }
}

async function runPullRequestAnalysis(env: Env, runId: number): Promise<void> {
  const store = new D1Store(env.DB);
  const config = applyConfigOverrides(readConfig(env), await store.getConfigOverrides());
  const run = await store.getRunWithRepo(runId);

  if (!run) {
    return;
  }

  await store.updateRunStatus(runId, 'running');

  const installationToken = await createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, run.repo.installationId);

  let checkRunId: number | null = null;

  try {
    checkRunId = await createCheckRun(
      installationToken,
      run.repo.owner,
      run.repo.name,
      run.headSha,
      'PR Guardian Arena started',
      'Analyzing pull request with correctness, security, and maintainability personas.'
    );

    await store.setCheckRunId(runId, checkRunId);

    await assertNotCanceled(store, runId);

    const files = await listPullRequestFiles(installationToken, run.repo.owner, run.repo.name, run.prNumber, 120);
    const reviewContext = renderReviewContext(run, files);

    const personaResults = await Promise.all(
      ROLE_PROMPTS.map((persona) => analyzePersona(env, run, persona.role, persona.systemPrompt, reviewContext, config.model))
    );

    const mergedUsage = mergeUsage(personaResults.map((entry) => entry.usage));

    const rawFindings = personaResults.flatMap((entry) => entry.findings);
    const rankedFindings = dedupeAndRankFindings(rawFindings);

    for (const finding of rankedFindings) {
      await store.insertFinding(finding);
    }

    const patches: PatchRecord[] = [];

    for (const finding of rankedFindings.slice(0, config.topPatchCount)) {
      await assertNotCanceled(store, runId);

      const patchContext = files.find((file) => file.filename === finding.filePath);
      const patch = await generatePatch(env, finding, patchContext, run, reviewContext, config.model);

      const record: PatchRecord = {
        findingId: finding.id,
        diffText: '',
        suggestions: patch.suggestions,
        riskNotes: patch.riskNotes
      };

      await store.insertPatch(record);
      patches.push(record);
    }

    const totalUsage = mergeUsage([mergedUsage]);
    await store.recordTokenUsage(runId, totalUsage);

    const comment = renderConsolidatedComment({
      runId,
      findings: rankedFindings,
      patches
    });

    await createIssueComment(installationToken, run.repo.owner, run.repo.name, run.prNumber, comment);

    if (checkRunId) {
      await updateCheckRun(
        installationToken,
        run.repo.owner,
        run.repo.name,
        checkRunId,
        'success',
        'PR Guardian Arena completed',
        renderSummary(rankedFindings),
        `Posted consolidated report with ${rankedFindings.length} finding(s).`
      );
    }

    await store.updateRunStatus(runId, 'completed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const canceled = await store.isCancellationRequested(runId);
    if (canceled) {
      await store.updateRunStatus(runId, 'canceled', message);

      if (checkRunId) {
        await updateCheckRun(
          installationToken,
          run.repo.owner,
          run.repo.name,
          checkRunId,
          'cancelled',
          'PR Guardian Arena canceled',
          message
        );
      }

      return;
    }

    await store.updateRunStatus(runId, 'failed', message);
    await store.insertEvent(runId, 'worker', 'run_failed', { message });

    if (checkRunId) {
      await updateCheckRun(
        installationToken,
        run.repo.owner,
        run.repo.name,
        checkRunId,
        'failure',
        'PR Guardian Arena failed',
        message
      );
    }

    await createIssueComment(
      installationToken,
      run.repo.owner,
      run.repo.name,
      run.prNumber,
      `PR Guardian Arena failed for run ${runId}: ${message}`
    );
  }
}

async function cancelRun(env: Env, runId: number, reason?: string): Promise<void> {
  const store = new D1Store(env.DB);
  await store.requestCancel(runId, reason ?? 'Cancellation requested');
}

async function explainFinding(env: Env, runId: number, findingId: string): Promise<void> {
  const store = new D1Store(env.DB);
  const run = await store.getRunWithRepo(runId);
  if (!run) {
    return;
  }

  const finding = await store.getFinding(runId, findingId);
  if (!finding) {
    return;
  }

  const token = await createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, run.repo.installationId);
  await createIssueComment(token, run.repo.owner, run.repo.name, run.prNumber, renderExplainComment(finding));
}

async function postPatchForFinding(env: Env, runId: number, findingId: string): Promise<void> {
  const store = new D1Store(env.DB);
  const run = await store.getRunWithRepo(runId);
  if (!run) {
    return;
  }

  const patches = await store.listPatchesForFinding(findingId);
  const patch = patches[0];
  if (!patch) {
    return;
  }

  const token = await createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, run.repo.installationId);
  await createIssueComment(token, run.repo.owner, run.repo.name, run.prNumber, renderPatchComment(findingId, patch));
}

async function analyzePersona(
  env: Env,
  run: RunWithRepo,
  role: ReviewRole,
  systemPrompt: string,
  reviewContext: string,
  model: string
): Promise<PersonaOutput> {
  const response = await runOpenAIStructuredOutput<{ findings: Array<Record<string, unknown>> }>({
    apiKey: env.OPENAI_API_KEY,
    model,
    schemaName: `${role}_findings`,
    schema: FINDINGS_SCHEMA as unknown as Record<string, unknown>,
    systemPrompt,
    userPrompt: [
      `Repository: ${run.repo.owner}/${run.repo.name}`,
      `PR #${run.prNumber}`,
      `Base branch: ${run.baseBranch}`,
      `Head SHA: ${run.headSha}`,
      '',
      'Analyze the pull request changes and return findings only when actionable and concrete.',
      reviewContext
    ].join('\n')
  });

  const normalizedFindings = Array.isArray(response.data.findings) ? response.data.findings : [];

  const findings: Finding[] = [];

  for (const candidate of normalizedFindings) {
    const finding = await normalizeFinding(role, run.id, candidate);
    if (finding) {
      findings.push(finding);
    }
  }

  return {
    findings,
    usage: response.usage
  };
}

async function normalizeFinding(role: ReviewRole, runId: number, raw: Record<string, unknown>): Promise<Finding | null> {
  const title = asString(raw.title);
  const filePath = asString(raw.filePath);
  const issueKey = asString(raw.issueKey);

  if (!title || !filePath || !issueKey) {
    return null;
  }

  const severity = asSeverity(raw.severity);
  const confidence = clamp(asNumber(raw.confidence), 0, 1);
  const startLine = Math.max(1, Math.floor(asNumber(raw.startLine, 1)));
  const endLine = Math.max(startLine, Math.floor(asNumber(raw.endLine, startLine)));
  const evidence = asString(raw.evidence);

  const dedupeKey = await shortHash(`${filePath.toLowerCase()}|${startLine}|${endLine}|${issueKey.toLowerCase()}`);

  return {
    id: crypto.randomUUID(),
    runId,
    role,
    severity,
    confidence,
    filePath,
    startLine,
    endLine,
    title,
    issueKey,
    evidence,
    dedupeKey,
    supportingRoles: [role],
    score: 0
  };
}

async function generatePatch(
  env: Env,
  finding: Finding,
  fileContext: PullRequestFile | undefined,
  run: RunWithRepo,
  reviewContext: string,
  model: string
): Promise<PatchOutput> {
  const prompt = [
    `Repository: ${run.repo.owner}/${run.repo.name}`,
    `PR #${run.prNumber}`,
    `Finding ID: ${finding.id}`,
    `Title: ${finding.title}`,
    `Location: ${finding.filePath}:${finding.startLine}-${finding.endLine}`,
    `Evidence: ${finding.evidence}`,
    '',
    'Generate a minimal patch suggestion for this finding.',
    'Return short risk notes and at most three inline suggestions.',
    fileContext?.patch ? `\nPatch context:\n${truncate(fileContext.patch, 1800)}` : `\nPR context:\n${truncate(reviewContext, 2400)}`
  ].join('\n');

  const response = await runOpenAIStructuredOutput<{
    riskNotes: string;
    suggestions: Array<{ filePath: string; startLine: number; endLine: number; body: string }>;
  }>({
    apiKey: env.OPENAI_API_KEY,
    model,
    schemaName: 'patch_suggestions',
    schema: PATCH_SCHEMA as unknown as Record<string, unknown>,
    systemPrompt: 'You are a safe patch generator. Keep changes minimal and preserve existing behavior outside the fix.',
    userPrompt: prompt
  });

  return {
    riskNotes: asString(response.data.riskNotes) || 'Patch generated with localized changes.',
    suggestions: Array.isArray(response.data.suggestions)
      ? response.data.suggestions
          .slice(0, 3)
          .map((suggestion) => ({
            filePath: asString(suggestion.filePath) || finding.filePath,
            startLine: Math.max(1, Math.floor(asNumber(suggestion.startLine, finding.startLine))),
            endLine: Math.max(1, Math.floor(asNumber(suggestion.endLine, finding.endLine))),
            body: asString(suggestion.body)
          }))
          .filter((suggestion) => Boolean(suggestion.body.trim()))
      : []
  };
}

export async function enqueueRun(env: Env, runId: number): Promise<void> {
  await env.RUN_QUEUE.send({ type: 'run_pr', runId });
}

export async function enqueueJob(env: Env, job: QueueJob): Promise<void> {
  await env.RUN_QUEUE.send(job);
}

async function assertNotCanceled(store: D1Store, runId: number): Promise<void> {
  const canceled = await store.isCancellationRequested(runId);
  if (canceled) {
    throw new Error('Run canceled by user request');
  }
}

function renderReviewContext(run: RunWithRepo, files: PullRequestFile[]): string {
  const header = [
    `Changed files (${files.length}):`,
    ...files.slice(0, 40).map((file) => `- ${file.filename} (+${file.additions} / -${file.deletions})`),
    ''
  ];

  const patchSnippets = files
    .slice(0, 15)
    .map((file) => {
      const patch = file.patch ? truncate(file.patch, 1800) : '(binary or no patch content)';
      return `File: ${file.filename}\n${patch}`;
    })
    .join('\n\n');

  return [...header, patchSnippets].join('\n');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...<truncated>`;
}

function mergeUsage(entries: TokenUsage[]): TokenUsage {
  return entries.reduce(
    (acc, entry) => ({
      inputTokens: acc.inputTokens + entry.inputTokens,
      outputTokens: acc.outputTokens + entry.outputTokens,
      totalTokens: acc.totalTokens + entry.totalTokens
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  );
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function asSeverity(value: unknown): Severity {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return 'medium';
}
