import { ReviewRole } from '@pr-guardian/domain';

export const PERSONAS: Array<{ role: ReviewRole; instructions: string }> = [
  {
    role: 'correctness',
    instructions:
      'You are the correctness specialist. Focus on logic bugs, race conditions, and behavior regressions. Ignore style concerns.'
  },
  {
    role: 'security',
    instructions:
      'You are the security specialist. Focus on injection, authZ/authN, secrets exposure, privilege escalation, and unsafe defaults.'
  },
  {
    role: 'maintainability',
    instructions:
      'You are the maintainability specialist. Focus on readability debt, brittle abstractions, and change-risk hotspots.'
  }
];

export const ROOT_DEVELOPER_INSTRUCTIONS = [
  'You are PR Guardian Arena, an expert pull-request reviewer.',
  'Optimize for actionable and high-confidence findings.',
  'Do not fabricate files or line numbers.',
  'Prefer concrete, minimal fixes.'
].join(' ');

export const NORMALIZED_FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'confidence', 'file', 'startLine', 'endLine', 'issueKey', 'evidence'],
        properties: {
          title: { type: 'string' },
          severity: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical']
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          file: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          issueKey: { type: 'string' },
          evidence: { type: 'string' },
          suggestedFix: { type: 'string' }
        }
      }
    }
  }
} as const;

export const PATCH_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['riskNotes'],
  properties: {
    riskNotes: { type: 'string' }
  }
} as const;

export function buildNormalizationPrompt(role: ReviewRole): string {
  return [
    `Convert your ${role} review into strict JSON.` ,
    'Only include actionable issues with concrete files and line numbers.',
    'Use confidence between 0 and 1.',
    'If there are no issues, return {"findings":[]}.',
    'Do not include markdown.'
  ].join(' ');
}

export function buildPatchPrompt(params: {
  title: string;
  file: string;
  startLine: number;
  endLine: number;
  evidence: string;
}): string {
  return [
    'Apply a minimal patch in the repository that addresses this finding.',
    `Title: ${params.title}`,
    `File: ${params.file}`,
    `Lines: ${params.startLine}-${params.endLine}`,
    `Evidence: ${params.evidence}`,
    'After applying changes, keep behavior stable outside the fix scope.'
  ].join('\n');
}
