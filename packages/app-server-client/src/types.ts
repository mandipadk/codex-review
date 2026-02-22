export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse<T = unknown> {
  id: number;
  result: T;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  id: number;
  error: JsonRpcErrorObject;
}

export interface JsonRpcNotification<T = unknown> {
  method: string;
  params: T;
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccessResponse<T> | JsonRpcErrorResponse;
export type JsonRpcMessage<T = unknown> = JsonRpcResponse<T> | JsonRpcNotification<T>;

export interface AppThread {
  id: string;
  turns?: AppTurn[];
  [key: string]: unknown;
}

export interface AppTurn {
  id: string;
  status: 'inProgress' | 'completed' | 'failed' | string;
  error: unknown | null;
  items: Array<Record<string, unknown>>;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: AppTurn;
}

export interface TurnDiffUpdatedNotification {
  threadId: string;
  turnId: string;
  diff: string;
}

export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: {
    last: TokenUsageBreakdown;
    total: TokenUsageBreakdown;
  };
}

export interface ThreadStartResponse {
  thread: AppThread;
}

export interface ThreadForkResponse {
  thread: AppThread;
}

export interface TurnStartResponse {
  turn: AppTurn;
}

export interface ThreadReadResponse {
  thread: AppThread;
}

export interface ReviewStartResponse {
  reviewThreadId: string;
  turn: AppTurn;
}
