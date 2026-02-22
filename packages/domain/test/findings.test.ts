import { describe, expect, it } from 'vitest';

import { buildDedupeKey, rankFindings } from '../src/findings.js';
import { Finding } from '../src/types.js';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: crypto.randomUUID(),
    repo: 'acme/api',
    prNumber: 42,
    role: 'correctness',
    severity: 'medium',
    confidence: 0.6,
    file: 'src/index.ts',
    startLine: 10,
    endLine: 10,
    title: 'Potential null dereference',
    issueKey: 'null-deref',
    evidence: {},
    dedupeKey: buildDedupeKey({
      file: 'src/index.ts',
      startLine: 10,
      endLine: 10,
      issueKey: 'null-deref'
    }),
    ...overrides
  };
}

describe('rankFindings', () => {
  it('dedupes findings across personas and keeps highest severity', () => {
    const first = makeFinding({ role: 'correctness', severity: 'medium', confidence: 0.61 });
    const second = makeFinding({ role: 'security', severity: 'high', confidence: 0.81 });

    const ranked = rankFindings([first, second]);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.severity).toBe('high');
    expect(ranked[0]?.supportingRoles.sort()).toEqual(['correctness', 'security']);
  });

  it('prioritizes critical findings over low-confidence medium findings', () => {
    const critical = makeFinding({
      id: 'critical-1',
      severity: 'critical',
      confidence: 0.55,
      issueKey: 'sql-injection',
      dedupeKey: buildDedupeKey({
        file: 'src/db.ts',
        startLine: 20,
        endLine: 20,
        issueKey: 'sql-injection'
      }),
      file: 'src/db.ts',
      startLine: 20,
      endLine: 20
    });

    const medium = makeFinding({
      id: 'medium-1',
      severity: 'medium',
      confidence: 0.95,
      issueKey: 'style-nit',
      dedupeKey: buildDedupeKey({
        file: 'src/ui.ts',
        startLine: 11,
        endLine: 11,
        issueKey: 'style-nit'
      }),
      file: 'src/ui.ts',
      startLine: 11,
      endLine: 11
    });

    const ranked = rankFindings([medium, critical]);
    expect(ranked[0]?.id).toBe('critical-1');
  });
});
