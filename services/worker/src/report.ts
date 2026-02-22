import { renderSuggestionMarkdown } from '@pr-guardian/domain';
import { RankedFinding } from '@pr-guardian/domain';

interface PatchByFinding {
  findingId: string;
  suggestions: Array<{ filePath: string; startLine: number; endLine: number; body: string }>;
  riskNotes: string;
}

export function renderRunSummary(findings: RankedFinding[]): string {
  const counts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0
  };

  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  return `Findings: ${findings.length} (critical: ${counts.critical}, high: ${counts.high}, medium: ${counts.medium}, low: ${counts.low})`;
}

export function renderConsolidatedComment(params: {
  runId: number;
  findings: RankedFinding[];
  patches: PatchByFinding[];
}): string {
  const sections: string[] = [];

  sections.push('## PR Guardian Arena Report');
  sections.push(`Run ID: \`${params.runId}\``);
  sections.push(renderRunSummary(params.findings));

  if (params.findings.length === 0) {
    sections.push('No actionable issues detected by the configured review lenses.');
    return sections.join('\n\n');
  }

  sections.push('### Ranked Findings');

  for (const finding of params.findings) {
    sections.push(
      [
        `#### [${finding.id}] ${finding.title}`,
        `Severity: **${finding.severity}**`,
        `Confidence: ${finding.confidence.toFixed(2)}`,
        `Location: \`${finding.file}:${finding.startLine}-${finding.endLine}\``,
        `Roles: ${finding.supportingRoles.join(', ')}`,
        `Issue key: \`${finding.issueKey}\``
      ].join('\n')
    );

    const patch = params.patches.find((candidate) => candidate.findingId === finding.id);
    if (!patch) {
      continue;
    }

    sections.push(`Suggested patch notes: ${patch.riskNotes}`);

    for (const suggestion of patch.suggestions.slice(0, 2)) {
      sections.push(
        renderSuggestionMarkdown({
          filePath: suggestion.filePath,
          startLine: suggestion.startLine,
          endLine: suggestion.endLine,
          body: suggestion.body
        })
      );
    }
  }

  sections.push('ChatOps: `/codex rerun`, `/codex explain <finding_id>`, `/codex patch <finding_id>`, `/codex stop`');

  return sections.join('\n\n');
}

export function renderExplainComment(params: {
  findingId: string;
  title: string;
  filePath: string;
  startLine: number;
  endLine: number;
  evidence: string;
}): string {
  return [
    `### Explanation for ${params.findingId}`,
    `**${params.title}**`,
    `Location: \`${params.filePath}:${params.startLine}-${params.endLine}\``,
    `Evidence: ${params.evidence}`
  ].join('\n\n');
}

export function renderPatchComment(params: {
  findingId: string;
  riskNotes: string;
  suggestions: Array<{ filePath: string; startLine: number; endLine: number; body: string }>;
}): string {
  const lines = [
    `### Patch suggestion for ${params.findingId}`,
    params.riskNotes
  ];

  if (params.suggestions.length === 0) {
    lines.push('No inline suggestion could be generated from the current diff.');
    return lines.join('\n\n');
  }

  for (const suggestion of params.suggestions.slice(0, 3)) {
    lines.push(
      renderSuggestionMarkdown({
        filePath: suggestion.filePath,
        startLine: suggestion.startLine,
        endLine: suggestion.endLine,
        body: suggestion.body
      })
    );
  }

  return lines.join('\n\n');
}
