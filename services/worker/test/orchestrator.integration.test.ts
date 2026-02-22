import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { FindingRecord, PatchRecord, RunWithRepo } from '@pr-guardian/common';

import { RunOrchestrator } from '../src/orchestrator.js';

class MockStore {
  statuses: string[] = [];
  insertedFindings: FindingRecord[] = [];
  insertedPatches: PatchRecord[] = [];

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
    return runId === this.run.id ? this.run : null;
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
    return {
      id: 1,
      runId: 1,
      source: 'app-server',
      eventType: 'turn/completed',
      payload: {},
      createdAt: new Date()
    };
  }

  async insertThread(runId: number, role: string, appThreadId: string) {
    return {
      id: Math.floor(Math.random() * 1000) + 1,
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

  async insertFindings(_runId: number, findings: Array<any>) {
    this.insertedFindings = findings.map((finding) => ({
      id: finding.id,
      runId: 1,
      role: finding.role,
      severity: finding.severity,
      confidence: finding.confidence,
      filePath: finding.filePath,
      startLine: finding.startLine,
      endLine: finding.endLine,
      title: finding.title,
      evidence: finding.evidence,
      dedupeKey: finding.dedupeKey,
      disposition: 'open',
      createdAt: new Date()
    }));
  }

  async insertPatch(patch: any) {
    const record: PatchRecord = {
      id: this.insertedPatches.length + 1,
      findingId: patch.findingId,
      threadId: patch.threadId,
      diffText: patch.diffText,
      suggestions: patch.suggestions,
      status: patch.status,
      riskNotes: patch.riskNotes ?? null,
      createdAt: new Date()
    };

    this.insertedPatches.push(record);
    return record;
  }

  async getFinding() {
    return null;
  }

  async listPatchesForFinding() {
    return [];
  }
}

class MockGitHub {
  comments: string[] = [];
  updates: string[] = [];

  async getInstallationToken() {
    return 'token';
  }

  async createCheckRun() {
    return { id: 100 };
  }

  async updateCheckRun(_context: any, _checkRunId: number, conclusion: string) {
    this.updates.push(conclusion);
  }

  async createIssueComment(_context: any, _issueNumber: number, body: string) {
    this.comments.push(body);
  }
}

class MockAppClient extends EventEmitter {
  private threadCount = 0;
  private turnCount = 0;
  private readonly threadTurns = new Map<string, any[]>();
  private readonly threadRole = new Map<string, string>();
  private readonly diffByTurn = new Map<string, string>();

  async start() {}
  async initialize() {}
  async stop() {}

  async request<T>(method: string, params?: any): Promise<T> {
    if (method === 'thread/start') {
      const threadId = `thread-${++this.threadCount}`;
      this.threadTurns.set(threadId, []);
      return { thread: { id: threadId } } as T;
    }

    if (method === 'thread/fork') {
      const threadId = `thread-${++this.threadCount}`;
      this.threadTurns.set(threadId, []);

      const instructions = String(params?.developerInstructions ?? '');
      if (instructions.includes('security')) {
        this.threadRole.set(threadId, 'security');
      } else if (instructions.includes('maintainability')) {
        this.threadRole.set(threadId, 'maintainability');
      } else {
        this.threadRole.set(threadId, 'correctness');
      }

      return { thread: { id: threadId } } as T;
    }

    if (method === 'review/start') {
      const turnId = `turn-${++this.turnCount}`;
      return {
        reviewThreadId: params.threadId,
        turn: { id: turnId, status: 'inProgress', error: null, items: [] }
      } as T;
    }

    if (method === 'turn/start') {
      const turnId = `turn-${++this.turnCount}`;
      const threadId = params.threadId as string;

      const turns = this.threadTurns.get(threadId) ?? [];
      const outputSchema = params.outputSchema as any;

      if (outputSchema?.properties?.findings) {
        const role = this.threadRole.get(threadId) ?? 'correctness';
        const finding = {
          findings: [
            {
              title: `${role} issue`,
              severity: role === 'security' ? 'high' : 'medium',
              confidence: role === 'security' ? 0.9 : 0.7,
              file: role === 'security' ? 'src/auth.ts' : 'src/app.ts',
              startLine: role === 'security' ? 12 : 35,
              endLine: role === 'security' ? 12 : 35,
              issueKey: `${role}-issue`,
              evidence: `${role} evidence`
            }
          ]
        };

        turns.push({
          id: turnId,
          status: 'completed',
          error: null,
          items: [
            { type: 'agentMessage', id: `item-${turnId}`, text: JSON.stringify(finding) }
          ]
        });
      } else {
        const patchSummary = { riskNotes: 'Low risk patch, localized change.' };
        this.diffByTurn.set(
          turnId,
          [
            'diff --git a/src/app.ts b/src/app.ts',
            '@@ -35,2 +35,2 @@',
            '-const enabled = false;',
            '+const enabled = true;'
          ].join('\n')
        );

        turns.push({
          id: turnId,
          status: 'completed',
          error: null,
          items: [
            { type: 'agentMessage', id: `item-${turnId}`, text: JSON.stringify(patchSummary) }
          ]
        });
      }

      this.threadTurns.set(threadId, turns);

      return {
        turn: { id: turnId, status: 'inProgress', error: null, items: [] }
      } as T;
    }

    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          turns: this.threadTurns.get(params.threadId) ?? []
        }
      } as T;
    }

    return {} as T;
  }

  async waitForTurnCompletion(_threadId: string, turnId: string) {
    return { id: turnId, status: 'completed', error: null, items: [] };
  }

  getLatestTurnDiff(turnId: string): string | null {
    return this.diffByTurn.get(turnId) ?? null;
  }
}

describe('RunOrchestrator integration', () => {
  it('runs full pipeline and posts consolidated comment', async () => {
    const store = new MockStore();
    const github = new MockGitHub();

    const orchestrator = new RunOrchestrator({
      store: store as any,
      github: github as any,
      codexBin: 'codex',
      runTimeoutMs: 1_000,
      createAppClient: () => new MockAppClient() as any,
      cloneRepoAtShaFn: async () => {},
      removeRepoCloneFn: async () => {}
    });

    await orchestrator.handleJob({ type: 'run_pr', runId: 1 });

    expect(store.statuses).toContain('running');
    expect(store.statuses).toContain('completed');
    expect(store.insertedFindings.length).toBeGreaterThan(0);
    expect(store.insertedPatches.length).toBeGreaterThan(0);
    expect(github.comments[0]).toContain('PR Guardian Arena Report');
    expect(github.updates).toContain('success');
  });
});
