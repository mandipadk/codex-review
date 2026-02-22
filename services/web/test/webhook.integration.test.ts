import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';
import { RunScheduler } from '../src/scheduler.js';

class InMemoryStore {
  private repoSeq = 1;
  private runSeq = 1;

  repos: Array<{ id: number; owner: string; name: string; installationId: number }> = [];
  runs: Array<{
    id: number;
    repoId: number;
    prNumber: number;
    headSha: string;
    baseBranch: string;
    status: string;
    trigger: string;
  }> = [];

  async countActiveRepos(): Promise<number> {
    return this.repos.length;
  }

  async getRepoByOwnerAndName(owner: string, name: string) {
    return this.repos.find((repo) => repo.owner === owner && repo.name === name) ?? null;
  }

  async upsertRepo(input: { owner: string; name: string; installationId: number }) {
    const existing = this.repos.find((repo) => repo.owner === input.owner && repo.name === input.name);
    if (existing) {
      existing.installationId = input.installationId;
      return {
        ...existing,
        active: true,
        config: {},
        createdAt: new Date(),
        updatedAt: new Date()
      };
    }

    const created = {
      id: this.repoSeq++,
      owner: input.owner,
      name: input.name,
      installationId: input.installationId
    };

    this.repos.push(created);

    return {
      ...created,
      active: true,
      config: {},
      createdAt: new Date(),
      updatedAt: new Date()
    };
  }

  async cancelStaleRuns(): Promise<number[]> {
    return [];
  }

  async createRun(input: {
    repoId: number;
    prNumber: number;
    headSha: string;
    baseBranch: string;
    trigger: string;
  }) {
    const created = {
      id: this.runSeq++,
      ...input,
      status: 'queued'
    };

    this.runs.push(created);

    return {
      ...created,
      checkRunId: null,
      startedAt: null,
      endedAt: null,
      errorText: null,
      tokenInput: 0,
      tokenOutput: 0,
      tokenTotal: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };
  }

  async getRunWithRepo(runId: number) {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      return null;
    }

    const repo = this.repos.find((candidate) => candidate.id === run.repoId);
    if (!repo) {
      return null;
    }

    return {
      ...run,
      repo: {
        ...repo,
        active: true,
        config: {},
        createdAt: new Date(),
        updatedAt: new Date()
      },
      checkRunId: null,
      startedAt: null,
      endedAt: null,
      errorText: null,
      tokenInput: 0,
      tokenOutput: 0,
      tokenTotal: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };
  }

  async getLatestRunWithRepoByPr(owner: string, name: string, prNumber: number) {
    const repo = this.repos.find((candidate) => candidate.owner === owner && candidate.name === name);
    if (!repo) {
      return null;
    }

    const run = [...this.runs]
      .reverse()
      .find((candidate) => candidate.repoId === repo.id && candidate.prNumber === prNumber);

    if (!run) {
      return null;
    }

    return {
      ...run,
      repoId: repo.id,
      status: 'completed',
      checkRunId: null,
      startedAt: null,
      endedAt: null,
      errorText: null,
      tokenInput: 0,
      tokenOutput: 0,
      tokenTotal: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      repo: {
        ...repo,
        active: true,
        config: {},
        createdAt: new Date(),
        updatedAt: new Date()
      }
    };
  }

  async findRunningRun() {
    return null;
  }

  async requestCancel() {}
}

class InMemoryScheduler implements RunScheduler {
  jobs: unknown[] = [];

  async enqueue(payload: unknown): Promise<void> {
    this.jobs.push(payload);
  }
}

describe('webhook integration', () => {
  it('queues a run job for pull_request opened', async () => {
    const store = new InMemoryStore();
    const scheduler = new InMemoryScheduler();

    const server = buildServer({
      store: store as never,
      scheduler,
      maxRepos: 5
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'pull_request'
      },
      payload: {
        action: 'opened',
        installation: { id: 1001 },
        repository: { name: 'api', owner: { login: 'acme' } },
        pull_request: {
          number: 42,
          head: { sha: 'abc123', ref: 'feature/a' },
          base: { ref: 'main' }
        }
      }
    });

    expect(response.statusCode).toBe(202);
    expect(scheduler.jobs).toContainEqual({ type: 'run_pr', runId: 1 });

    await server.close();
  });

  it('queues patch command job from issue comment', async () => {
    const store = new InMemoryStore();
    const scheduler = new InMemoryScheduler();

    await store.upsertRepo({ owner: 'acme', name: 'api', installationId: 1001 });
    await store.createRun({
      repoId: 1,
      prNumber: 7,
      headSha: 'abc123',
      baseBranch: 'main',
      trigger: 'seed'
    });

    const server = buildServer({
      store: store as never,
      scheduler,
      maxRepos: 5
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'issue_comment'
      },
      payload: {
        action: 'created',
        repository: { name: 'api', owner: { login: 'acme' } },
        issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/api/pulls/7' } },
        comment: { body: '/codex patch finding_01' }
      }
    });

    expect(response.statusCode).toBe(202);
    expect(scheduler.jobs).toContainEqual({
      type: 'patch_finding',
      runId: 1,
      findingId: 'finding_01'
    });

    await server.close();
  });
});
