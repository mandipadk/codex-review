import { ChatOpsCommand } from './types.js';

const rerunScopes = new Set(['correctness', 'security', 'maintainability', 'all']);
const idPattern = /^[a-zA-Z0-9_-]+$/;

export function parseChatOpsCommand(body: string): ChatOpsCommand | null {
  const trimmed = body.trim();

  if (!trimmed.startsWith('/codex ')) {
    return null;
  }

  if (trimmed.includes('\n')) {
    return null;
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) {
    return null;
  }

  const subcommand = tokens[1];

  if (subcommand === 'stop' && tokens.length === 2) {
    return { type: 'stop' };
  }

  if (subcommand === 'rerun') {
    const requestedScope = (tokens[2] ?? 'all').toLowerCase();
    if (!rerunScopes.has(requestedScope)) {
      return null;
    }

    return {
      type: 'rerun',
      scope: requestedScope as 'correctness' | 'security' | 'maintainability' | 'all'
    };
  }

  if (subcommand === 'explain' || subcommand === 'patch') {
    const findingId = tokens[2] ?? '';
    if (!idPattern.test(findingId)) {
      return null;
    }

    if (subcommand === 'explain') {
      return { type: 'explain', findingId };
    }

    return { type: 'patch', findingId };
  }

  return null;
}
