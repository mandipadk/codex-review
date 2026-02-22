import { describe, expect, it } from 'vitest';

import { parseChatOpsCommand } from '../src/chatops.js';

describe('parseChatOpsCommand', () => {
  it('parses rerun default scope', () => {
    expect(parseChatOpsCommand('/codex rerun')).toEqual({ type: 'rerun', scope: 'all' });
  });

  it('parses patch command with ID', () => {
    expect(parseChatOpsCommand('/codex patch finding_42')).toEqual({ type: 'patch', findingId: 'finding_42' });
  });

  it('rejects multiline and traversal strings', () => {
    expect(parseChatOpsCommand('/codex stop\nrm -rf /')).toBeNull();
    expect(parseChatOpsCommand('/codex explain ../etc/passwd')).toBeNull();
  });
});
