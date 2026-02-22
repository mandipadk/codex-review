import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { parseRepoAllowlist, QueueJobPayload, RunStore } from '@pr-guardian/common';
import { parseChatOpsCommand } from '@pr-guardian/domain';

import { RunScheduler } from './scheduler.js';
import { verifyGitHubSignature } from './signature.js';
import { IssueCommentPayload, PullRequestPayload } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

interface BuildServerOptions {
  store: RunStore;
  scheduler: RunScheduler;
  webhookSecret?: string;
  repoAllowlist?: Set<string>;
  maxRepos?: number;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger: true });

  const webhookSecret = options.webhookSecret;
  const allowlist = options.repoAllowlist ?? new Set<string>();
  const maxRepos = options.maxRepos ?? 5;

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const rawBody = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = rawBody;

    try {
      done(null, JSON.parse(rawBody));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/internal/runs/:runId/retry', async (request, reply) => {
    const runId = Number((request.params as { runId: string }).runId);
    if (Number.isNaN(runId)) {
      return reply.code(400).send({ error: 'Invalid run id' });
    }

    const run = await options.store.getRunWithRepo(runId);
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const newRun = await options.store.createRun({
      repoId: run.repoId,
      prNumber: run.prNumber,
      headSha: run.headSha,
      baseBranch: run.baseBranch,
      trigger: 'internal_retry'
    });

    await options.scheduler.enqueue({ type: 'run_pr', runId: newRun.id });

    return reply.code(202).send({ runId: newRun.id });
  });

  app.post('/internal/runs/:runId/cancel', async (request, reply) => {
    const runId = Number((request.params as { runId: string }).runId);
    if (Number.isNaN(runId)) {
      return reply.code(400).send({ error: 'Invalid run id' });
    }

    await options.store.requestCancel(runId, 'Internal cancel endpoint');
    await options.scheduler.enqueue({ type: 'cancel_run', runId, reason: 'Internal cancel endpoint' });

    return reply.code(202).send({ canceled: true, runId });
  });

  app.post('/webhooks/github', async (request, reply) => {
    const event = request.headers['x-github-event'];
    const delivery = request.headers['x-github-delivery'];

    if (!event || typeof event !== 'string') {
      return reply.code(400).send({ error: 'Missing x-github-event' });
    }

    if (webhookSecret) {
      const signature = request.headers['x-hub-signature-256'];
      const isValid = verifyGitHubSignature(webhookSecret, request.rawBody ?? '',
        typeof signature === 'string' ? signature : undefined);

      if (!isValid) {
        request.log.warn({ delivery }, 'Webhook signature verification failed');
        return reply.code(401).send({ error: 'Invalid signature' });
      }
    }

    if (event === 'pull_request') {
      return handlePullRequestEvent(request as FastifyRequest<{ Body: PullRequestPayload }>, reply, options.store, options.scheduler, allowlist, maxRepos);
    }

    if (event === 'issue_comment') {
      return handleIssueCommentEvent(request as FastifyRequest<{ Body: IssueCommentPayload }>, reply, options.store, options.scheduler);
    }

    request.log.info({ event, delivery }, 'Ignoring unsupported webhook event');
    return reply.code(202).send({ ignored: true, event });
  });

  return app;
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

function shouldTriggerPullRequest(payload: PullRequestPayload): boolean {
  if (payload.action === 'opened' || payload.action === 'synchronize' || payload.action === 'reopened') {
    return true;
  }

  if (payload.action === 'labeled') {
    return payload.label?.name === 'codex-review';
  }

  return false;
}

async function handlePullRequestEvent(
  request: FastifyRequest<{ Body: PullRequestPayload }>,
  reply: FastifyReply,
  store: RunStore,
  scheduler: RunScheduler,
  allowlist: Set<string>,
  maxRepos: number
): Promise<FastifyReply> {
  const payload = request.body;

  if (!shouldTriggerPullRequest(payload)) {
    return reply.code(202).send({ ignored: true, reason: 'action not eligible' });
  }

  const owner = payload.repository.owner.login;
  const name = payload.repository.name;
  const key = repoKey(owner, name);

  if (allowlist.size > 0 && !allowlist.has(key)) {
    return reply.code(202).send({ ignored: true, reason: 'repo not in allowlist' });
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    return reply.code(202).send({ ignored: true, reason: 'installation id missing' });
  }

  const existingRepo = await store.getRepoByOwnerAndName(owner, name);
  if (!existingRepo) {
    const activeRepos = await store.countActiveRepos();
    if (activeRepos >= maxRepos) {
      return reply.code(409).send({
        error: `Repo limit reached (${maxRepos}). Add this repo to existing set before onboarding.`
      });
    }
  }

  const repo = await store.upsertRepo({
    owner,
    name,
    installationId
  });

  await store.cancelStaleRuns(repo.id, payload.pull_request.number, payload.pull_request.head.sha);

  const run = await store.createRun({
    repoId: repo.id,
    prNumber: payload.pull_request.number,
    headSha: payload.pull_request.head.sha,
    baseBranch: payload.pull_request.base.ref,
    trigger: `webhook:${payload.action}`
  });

  const job: QueueJobPayload = {
    type: 'run_pr',
    runId: run.id
  };

  await scheduler.enqueue(job);

  return reply.code(202).send({ accepted: true, runId: run.id });
}

async function handleIssueCommentEvent(
  request: FastifyRequest<{ Body: IssueCommentPayload }>,
  reply: FastifyReply,
  store: RunStore,
  scheduler: RunScheduler
): Promise<FastifyReply> {
  const payload = request.body;

  if (payload.action !== 'created' || !payload.issue.pull_request) {
    return reply.code(202).send({ ignored: true, reason: 'not a pull request comment' });
  }

  const command = parseChatOpsCommand(payload.comment.body);
  if (!command) {
    return reply.code(202).send({ ignored: true, reason: 'no codex command' });
  }

  const owner = payload.repository.owner.login;
  const name = payload.repository.name;
  const prNumber = payload.issue.number;

  const latestRun = await store.getLatestRunWithRepoByPr(owner, name, prNumber);
  if (!latestRun) {
    return reply.code(202).send({ ignored: true, reason: 'no prior run available' });
  }

  if (command.type === 'rerun') {
    const run = await store.createRun({
      repoId: latestRun.repoId,
      prNumber: latestRun.prNumber,
      headSha: latestRun.headSha,
      baseBranch: latestRun.baseBranch,
      trigger: `chatops:rerun:${command.scope}`
    });

    await scheduler.enqueue({ type: 'run_pr', runId: run.id });

    return reply.code(202).send({ accepted: true, command: command.type, runId: run.id });
  }

  if (command.type === 'explain') {
    await scheduler.enqueue({
      type: 'explain_finding',
      runId: latestRun.id,
      findingId: command.findingId
    });

    return reply.code(202).send({ accepted: true, command: command.type });
  }

  if (command.type === 'patch') {
    await scheduler.enqueue({
      type: 'patch_finding',
      runId: latestRun.id,
      findingId: command.findingId
    });

    return reply.code(202).send({ accepted: true, command: command.type });
  }

  const running = await store.findRunningRun(latestRun.repoId, latestRun.prNumber);
  if (!running) {
    return reply.code(202).send({ ignored: true, reason: 'no running run to stop' });
  }

  await store.requestCancel(running.id, 'User requested stop via /codex stop');
  await scheduler.enqueue({
    type: 'cancel_run',
    runId: running.id,
    reason: 'User requested stop via /codex stop'
  });

  return reply.code(202).send({ accepted: true, command: command.type, runId: running.id });
}

export function repoAllowlistFromEnv(raw?: string): Set<string> {
  return parseRepoAllowlist(raw);
}
