import { describe, expect, it } from 'vitest';

import { parseChatOpsCommand } from '../src/chatops.js';

describe('parseChatOpsCommand', () => {
  it('parses rerun with default scope', () => {
    expect(parseChatOpsCommand('/codex rerun')).toEqual({ type: 'rerun', scope: 'all' });
  });

  it('parses explain command', () => {
    expect(parseChatOpsCommand('/codex explain finding_123')).toEqual({
      type: 'explain',
      findingId: 'finding_123'
    });
  });

  it('rejects invalid IDs and multiline payloads', () => {
    expect(parseChatOpsCommand('/codex patch ../etc/passwd')).toBeNull();
    expect(parseChatOpsCommand('/codex stop\nrm -rf /')).toBeNull();
  });
});
