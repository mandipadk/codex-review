import { createHash } from 'node:crypto';

import { Finding, RankedFinding, ReviewRole, Severity } from './types.js';

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

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function buildDedupeKey(input: Pick<Finding, 'file' | 'startLine' | 'endLine' | 'issueKey'>): string {
  const normalized = [
    input.file.trim().toLowerCase(),
    Math.max(1, input.startLine),
    Math.max(1, input.endLine),
    input.issueKey.trim().toLowerCase().replace(/\s+/g, ' ')
  ].join('|');

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function higherSeverity(a: Severity, b: Severity): Severity {
  return severityWeight[a] >= severityWeight[b] ? a : b;
}

export function dedupeFindings(findings: Finding[]): RankedFinding[] {
  const grouped = new Map<string, RankedFinding>();

  for (const finding of findings) {
    const key = finding.dedupeKey || buildDedupeKey(finding);
    const confidence = clampConfidence(finding.confidence);

    if (!grouped.has(key)) {
      grouped.set(key, {
        ...finding,
        dedupeKey: key,
        confidence,
        score: 0,
        supportingRoles: [finding.role]
      });
      continue;
    }

    const current = grouped.get(key)!;
    const mergedRoles = new Set<ReviewRole>([...current.supportingRoles, finding.role]);

    grouped.set(key, {
      ...current,
      severity: higherSeverity(current.severity, finding.severity),
      confidence: Math.max(current.confidence, confidence),
      title: current.title.length >= finding.title.length ? current.title : finding.title,
      evidence: {
        ...current.evidence,
        corroboratingEvidence: [
          ...(Array.isArray(current.evidence.corroboratingEvidence)
            ? (current.evidence.corroboratingEvidence as unknown[])
            : []),
          finding.evidence
        ]
      },
      supportingRoles: Array.from(mergedRoles)
    });
  }

  return Array.from(grouped.values()).map((finding) => ({
    ...finding,
    score: rankScore(finding)
  }));
}

export function rankScore(finding: Pick<RankedFinding, 'severity' | 'confidence' | 'supportingRoles' | 'role'>): number {
  const severity = severityWeight[finding.severity] * 10;
  const confidence = clampConfidence(finding.confidence) * 8;
  const agreement = finding.supportingRoles.length * 5;
  const rolePriority = roleBonus[finding.role] ?? 0;
  return Number((severity + confidence + agreement + rolePriority).toFixed(4));
}

export function rankFindings(findings: Finding[]): RankedFinding[] {
  const deduped = dedupeFindings(findings);
  return deduped.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return left.id.localeCompare(right.id);
  });
}

export function topFindings(findings: Finding[], limit = 3): RankedFinding[] {
  return rankFindings(findings).slice(0, limit);
}
