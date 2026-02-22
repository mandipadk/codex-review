import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, Interface } from 'node:readline';

import { encodeJsonRpcRequest, parseJsonRpcMessage } from './jsonrpc.js';
import {
  AppTurn,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcResponse,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnDiffUpdatedNotification
} from './types.js';

export interface CodexAppServerClientOptions {
  codexBin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

type PendingResponse = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  method: string;
};

type TurnWaiter = {
  resolve: (value: AppTurn) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

export class CodexAppServerClient extends EventEmitter {
  private readonly codexBin: string;
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;

  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;

  private nextRequestId = 1;
  private readonly pendingResponses = new Map<number, PendingResponse>();

  private readonly completedTurns = new Map<string, AppTurn>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();

  private readonly diffByTurn = new Map<string, string>();
  private readonly tokenUsageByThread = new Map<string, ThreadTokenUsageUpdatedNotification['tokenUsage']['total']>();

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    this.codexBin = options.codexBin ?? 'codex';
    this.cwd = options.cwd;
    this.env = options.env;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const child = spawn(this.codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child = child;

    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.handleStdoutLine(line));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.emit('stderr', chunk);
    });

    child.once('exit', (code, signal) => {
      const reason = new Error(`codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      this.failAllPending(reason);
      this.emit('exit', { code, signal });
    });

    child.once('error', (error) => {
      this.failAllPending(error);
      this.emit('error', error);
    });
  }

  async initialize(clientName = 'pr-guardian-arena', clientVersion = '0.1.0'): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: clientName,
        version: clientVersion
      },
      capabilities: {
        experimentalApi: true
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;

    this.rl?.close();
    this.rl = null;

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
      }, 2_000).unref();
    });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.child) {
      await this.start();
    }

    const activeChild = this.child;
    if (!activeChild) {
      throw new Error('Failed to start codex app-server process');
    }

    const id = this.nextRequestId++;
    const line = encodeJsonRpcRequest(id, method, params);

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pendingResponses.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        method
      });
    });

    activeChild.stdin.write(`${line}\n`);
    return responsePromise;
  }

  async waitForTurnCompletion(threadId: string, turnId: string, timeoutMs = 10 * 60 * 1000): Promise<AppTurn> {
    const key = `${threadId}:${turnId}`;
    const completed = this.completedTurns.get(key);
    if (completed) {
      return completed;
    }

    return new Promise<AppTurn>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(key);
        reject(new Error(`Timed out waiting for turn completion (${key})`));
      }, timeoutMs);

      this.turnWaiters.set(key, {
        resolve: (turn) => {
          clearTimeout(timer);
          resolve(turn);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer
      });
    });
  }

  getLatestTurnDiff(turnId: string): string | null {
    return this.diffByTurn.get(turnId) ?? null;
  }

  getLatestTokenUsage(threadId: string): ThreadTokenUsageUpdatedNotification['tokenUsage']['total'] | null {
    return this.tokenUsageByThread.get(threadId) ?? null;
  }

  private failAllPending(reason: unknown): void {
    for (const pending of this.pendingResponses.values()) {
      pending.reject(reason);
    }
    this.pendingResponses.clear();

    for (const [key, waiter] of this.turnWaiters.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Turn waiter canceled (${key})`));
    }
    this.turnWaiters.clear();
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: JsonRpcResponse | JsonRpcNotification;

    try {
      message = parseJsonRpcMessage(line);
    } catch (error) {
      this.emit('parseError', { line, error });
      return;
    }

    if ('id' in message && (('result' in message && message.result !== undefined) || 'error' in message)) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    this.handleNotification(message as JsonRpcNotification);
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingResponses.get(response.id);
    if (!pending) {
      return;
    }

    this.pendingResponses.delete(response.id);

    if ('error' in response) {
      const err = response as JsonRpcErrorResponse;
      pending.reject(new Error(`${pending.method} failed: ${err.error.message}`));
      return;
    }

    pending.resolve(response.result);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    this.emit('notification', notification);

    if (notification.method === 'turn/completed') {
      const payload = notification.params as TurnCompletedNotification;
      const key = `${payload.threadId}:${payload.turn.id}`;
      this.completedTurns.set(key, payload.turn);

      const waiter = this.turnWaiters.get(key);
      if (waiter) {
        this.turnWaiters.delete(key);
        waiter.resolve(payload.turn);
      }

      return;
    }

    if (notification.method === 'turn/diff/updated') {
      const payload = notification.params as TurnDiffUpdatedNotification;
      this.diffByTurn.set(payload.turnId, payload.diff);
      return;
    }

    if (notification.method === 'thread/tokenUsage/updated') {
      const payload = notification.params as ThreadTokenUsageUpdatedNotification;
      this.tokenUsageByThread.set(payload.threadId, payload.tokenUsage.total);
      return;
    }
  }
}
