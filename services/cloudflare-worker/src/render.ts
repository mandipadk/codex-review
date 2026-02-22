import { Finding, PatchRecord, PatchSuggestion } from './types.js';

function renderSuggestion(suggestion: PatchSuggestion): string {
  return [
    `File: \`${suggestion.filePath}\` (line ${suggestion.startLine})`,
    '```suggestion',
    suggestion.body,
    '```'
  ].join('\n');
}

export function renderSummary(findings: Finding[]): string {
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
  findings: Finding[];
  patches: PatchRecord[];
}): string {
  const sections: string[] = [
    '## PR Guardian Arena (Cloudflare)',
    `Run ID: \`${params.runId}\``,
    renderSummary(params.findings)
  ];

  if (params.findings.length === 0) {
    sections.push('No actionable issues detected by correctness/security/maintainability lenses.');
    sections.push('ChatOps: `/codex rerun`, `/codex explain <finding_id>`, `/codex patch <finding_id>`, `/codex stop`');
    return sections.join('\n\n');
  }

  sections.push('### Ranked Findings');

  for (const finding of params.findings) {
    sections.push(
      [
        `#### [${finding.id}] ${finding.title}`,
        `Severity: **${finding.severity}**`,
        `Confidence: ${finding.confidence.toFixed(2)}`,
        `Location: \`${finding.filePath}:${finding.startLine}-${finding.endLine}\``,
        `Roles: ${finding.supportingRoles.join(', ')}`,
        `Issue Key: \`${finding.issueKey}\``,
        `Evidence: ${finding.evidence}`
      ].join('\n')
    );

    const patch = params.patches.find((candidate) => candidate.findingId === finding.id);
    if (!patch) {
      continue;
    }

    sections.push(`Patch notes: ${patch.riskNotes}`);

    for (const suggestion of patch.suggestions.slice(0, 2)) {
      sections.push(renderSuggestion(suggestion));
    }
  }

  sections.push('ChatOps: `/codex rerun`, `/codex explain <finding_id>`, `/codex patch <finding_id>`, `/codex stop`');

  return sections.join('\n\n');
}

export function renderExplainComment(finding: Finding): string {
  return [
    `### Explanation for ${finding.id}`,
    `**${finding.title}**`,
    `Location: \`${finding.filePath}:${finding.startLine}-${finding.endLine}\``,
    `Evidence: ${finding.evidence}`,
    `Severity: ${finding.severity} | Confidence: ${finding.confidence.toFixed(2)}`
  ].join('\n\n');
}

export function renderPatchComment(findingId: string, patch: PatchRecord): string {
  const sections = [`### Patch suggestion for ${findingId}`, patch.riskNotes];

  if (patch.suggestions.length === 0) {
    sections.push('No inline suggestion could be generated from this patch.');
    return sections.join('\n\n');
  }

  for (const suggestion of patch.suggestions.slice(0, 3)) {
    sections.push(renderSuggestion(suggestion));
  }

  return sections.join('\n\n');
}
