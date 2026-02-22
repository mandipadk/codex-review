import { describe, expect, it } from 'vitest';

import { renderSuggestionMarkdown, toGithubSuggestions } from '../src/diff.js';

describe('toGithubSuggestions', () => {
  it('extracts suggestion blocks from unified diff', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      'index abc123..def456 100644',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -8,3 +8,4 @@ export function main() {',
      '   doThing();',
      '-  return false;',
      '+  const safe = true;',
      '+  return safe;',
      ' }'
    ].join('\n');

    const suggestions = toGithubSuggestions(diff);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.filePath).toBe('src/index.ts');
    expect(suggestions[0]?.body).toContain('const safe = true;');

    const markdown = renderSuggestionMarkdown(suggestions[0]!);
    expect(markdown).toContain('```suggestion');
  });
});
