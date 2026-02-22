import { ParsedCommand } from './types.js';

const scopeSet = new Set(['correctness', 'security', 'maintainability', 'all']);
const idPattern = /^[a-zA-Z0-9_-]+$/;

export function parseChatOpsCommand(body: string): ParsedCommand | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('/codex ')) {
    return null;
  }

  if (trimmed.includes('\n')) {
    return null;
  }

  const tokens = trimmed.split(/\s+/);
  const cmd = tokens[1];

  if (cmd === 'stop' && tokens.length === 2) {
    return { type: 'stop' };
  }

  if (cmd === 'rerun') {
    const scope = (tokens[2] ?? 'all').toLowerCase();
    if (!scopeSet.has(scope)) {
      return null;
    }

    return {
      type: 'rerun',
      scope: scope as ParsedCommand['scope']
    };
  }

  if ((cmd === 'explain' || cmd === 'patch') && tokens[2] && idPattern.test(tokens[2])) {
    return {
      type: cmd,
      findingId: tokens[2]
    };
  }

  return null;
}
