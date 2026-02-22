import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CodexAppServerClient,
  extractLatestAgentMessage,
  ReviewStartResponse,
  ThreadForkResponse,
  ThreadReadResponse,
  ThreadStartResponse,
  TurnStartResponse
} from '@pr-guardian/app-server-client';
import {
  PersistedFindingInput,
  QueueJobPayload,
  RunStore,
  RunWithRepo,
  TokenUsageTotals
} from '@pr-guardian/common';
import {
  buildDedupeKey,
  Finding,
  rankFindings,
  RankedFinding,
  ReviewRole,
  toGithubSuggestions
} from '@pr-guardian/domain';

import { cloneRepoAtSha, removeRepoClone } from './git.js';
import { GitHubService } from './github.js';
import {
  buildNormalizationPrompt,
  buildPatchPrompt,
  NORMALIZED_FINDINGS_SCHEMA,
  PATCH_SUMMARY_SCHEMA,
  PERSONAS,
  ROOT_DEVELOPER_INSTRUCTIONS
} from './prompts.js';
import { renderConsolidatedComment, renderExplainComment, renderPatchComment, renderRunSummary } from './report.js';

interface RunOrchestratorOptions {
  store: RunStore;
  github: GitHubService;
  codexBin: string;
  runTimeoutMs: number;
  tempRoot?: string;
  createAppClient?: (cwd: string) => AppServerClientLike;
  cloneRepoAtShaFn?: typeof cloneRepoAtSha;
  removeRepoCloneFn?: typeof removeRepoClone;
}

interface ActiveRunContext {
  client: AppServerClientLike;
  currentTurn: {
    threadId: string;
    turnId: string;
  } | null;
}

interface AppServerClientLike {
  on(event: 'notification', listener: (payload: { method: string; params: unknown }) => void): this;
  start(): Promise<void>;
  initialize(clientName?: string, clientVersion?: string): Promise<void>;
  stop(): Promise<void>;
  request<T>(method: string, params?: unknown): Promise<T>;
  waitForTurnCompletion(threadId: string, turnId: string, timeoutMs?: number): Promise<{
    status: string;
    error: unknown | null;
  }>;
  getLatestTurnDiff(turnId: string): string | null;
}

type NormalizedFinding = {
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  file: string;
  startLine: number;
  endLine: number;
  issueKey: string;
  evidence: string;
  suggestedFix?: string;
};

export class RunCanceledError extends Error {
  constructor(message = 'Run canceled') {
    super(message);
    this.name = 'RunCanceledError';
  }
}

export class RunOrchestrator {
  private readonly activeRuns = new Map<number, ActiveRunContext>();
  private readonly tempRoot: string;
  private readonly createAppClient: (cwd: string) => AppServerClientLike;
  private readonly cloneRepoAtShaFn: typeof cloneRepoAtSha;
  private readonly removeRepoCloneFn: typeof removeRepoClone;

  constructor(private readonly options: RunOrchestratorOptions) {
    this.tempRoot = options.tempRoot ?? os.tmpdir();
    this.createAppClient =
      options.createAppClient ??
      ((cwd: string) =>
        new CodexAppServerClient({
          codexBin: options.codexBin,
          cwd
        }));
    this.cloneRepoAtShaFn = options.cloneRepoAtShaFn ?? cloneRepoAtSha;
    this.removeRepoCloneFn = options.removeRepoCloneFn ?? removeRepoClone;
  }

  async handleJob(payload: QueueJobPayload): Promise<void> {
    switch (payload.type) {
      case 'run_pr':
        await this.runPullRequest(payload.runId);
        return;
      case 'cancel_run':
        await this.cancelRun(payload.runId, payload.reason);
        return;
      case 'explain_finding':
        await this.explainFinding(payload.runId, payload.findingId);
        return;
      case 'patch_finding':
        await this.patchFinding(payload.runId, payload.findingId);
        return;
      default:
        return;
    }
  }

  async cancelRun(runId: number, reason = 'Cancellation requested'): Promise<void> {
    await this.options.store.requestCancel(runId, reason);

    const context = this.activeRuns.get(runId);
    if (!context?.currentTurn) {
      await this.options.store.updateRunStatus(runId, 'canceled', reason);
      return;
    }

    try {
      await context.client.request('turn/interrupt', {
        threadId: context.currentTurn.threadId,
        turnId: context.currentTurn.turnId
      });
    } catch {
      // Best effort interrupt.
    }
  }

  private async runPullRequest(runId: number): Promise<void> {
    const run = await this.options.store.getRunWithRepo(runId);
    if (!run) {
      return;
    }

    const githubContext = {
      owner: run.repo.owner,
      repo: run.repo.name,
      installationId: run.repo.installationId
    };

    await this.options.store.updateRunStatus(runId, 'running');

    const checkRun = await this.options.github.createCheckRun(githubContext, run.headSha, {
      title: 'PR Guardian Arena started',
      summary: 'Review pipeline started: correctness, security, maintainability.'
    });

    if (checkRun) {
      await this.options.store.setCheckRunId(runId, checkRun.id);
    }

    const cloneDir = await mkdtemp(path.join(this.tempRoot, 'pr-guardian-'));
    const appClient = this.createAppClient(cloneDir);

    this.activeRuns.set(runId, {
      client: appClient,
      currentTurn: null
    });

    appClient.on('notification', async (notification: { method: string; params: unknown }) => {
      if (notification.method === 'thread/tokenUsage/updated') {
        const payload = notification.params as {
          tokenUsage: {
            total: TokenUsageTotals;
          };
        };

        await this.options.store.recordTokenUsage(runId, payload.tokenUsage.total);
      }

      if (
        notification.method === 'turn/completed' ||
        notification.method === 'turn/diff/updated' ||
        notification.method === 'error'
      ) {
        await this.options.store.insertEvent(runId, 'app-server', notification.method, notification.params as Record<string, unknown>);
      }
    });

    try {
      await this.assertNotCanceled(runId);

      const token = await this.options.github.getInstallationToken(run.repo.installationId);
      await this.cloneRepoAtShaFn({
        owner: run.repo.owner,
        repo: run.repo.name,
        headSha: run.headSha,
        baseBranch: run.baseBranch,
        token,
        targetDir: cloneDir
      });

      await appClient.start();
      await appClient.initialize();

      const rootThreadResponse = await appClient.request<ThreadStartResponse>('thread/start', {
        cwd: cloneDir,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        model: 'gpt-5.3-codex',
        developerInstructions: ROOT_DEVELOPER_INSTRUCTIONS
      });

      const rootThreadId = rootThreadResponse.thread.id;
      const rootThreadRecord = await this.options.store.insertThread(runId, 'root', rootThreadId);

      const personaResults = await Promise.all(
        PERSONAS.map((persona) =>
          this.runPersonaReview({
            run,
            role: persona.role,
            instructions: persona.instructions,
            rootThreadId,
            appClient
          })
        )
      );

      const allFindings = personaResults.flatMap((persona) => persona.findings);
      const ranked = rankFindings(allFindings);

      await this.options.store.insertFindings(
        runId,
        ranked.map<PersistedFindingInput>((finding) => ({
          id: finding.id,
          role: finding.role,
          severity: finding.severity,
          confidence: finding.confidence,
          filePath: finding.file,
          startLine: finding.startLine,
          endLine: finding.endLine,
          title: finding.title,
          evidence: {
            ...finding.evidence,
            supportingRoles: finding.supportingRoles
          },
          dedupeKey: finding.dedupeKey
        }))
      );

      const topPatchTargets = ranked.slice(0, 3);
      const generatedPatches: Array<{
        findingId: string;
        suggestions: Array<{ filePath: string; startLine: number; endLine: number; body: string }>;
        riskNotes: string;
      }> = [];

      for (const finding of topPatchTargets) {
        await this.assertNotCanceled(runId);

        const patch = await this.generatePatch({
          runId,
          rootThreadId,
          finding,
          appClient
        });

        if (patch) {
          generatedPatches.push(patch);
        }
      }

      const comment = renderConsolidatedComment({
        runId,
        findings: ranked,
        patches: generatedPatches
      });

      await this.options.github.createIssueComment(githubContext, run.prNumber, comment);

      if (checkRun) {
        await this.options.github.updateCheckRun(githubContext, checkRun.id, 'success', {
          title: 'PR Guardian Arena completed',
          summary: renderRunSummary(ranked),
          text: `Posted consolidated report with ${ranked.length} findings.`
        });
      }

      await this.options.store.updateRunStatus(runId, 'completed');
      await this.options.store.updateThreadTurn(runId, rootThreadRecord.appThreadId, 'done', 'completed');
    } catch (error) {
      if (error instanceof RunCanceledError) {
        await this.options.store.updateRunStatus(runId, 'canceled', error.message);

        if (checkRun) {
          await this.options.github.updateCheckRun(githubContext, checkRun.id, 'cancelled', {
            title: 'PR Guardian Arena canceled',
            summary: error.message
          });
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await this.options.store.updateRunStatus(runId, 'failed', message);

        if (checkRun) {
          await this.options.github.updateCheckRun(githubContext, checkRun.id, 'failure', {
            title: 'PR Guardian Arena failed',
            summary: message
          });
        }

        await this.options.github.createIssueComment(
          githubContext,
          run.prNumber,
          `PR Guardian Arena failed for run ${runId}: ${message}`
        );
      }
    } finally {
      this.activeRuns.delete(runId);
      await appClient.stop().catch(() => undefined);
      await this.removeRepoCloneFn(cloneDir).catch(() => undefined);
    }
  }

  private async runPersonaReview(params: {
    run: RunWithRepo;
    role: ReviewRole;
    instructions: string;
    rootThreadId: string;
    appClient: AppServerClientLike;
  }): Promise<{ role: ReviewRole; findings: Finding[] }> {
    const forkedThread = await params.appClient.request<ThreadForkResponse>('thread/fork', {
      threadId: params.rootThreadId,
      developerInstructions: params.instructions
    });

    const threadId = forkedThread.thread.id;
    await this.options.store.insertThread(params.run.id, params.role, threadId);

    const review = await params.appClient.request<ReviewStartResponse>('review/start', {
      threadId,
      target: {
        type: 'baseBranch',
        branch: params.run.baseBranch
      },
      delivery: 'inline'
    });

    await this.waitForTurn({
      runId: params.run.id,
      appClient: params.appClient,
      threadId,
      turnId: review.turn.id
    });

    const normalizationTurn = await params.appClient.request<TurnStartResponse>('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: buildNormalizationPrompt(params.role)
        }
      ],
      outputSchema: NORMALIZED_FINDINGS_SCHEMA
    });

    await this.waitForTurn({
      runId: params.run.id,
      appClient: params.appClient,
      threadId,
      turnId: normalizationTurn.turn.id
    });

    const thread = await params.appClient.request<ThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: true
    });

    const latestMessage = extractLatestAgentMessage(thread.thread);
    const normalized = parseNormalizedFindings(latestMessage ?? '');

    const findings: Finding[] = normalized.map((finding) => {
      const dedupeKey = buildDedupeKey({
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        issueKey: finding.issueKey
      });

      return {
        id: randomUUID(),
        repo: `${params.run.repo.owner}/${params.run.repo.name}`,
        prNumber: params.run.prNumber,
        role: params.role,
        severity: finding.severity,
        confidence: clamp01(finding.confidence),
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        title: finding.title,
        issueKey: finding.issueKey,
        evidence: {
          evidence: finding.evidence,
          suggestedFix: finding.suggestedFix ?? null
        },
        dedupeKey
      };
    });

    return {
      role: params.role,
      findings
    };
  }

  private async generatePatch(params: {
    runId: number;
    rootThreadId: string;
    finding: RankedFinding;
    appClient: AppServerClientLike;
  }): Promise<{
    findingId: string;
    suggestions: Array<{ filePath: string; startLine: number; endLine: number; body: string }>;
    riskNotes: string;
  } | null> {
    const forked = await params.appClient.request<ThreadForkResponse>('thread/fork', {
      threadId: params.rootThreadId,
      developerInstructions: 'You are patch generator mode. Implement only minimal edits required for the finding.'
    });

    const patchThread = await this.options.store.insertThread(params.runId, `patch:${params.finding.id}`, forked.thread.id);

    const patchTurn = await params.appClient.request<TurnStartResponse>('turn/start', {
      threadId: forked.thread.id,
      input: [
        {
          type: 'text',
          text: buildPatchPrompt({
            title: params.finding.title,
            file: params.finding.file,
            startLine: params.finding.startLine,
            endLine: params.finding.endLine,
            evidence: String(params.finding.evidence.evidence ?? '')
          })
        }
      ],
      outputSchema: PATCH_SUMMARY_SCHEMA
    });

    await this.waitForTurn({
      runId: params.runId,
      appClient: params.appClient,
      threadId: forked.thread.id,
      turnId: patchTurn.turn.id
    });

    const diff = params.appClient.getLatestTurnDiff(patchTurn.turn.id) ?? '';
    const suggestions = toGithubSuggestions(diff, 3);
    const suggestionPayload = suggestions.map((suggestion) => ({
      filePath: suggestion.filePath,
      startLine: suggestion.startLine,
      endLine: suggestion.endLine,
      body: suggestion.body
    }));

    const thread = await params.appClient.request<ThreadReadResponse>('thread/read', {
      threadId: forked.thread.id,
      includeTurns: true
    });

    const latestMessage = extractLatestAgentMessage(thread.thread);
    const riskNotes = parsePatchRiskNotes(latestMessage ?? 'Minimal patch generated.');

    await this.options.store.insertPatch({
      findingId: params.finding.id,
      threadId: patchThread.id,
      diffText: diff,
      suggestions: suggestionPayload,
      status: suggestions.length > 0 ? 'ready' : 'no_suggestion',
      riskNotes
    });

    if (diff.trim().length === 0) {
      return null;
    }

    return {
      findingId: params.finding.id,
      suggestions,
      riskNotes
    };
  }

  private async explainFinding(runId: number, findingId: string): Promise<void> {
    const run = await this.options.store.getRunWithRepo(runId);
    if (!run) {
      return;
    }

    const finding = await this.options.store.getFinding(runId, findingId);
    if (!finding) {
      await this.options.github.createIssueComment(
        {
          owner: run.repo.owner,
          repo: run.repo.name,
          installationId: run.repo.installationId
        },
        run.prNumber,
        `No finding found for id \`${findingId}\` in run ${runId}.`
      );
      return;
    }

    const evidence = String(finding.evidence.evidence ?? 'No evidence captured');

    await this.options.github.createIssueComment(
      {
        owner: run.repo.owner,
        repo: run.repo.name,
        installationId: run.repo.installationId
      },
      run.prNumber,
      renderExplainComment({
        findingId: finding.id,
        title: finding.title,
        filePath: finding.filePath,
        startLine: finding.startLine,
        endLine: finding.endLine,
        evidence
      })
    );
  }

  private async patchFinding(runId: number, findingId: string): Promise<void> {
    const run = await this.options.store.getRunWithRepo(runId);
    if (!run) {
      return;
    }

    const patches = await this.options.store.listPatchesForFinding(findingId);
    const latest = patches[0];

    if (!latest) {
      await this.options.github.createIssueComment(
        {
          owner: run.repo.owner,
          repo: run.repo.name,
          installationId: run.repo.installationId
        },
        run.prNumber,
        `No generated patch is available for \`${findingId}\`. Re-run the analysis with \`/codex rerun\` to generate a fresh patch.`
      );
      return;
    }

    await this.options.github.createIssueComment(
      {
        owner: run.repo.owner,
        repo: run.repo.name,
        installationId: run.repo.installationId
      },
      run.prNumber,
      renderPatchComment({
        findingId,
        riskNotes: latest.riskNotes ?? 'Patch generated.',
        suggestions: latest.suggestions as Array<{ filePath: string; startLine: number; endLine: number; body: string }>
      })
    );
  }

  private async waitForTurn(params: {
    runId: number;
    appClient: AppServerClientLike;
    threadId: string;
    turnId: string;
  }): Promise<void> {
    await this.assertNotCanceled(params.runId);

    const context = this.activeRuns.get(params.runId);
    if (context) {
      context.currentTurn = {
        threadId: params.threadId,
        turnId: params.turnId
      };
    }

    try {
      await this.options.store.updateThreadTurn(params.runId, params.threadId, params.turnId);
      const turn = await params.appClient.waitForTurnCompletion(params.threadId, params.turnId, this.options.runTimeoutMs);

      if (turn.status === 'failed') {
        const reason = typeof turn.error === 'object' ? JSON.stringify(turn.error) : String(turn.error);
        throw new Error(`Turn failed (${params.turnId}): ${reason}`);
      }
    } finally {
      const active = this.activeRuns.get(params.runId);
      if (active) {
        active.currentTurn = null;
      }
    }
  }

  private async assertNotCanceled(runId: number): Promise<void> {
    const canceled = await this.options.store.isCancellationRequested(runId);
    if (canceled) {
      throw new RunCanceledError('Run canceled by user request');
    }
  }
}

function parseNormalizedFindings(input: string): NormalizedFinding[] {
  if (!input.trim()) {
    return [];
  }

  const parsed = parseJsonBlob(input) as { findings?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.findings)) {
    return [];
  }

  return parsed.findings
    .map((candidate) => toNormalizedFinding(candidate))
    .filter((candidate): candidate is NormalizedFinding => candidate !== null);
}

function toNormalizedFinding(candidate: unknown): NormalizedFinding | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const value = candidate as Record<string, unknown>;

  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const severity = normalizeSeverity(value.severity);
  const confidence = typeof value.confidence === 'number' ? value.confidence : 0;
  const file = typeof value.file === 'string' ? value.file.trim() : '';
  const startLine = typeof value.startLine === 'number' ? Math.max(1, Math.floor(value.startLine)) : 1;
  const endLine = typeof value.endLine === 'number' ? Math.max(startLine, Math.floor(value.endLine)) : startLine;
  const issueKey = typeof value.issueKey === 'string' ? value.issueKey.trim() : title.slice(0, 64);
  const evidence = typeof value.evidence === 'string' ? value.evidence : '';
  const suggestedFix = typeof value.suggestedFix === 'string' ? value.suggestedFix : undefined;

  if (!title || !file || !issueKey) {
    return null;
  }

  return {
    title,
    severity,
    confidence: clamp01(confidence),
    file,
    startLine,
    endLine,
    issueKey,
    evidence,
    suggestedFix
  };
}

function parsePatchRiskNotes(input: string): string {
  const parsed = parseJsonBlob(input) as { riskNotes?: unknown } | null;
  if (!parsed || typeof parsed.riskNotes !== 'string') {
    return 'Patch generated with localized edits. Validate behavior with project tests before merge.';
  }

  return parsed.riskNotes;
}

function parseJsonBlob(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    const match = input.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeSeverity(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }

  return 'medium';
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
