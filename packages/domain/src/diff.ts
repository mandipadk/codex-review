import { GithubSuggestion } from './types.js';

export function toGithubSuggestions(diff: string, maxSuggestions = 5): GithubSuggestion[] {
  const lines = diff.split('\n');
  const suggestions: GithubSuggestion[] = [];

  let currentFile: string | null = null;
  let newLine = 0;
  let pendingStart: number | null = null;
  let pendingBody: string[] = [];

  const flush = () => {
    if (!currentFile || pendingStart === null || pendingBody.length === 0) {
      pendingStart = null;
      pendingBody = [];
      return;
    }

    suggestions.push({
      filePath: currentFile,
      startLine: pendingStart,
      endLine: pendingStart,
      body: pendingBody.join('\n')
    });

    pendingStart = null;
    pendingBody = [];
  };

  for (const line of lines) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      flush();
      currentFile = fileMatch[2] ?? fileMatch[1] ?? null;
      continue;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      flush();
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }

    if (line.startsWith('+')) {
      if (pendingStart === null) {
        pendingStart = Math.max(1, newLine - 1);
      }
      pendingBody.push(line.slice(1));
      newLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      if (pendingStart === null) {
        pendingStart = Math.max(1, newLine - 1);
      }
      continue;
    }

    flush();

    if (line.startsWith(' ')) {
      newLine += 1;
    }
  }

  flush();
  return suggestions.slice(0, maxSuggestions);
}

export function renderSuggestionMarkdown(suggestion: GithubSuggestion): string {
  return [
    `File: \`${suggestion.filePath}\` (line ${suggestion.startLine})`,
    '```suggestion',
    suggestion.body,
    '```'
  ].join('\n');
}
