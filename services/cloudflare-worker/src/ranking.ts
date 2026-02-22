import { Finding, ReviewRole, Severity } from './types.js';

const severityWeight: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

const roleBonus: Record<ReviewRole, number> = {
  correctness: 0.6,
  security: 0.9,
  maintainability: 0.5
};

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function maxSeverity(left: Severity, right: Severity): Severity {
  return severityWeight[left] >= severityWeight[right] ? left : right;
}

function scoreForFinding(finding: Finding): number {
  return Number(
    (
      severityWeight[finding.severity] * 10 +
      clamp01(finding.confidence) * 8 +
      finding.supportingRoles.length * 5 +
      roleBonus[finding.role]
    ).toFixed(4)
  );
}

export function dedupeAndRankFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();

  for (const finding of findings) {
    const existing = byKey.get(finding.dedupeKey);
    if (!existing) {
      byKey.set(finding.dedupeKey, {
        ...finding,
        confidence: clamp01(finding.confidence)
      });
      continue;
    }

    const supporting = new Set<ReviewRole>([...existing.supportingRoles, ...finding.supportingRoles, finding.role]);

    byKey.set(finding.dedupeKey, {
      ...existing,
      severity: maxSeverity(existing.severity, finding.severity),
      confidence: Math.max(existing.confidence, clamp01(finding.confidence)),
      supportingRoles: Array.from(supporting)
    });
  }

  const ranked = Array.from(byKey.values()).map((finding) => ({
    ...finding,
    score: scoreForFinding(finding)
  }));

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return left.id.localeCompare(right.id);
  });

  return ranked;
}
