import { describe, expect, it } from 'vitest';

import { encodeJsonRpcRequest, parseJsonRpcMessage } from '../src/jsonrpc.js';

describe('jsonrpc codec', () => {
  it('encodes requests with jsonrpc envelope', () => {
    const encoded = encodeJsonRpcRequest(7, 'turn/start', { threadId: 't1' });
    expect(JSON.parse(encoded)).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      method: 'turn/start',
      params: { threadId: 't1' }
    });
  });

  it('parses response and notification messages', () => {
    const response = parseJsonRpcMessage('{"id":1,"result":{"ok":true}}');
    const notification = parseJsonRpcMessage('{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"x","status":"completed","error":null,"items":[]}}}');

    expect('id' in response).toBe(true);
    expect('method' in notification).toBe(true);
  });

  it('rejects malformed messages', () => {
    expect(() => parseJsonRpcMessage('{"foo":"bar"}')).toThrowError(/Invalid JSON-RPC message shape/);
  });
});
