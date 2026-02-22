import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { RunWithRepo } from '@pr-guardian/common';

import { RunOrchestrator } from '../src/orchestrator.js';

class TestStore {
  statuses: string[] = [];

  run: RunWithRepo = {
    id: 1,
    repoId: 10,
    prNumber: 77,
    headSha: 'abc123',
    baseBranch: 'main',
    status: 'queued',
    trigger: 'webhook:opened',
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
      id: 10,
      owner: 'acme',
      name: 'api',
      installationId: 1001,
      active: true,
      config: {},
      createdAt: new Date(),
      updatedAt: new Date()
    }
  };

  async getRunWithRepo(runId: number) {
    return runId === 1 ? this.run : null;
  }

  async updateRunStatus(_runId: number, status: string) {
    this.statuses.push(status);
  }

  async setCheckRunId() {}
  async requestCancel() {}
  async isCancellationRequested() {
    return false;
  }
  async recordTokenUsage() {}
  async insertEvent() {
    return { id: 1, runId: 1, source: 'app', eventType: 'x', payload: {}, createdAt: new Date() };
  }

  async insertThread(runId: number, role: string, appThreadId: string) {
    return {
      id: 1,
      runId,
      role,
      appThreadId,
      status: 'active',
      lastTurnId: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
  }

  async updateThreadTurn() {}
  async insertFindings() {}
  async insertPatch() {
    return {
      id: 1,
      findingId: 'f1',
      threadId: 1,
      diffText: '',
      suggestions: [],
      status: 'ready',
      riskNotes: null,
      createdAt: new Date()
    };
  }
  async getFinding() {
    return null;
  }
  async listPatchesForFinding() {
    return [];
  }
}

class TestGitHub {
  conclusions: string[] = [];
  comments: string[] = [];

  async getInstallationToken() {
    return 'token';
  }

  async createCheckRun() {
    return { id: 100 };
  }

  async updateCheckRun(_context: any, _checkRunId: number, conclusion: string) {
    this.conclusions.push(conclusion);
  }

  async createIssueComment(_context: any, _issue: number, body: string) {
    this.comments.push(body);
  }
}

class BaseClient extends EventEmitter {
  async start() {}
  async initialize() {}
  async stop() {}

  async request<T>(method: string, params?: any): Promise<T> {
    if (method === 'thread/start' || method === 'thread/fork') {
      return { thread: { id: params?.threadId ?? 'thread-1' } } as T;
    }

    if (method === 'review/start') {
      return {
        reviewThreadId: params.threadId,
        turn: { id: 'turn-review', status: 'inProgress', error: null, items: [] }
      } as T;
    }

    if (method === 'turn/start') {
      return {
        turn: { id: 'turn-normalize', status: 'inProgress', error: null, items: [] }
      } as T;
    }

    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          turns: [
            {
              id: 'turn-normalize',
              status: 'completed',
              error: null,
              items: [{ type: 'agentMessage', id: 'item-1', text: '{"findings":[]}' }]
            }
          ]
        }
      } as T;
    }

    return {} as T;
  }

  getLatestTurnDiff() {
    return null;
  }
}

class DisconnectClient extends BaseClient {
  async waitForTurnCompletion(): Promise<any> {
    throw new Error('response stream disconnected');
  }
}

class UsageLimitClient extends BaseClient {
  async waitForTurnCompletion(): Promise<any> {
    return {
      id: 'turn-review',
      status: 'failed',
      error: {
        codexErrorInfo: 'usageLimitExceeded'
      },
      items: []
    };
  }
}

class MalformedJsonClient extends BaseClient {
  async waitForTurnCompletion(): Promise<any> {
    return {
      id: 'turn-any',
      status: 'completed',
      error: null,
      items: []
    };
  }

  async request<T>(method: string, params?: any): Promise<T> {
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          turns: [
            {
              id: 'turn-normalize',
              status: 'completed',
              error: null,
              items: [{ type: 'agentMessage', id: 'item-1', text: 'not-json' }]
            }
          ]
        }
      } as T;
    }

    return super.request(method, params);
  }
}

async function runWithClient(client: EventEmitter & any) {
  const store = new TestStore();
  const github = new TestGitHub();

  const orchestrator = new RunOrchestrator({
    store: store as any,
    github: github as any,
    codexBin: 'codex',
    runTimeoutMs: 1_000,
    createAppClient: () => client,
    cloneRepoAtShaFn: async () => {},
    removeRepoCloneFn: async () => {}
  });

  await orchestrator.handleJob({ type: 'run_pr', runId: 1 });
  return { store, github };
}

describe('RunOrchestrator failure modes', () => {
  it('handles app-server disconnect mid-turn', async () => {
    const { store, github } = await runWithClient(new DisconnectClient());

    expect(store.statuses).toContain('failed');
    expect(github.conclusions).toContain('failure');
  });

  it('handles usage limit failures', async () => {
    const { store, github } = await runWithClient(new UsageLimitClient());

    expect(store.statuses).toContain('failed');
    expect(github.conclusions).toContain('failure');
  });

  it('survives malformed model JSON in normalization output', async () => {
    const { store, github } = await runWithClient(new MalformedJsonClient());

    expect(store.statuses).toContain('completed');
    expect(github.conclusions).toContain('success');
  });
});
