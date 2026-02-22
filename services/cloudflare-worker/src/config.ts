import { AppConfig, AppConfigOverrides, Env } from './types.js';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return fallback;
}

function parseAllowlist(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function readConfig(env: Env): AppConfig {
  return {
    maxRepos: parsePositiveInt(env.MAX_REPOS, 5),
    topPatchCount: parsePositiveInt(env.TOP_PATCH_COUNT, 3),
    model: env.OPENAI_MODEL ?? 'gpt-5.3-codex',
    allowlist: parseAllowlist(env.ALLOWED_REPOS),
    autoOnboardWebhooks: parseBoolean(env.AUTO_ONBOARD_WEBHOOKS, false)
  };
}

export function applyConfigOverrides(base: AppConfig, overrides: AppConfigOverrides): AppConfig {
  return {
    ...base,
    topPatchCount:
      typeof overrides.topPatchCount === 'number' && Number.isInteger(overrides.topPatchCount) && overrides.topPatchCount > 0
        ? overrides.topPatchCount
        : base.topPatchCount,
    model: typeof overrides.model === 'string' && overrides.model.trim() ? overrides.model.trim() : base.model,
    allowlist: overrides.allowlist ?? base.allowlist,
    autoOnboardWebhooks:
      typeof overrides.autoOnboardWebhooks === 'boolean' ? overrides.autoOnboardWebhooks : base.autoOnboardWebhooks
  };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}
