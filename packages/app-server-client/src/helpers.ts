import { AppThread, AppTurn } from './types.js';

export function extractAgentMessagesFromTurn(turn: AppTurn): string[] {
  return turn.items
    .filter((item) => item.type === 'agentMessage')
    .map((item) => String(item.text ?? ''))
    .filter(Boolean);
}

export function extractLatestAgentMessage(thread: AppThread): string | null {
  const turns = thread.turns ?? [];
  if (turns.length === 0) {
    return null;
  }

  const latestTurn = turns[turns.length - 1];
  if (!latestTurn) {
    return null;
  }

  const messages = extractAgentMessagesFromTurn(latestTurn);
  if (messages.length === 0) {
    return null;
  }

  return messages[messages.length - 1] ?? null;
}
