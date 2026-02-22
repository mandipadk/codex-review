import { describe, expect, it } from 'vitest';

import { dedupeAndRankFindings } from '../src/ranking.js';
import { Finding } from '../src/types.js';

const base: Finding = {
  id: 'f1',
  runId: 1,
  role: 'correctness',
  severity: 'medium',
  confidence: 0.6,
  filePath: 'src/app.ts',
  startLine: 10,
  endLine: 10,
  title: 'Potential bug',
  issueKey: 'bug-key',
  evidence: 'evidence',
  dedupeKey: 'abc',
  supportingRoles: ['correctness'],
  score: 0
};

describe('dedupeAndRankFindings', () => {
  it('dedupes findings by dedupeKey and merges roles', () => {
    const results = dedupeAndRankFindings([
      base,
      {
        ...base,
        id: 'f2',
        role: 'security',
        severity: 'high',
        supportingRoles: ['security']
      }
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.severity).toBe('high');
    expect(results[0]?.supportingRoles.sort()).toEqual(['correctness', 'security']);
  });
});
