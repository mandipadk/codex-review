import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WEB_PORT: z.coerce.number().default(3000),
  WORKER_CONCURRENCY: z.coerce.number().default(2),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  REPO_ALLOWLIST: z.string().optional(),
  MAX_REPOS: z.coerce.number().int().positive().max(20).default(5),
  CODEX_BIN: z.string().default('codex'),
  AUTO_MIGRATE: z
    .preprocess((value) => value === '1' || value === 'true' || value === true, z.boolean())
    .default(false),
  RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000)
});

export type AppEnv = z.output<typeof envSchema>;

export function parseEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(input);
}

export function parsePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, '\n');
}

export function parseRepoAllowlist(value?: string): Set<string> {
  if (!value) {
    return new Set<string>();
  }

  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}
