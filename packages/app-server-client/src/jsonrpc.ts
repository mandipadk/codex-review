import { JsonRpcMessage, JsonRpcRequest } from './types.js';

export function encodeJsonRpcRequest(id: number, method: string, params?: unknown): string {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method,
    params
  };

  return JSON.stringify(request);
}

export function parseJsonRpcMessage(line: string): JsonRpcMessage {
  const parsed: unknown = JSON.parse(line);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid JSON-RPC message payload type');
  }

  const message = parsed as Record<string, unknown>;
  if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
    return message as unknown as JsonRpcMessage;
  }

  if (typeof message.method === 'string' && 'params' in message) {
    return message as unknown as JsonRpcMessage;
  }

  throw new Error('Invalid JSON-RPC message shape');
}
