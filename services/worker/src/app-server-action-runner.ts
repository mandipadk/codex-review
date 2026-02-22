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
  ThreadTokenUsageUpdatedNotification,
  TurnStartResponse
} from '@pr-guardian/app-server-client';
import { GitHubAppClientFactory } from '@pr-guardian/common';
import { buildDedupeKey, Finding, rankFindings, RankedFinding, ReviewRole, toGithubSuggestions } from '@pr-guardian/domain';

import { cloneRepoAtSha, removeRepoClone } from './git.js';
import {
  buildNormalizationPrompt,
  buildPatchPrompt,
  NORMALIZED_FINDINGS_SCHEMA,
  PATCH_SUMMARY_SCHEMA,
  PERSONAS,
  ROOT_DEVELOPER_INSTRUCTIONS
} from './prompts.js';
import { renderConsolidatedComment, renderRunSummary } from './report.js';

interface RunnerPayload {
  runId: number;
  repoOwner: string;
  repoName: string;
  installationId: number;
  prNumber: number;
  headSha: string;
  baseBranch: string;
  model: string;
  topPatchCount: number;
  checkRunId?: number | null;
  callbackUrl: string;
}

interface CallbackFinding {
  id: string;
  role: ReviewRole;
  severity: 'low' | 'medium' | 'high' | 'critical';
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

interface CallbackPatch {
  findingId: string;
  diffText: string;
  suggestions: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    body: string;
  }>;
  riskNotes: string;
}

interface CallbackPayload {
  runId: number;
  status: 'completed' | 'failed' | 'canceled';
  error?: string;
  checkRunId?: number | null;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  findings?: CallbackFinding[];
  patches?: CallbackPatch[];
  events?: Array<{
    source: string;
    eventType: string;
    payload: Record<string, unknown>;
  }>;
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function parsePayload(): RunnerPayload {
  const raw = requireEnv('PGA_RUN_PAYLOAD');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PGA_RUN_PAYLOAD must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('PGA_RUN_PAYLOAD must be an object');
  }

  const payload = parsed as Record<string, unknown>;
  const runId = Number(payload.runId);
  const installationId = Number(payload.installationId);
  const prNumber = Number(payload.prNumber);
  const topPatchCount = Number(payload.topPatchCount);

  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error('runId must be a positive integer');
  }

  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error('installationId must be a positive integer');
  }

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('prNumber must be a positive integer');
  }

  const repoOwner = String(payload.repoOwner ?? '').trim();
  const repoName = String(payload.repoName ?? '').trim();
  const headSha = String(payload.headSha ?? '').trim();
  const baseBranch = String(payload.baseBranch ?? '').trim();
  const model = String(payload.model ?? '').trim() || 'gpt-5.3-codex';
  const callbackUrl = String(payload.callbackUrl ?? '').trim();

  if (!repoOwner || !repoName || !headSha || !baseBranch || !callbackUrl) {
    throw new Error('Missing required runner payload fields');
  }

  const rawCheckRunId = payload.checkRunId;
  const checkRunId =
    typeof rawCheckRunId === 'number' && Number.isInteger(rawCheckRunId) && rawCheckRunId > 0 ? rawCheckRunId : null;

  return {
    runId,
    repoOwner,
    repoName,
    installationId,
    prNumber,
    headSha,
    baseBranch,
    model,
    topPatchCount: Number.isInteger(topPatchCount) && topPatchCount > 0 ? topPatchCount : 3,
    checkRunId,
    callbackUrl
  };
}

async function waitForTurn(
  client: CodexAppServerClient,
  threadId: string,
  turnId: string,
  timeoutMs = 10 * 60 * 1000
): Promise<void> {
  const turn = await client.waitForTurnCompletion(threadId, turnId, timeoutMs);
  if (turn.status === 'failed') {
    const reason = typeof turn.error === 'object' ? JSON.stringify(turn.error) : String(turn.error);
    throw new Error(`Turn failed (${turnId}): ${reason}`);
  }
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

function normalizeSeverity(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }

  return 'medium';
}

async function postCallback(callbackUrl: string, callbackSecret: string, payload: CallbackPayload): Promise<void> {
  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${callbackSecret}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Callback failed (${response.status}): ${text}`);
  }
}

async function main(): Promise<void> {
  const payload = parsePayload();
  const callbackSecret = requireEnv('INTERNAL_CALLBACK_SECRET');
  const appId = requireEnv('GITHUB_APP_ID');
  const privateKey = requireEnv('GITHUB_APP_PRIVATE_KEY');
  const codexBin = process.env.CODEX_BIN?.trim() || 'codex';

  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error('OPENAI_API_KEY is required for codex app-server execution');
  }

  const githubFactory = new GitHubAppClientFactory({
    appId,
    privateKey
  });

  const installationClient = await githubFactory.getInstallationClient(payload.installationId);
  const installationToken = await githubFactory.getInstallationToken(payload.installationId);

  let checkRunId = payload.checkRunId ?? null;
  let cloneDir = '';
  let client: CodexAppServerClient | null = null;

  const tokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
  const events: CallbackPayload['events'] = [];

  try {
    if (!checkRunId) {
      const created = await installationClient.checks.create({
        owner: payload.repoOwner,
        repo: payload.repoName,
        name: 'PR Guardian Arena',
        head_sha: payload.headSha,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        output: {
          title: 'PR Guardian Arena started',
          summary: 'Codex App Server analysis started on GitHub Actions runner.'
        }
      });
      checkRunId = created.data.id;
    }

    cloneDir = await mkdtemp(path.join(os.tmpdir(), 'pr-guardian-app-server-'));
    await cloneRepoAtSha({
      owner: payload.repoOwner,
      repo: payload.repoName,
      headSha: payload.headSha,
      baseBranch: payload.baseBranch,
      token: installationToken,
      targetDir: cloneDir
    });

    client = new CodexAppServerClient({
      codexBin,
      cwd: cloneDir
    });
    const appClient = client;

    appClient.on('notification', (notification) => {
      if (notification.method === 'thread/tokenUsage/updated') {
        const usage = (notification.params as ThreadTokenUsageUpdatedNotification).tokenUsage?.total;
        if (usage) {
          tokenUsage.inputTokens = Number(usage.inputTokens ?? 0);
          tokenUsage.outputTokens = Number(usage.outputTokens ?? 0);
          tokenUsage.totalTokens = Number(usage.totalTokens ?? 0);
        }
      }

      if (
        notification.method === 'turn/completed' ||
        notification.method === 'turn/diff/updated' ||
        notification.method === 'error'
      ) {
        const rawPayload = (notification.params ?? {}) as Record<string, unknown>;
        const compactPayload =
          notification.method === 'turn/diff/updated'
            ? {
                threadId: rawPayload.threadId,
                turnId: rawPayload.turnId,
                diffPreview:
                  typeof rawPayload.diff === 'string' ? rawPayload.diff.slice(0, 4000) : 'diff unavailable',
                diffLength: typeof rawPayload.diff === 'string' ? rawPayload.diff.length : 0
              }
            : notification.method === 'turn/completed'
              ? {
                  threadId: rawPayload.threadId,
                  turnId:
                    rawPayload.turn && typeof rawPayload.turn === 'object'
                      ? (rawPayload.turn as Record<string, unknown>).id
                      : null,
                  status:
                    rawPayload.turn && typeof rawPayload.turn === 'object'
                      ? (rawPayload.turn as Record<string, unknown>).status
                      : null
                }
              : {
                  message:
                    typeof rawPayload.message === 'string'
                      ? rawPayload.message.slice(0, 2000)
                      : JSON.stringify(rawPayload).slice(0, 2000)
                };

        events.push({
          source: 'app-server-runner',
          eventType: notification.method,
          payload: compactPayload
        });
      }
    });

    await appClient.start();
    await appClient.initialize('pr-guardian-actions-runner', '0.1.0');

    const rootThreadResponse = await appClient.request<ThreadStartResponse>('thread/start', {
      cwd: cloneDir,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      model: payload.model,
      developerInstructions: ROOT_DEVELOPER_INSTRUCTIONS
    });

    const rootThreadId = rootThreadResponse.thread.id;

    const personaResults = await Promise.all(
      PERSONAS.map(async (persona) => {
        const forked = await appClient.request<ThreadForkResponse>('thread/fork', {
          threadId: rootThreadId,
          developerInstructions: persona.instructions
        });

        const personaThreadId = forked.thread.id;

        const review = await appClient.request<ReviewStartResponse>('review/start', {
          threadId: personaThreadId,
          target: {
            type: 'baseBranch',
            branch: payload.baseBranch
          },
          delivery: 'inline'
        });

        await waitForTurn(appClient, personaThreadId, review.turn.id);

        const normalizationTurn = await appClient.request<TurnStartResponse>('turn/start', {
          threadId: personaThreadId,
          input: [
            {
              type: 'text',
              text: buildNormalizationPrompt(persona.role)
            }
          ],
          outputSchema: NORMALIZED_FINDINGS_SCHEMA
        });

        await waitForTurn(appClient, personaThreadId, normalizationTurn.turn.id);

        const thread = await appClient.request<ThreadReadResponse>('thread/read', {
          threadId: personaThreadId,
          includeTurns: true
        });

        const latestMessage = extractLatestAgentMessage(thread.thread);
        const normalized = parseNormalizedFindings(latestMessage ?? '');

        const findings: Finding[] = normalized.map((finding) => ({
          id: randomUUID(),
          repo: `${payload.repoOwner}/${payload.repoName}`,
          prNumber: payload.prNumber,
          role: persona.role,
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
          dedupeKey: buildDedupeKey({
            file: finding.file,
            startLine: finding.startLine,
            endLine: finding.endLine,
            issueKey: finding.issueKey
          })
        }));

        return {
          role: persona.role,
          findings
        };
      })
    );

    const ranked = rankFindings(personaResults.flatMap((result) => result.findings));

    const generatedPatches: Array<{
      findingId: string;
      diffText: string;
      suggestions: Array<{ filePath: string; startLine: number; endLine: number; body: string }>;
      riskNotes: string;
    }> = [];

    for (const finding of ranked.slice(0, payload.topPatchCount)) {
      const patchFork = await appClient.request<ThreadForkResponse>('thread/fork', {
        threadId: rootThreadId,
        developerInstructions: 'You are patch generator mode. Implement only minimal edits required for the finding.'
      });

      const patchTurn = await appClient.request<TurnStartResponse>('turn/start', {
        threadId: patchFork.thread.id,
        input: [
          {
            type: 'text',
            text: buildPatchPrompt({
              title: finding.title,
              file: finding.file,
              startLine: finding.startLine,
              endLine: finding.endLine,
              evidence: String(finding.evidence.evidence ?? '')
            })
          }
        ],
        outputSchema: PATCH_SUMMARY_SCHEMA
      });

      await waitForTurn(appClient, patchFork.thread.id, patchTurn.turn.id);

      const diff = appClient.getLatestTurnDiff(patchTurn.turn.id) ?? '';
      const suggestions = toGithubSuggestions(diff, 3);

      const patchThread = await appClient.request<ThreadReadResponse>('thread/read', {
        threadId: patchFork.thread.id,
        includeTurns: true
      });
      const latestMessage = extractLatestAgentMessage(patchThread.thread);
      const riskNotes = parsePatchRiskNotes(latestMessage ?? '');

      generatedPatches.push({
        findingId: finding.id,
        diffText: diff,
        suggestions,
        riskNotes
      });
    }

    const comment = renderConsolidatedComment({
      runId: payload.runId,
      findings: ranked,
      patches: generatedPatches.map((patch) => ({
        findingId: patch.findingId,
        suggestions: patch.suggestions,
        riskNotes: patch.riskNotes
      }))
    });

    await installationClient.issues.createComment({
      owner: payload.repoOwner,
      repo: payload.repoName,
      issue_number: payload.prNumber,
      body: comment.slice(0, 65_000)
    });

    if (checkRunId) {
      await installationClient.checks.update({
        owner: payload.repoOwner,
        repo: payload.repoName,
        check_run_id: checkRunId,
        status: 'completed',
        conclusion: 'success',
        completed_at: new Date().toISOString(),
        output: {
          title: 'PR Guardian Arena completed',
          summary: renderRunSummary(ranked as RankedFinding[]),
          text: `Posted consolidated report with ${ranked.length} findings.`
        }
      });
    }

    await postCallback(payload.callbackUrl, callbackSecret, {
      runId: payload.runId,
      status: 'completed',
      checkRunId,
      tokenUsage,
      findings: ranked.map((finding) => ({
        id: finding.id,
        role: finding.role,
        severity: finding.severity,
        confidence: finding.confidence,
        filePath: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        title: finding.title,
        issueKey: finding.issueKey,
        evidence: String(finding.evidence.evidence ?? ''),
        dedupeKey: finding.dedupeKey,
        supportingRoles: finding.supportingRoles,
        score: finding.score
      })),
      patches: generatedPatches,
      events
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (checkRunId) {
      await installationClient.checks
        .update({
          owner: payload.repoOwner,
          repo: payload.repoName,
          check_run_id: checkRunId,
          status: 'completed',
          conclusion: 'failure',
          completed_at: new Date().toISOString(),
          output: {
            title: 'PR Guardian Arena failed',
            summary: message.slice(0, 65_000)
          }
        })
        .catch(() => undefined);
    }

    await installationClient.issues
      .createComment({
        owner: payload.repoOwner,
        repo: payload.repoName,
        issue_number: payload.prNumber,
        body: `PR Guardian Arena failed for run ${payload.runId}: ${message}`.slice(0, 65_000)
      })
      .catch(() => undefined);

    await postCallback(payload.callbackUrl, callbackSecret, {
      runId: payload.runId,
      status: 'failed',
      error: message,
      checkRunId,
      tokenUsage,
      events
    }).catch(() => undefined);

    throw error;
  } finally {
    if (client) {
      await client.stop().catch(() => undefined);
    }
    if (cloneDir) {
      await removeRepoClone(cloneDir).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
