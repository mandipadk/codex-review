import { TokenUsage } from './types.js';

const OPENAI_API = 'https://api.openai.com/v1/responses';

interface OpenAIJsonResult<T> {
  data: T;
  usage: TokenUsage;
}

interface ResponsesPayload {
  model: string;
  input: Array<{
    role: 'system' | 'user';
    content: Array<{ type: 'input_text'; text: string }>;
  }>;
  text: {
    format: {
      type: 'json_schema';
      name: string;
      strict: true;
      schema: Record<string, unknown>;
    };
  };
}

export async function runOpenAIStructuredOutput<T>(params: {
  apiKey: string;
  model: string;
  schemaName: string;
  schema: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
}): Promise<OpenAIJsonResult<T>> {
  const payload: ResponsesPayload = {
    model: params.model,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: params.systemPrompt }]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: params.userPrompt }]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: params.schemaName,
        strict: true,
        schema: params.schema
      }
    }
  };

  const response = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI responses request failed (${response.status}): ${text}`);
  }

  const raw = (await response.json()) as Record<string, unknown>;

  const outputText = extractOutputText(raw);
  if (!outputText) {
    throw new Error('OpenAI response contained no output text');
  }

  let parsed: T;
  try {
    parsed = JSON.parse(outputText) as T;
  } catch (error) {
    throw new Error(`OpenAI output was not valid JSON: ${outputText.slice(0, 800)}`);
  }

  const usage = (raw.usage ?? {}) as Record<string, unknown>;

  return {
    data: parsed,
    usage: {
      inputTokens: asNumber(usage.input_tokens),
      outputTokens: asNumber(usage.output_tokens),
      totalTokens: asNumber(usage.total_tokens)
    }
  };
}

function extractOutputText(raw: Record<string, unknown>): string | null {
  if (typeof raw.output_text === 'string' && raw.output_text.trim()) {
    return raw.output_text;
  }

  const output = raw.output;
  if (!Array.isArray(output)) {
    return null;
  }

  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }

      const partRecord = part as Record<string, unknown>;
      if (typeof partRecord.text === 'string' && partRecord.text.trim()) {
        return partRecord.text;
      }
    }
  }

  return null;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return 0;
}
