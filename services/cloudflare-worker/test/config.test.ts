import { describe, expect, it } from 'vitest';

import { applyConfigOverrides, readConfig } from '../src/config.js';

describe('readConfig', () => {
  it('parses allowlist and numeric values safely', () => {
    const config = readConfig({
      MAX_REPOS: '7',
      TOP_PATCH_COUNT: '2',
      ALLOWED_REPOS: 'acme/api, acme/web',
      OPENAI_MODEL: 'gpt-5.3-codex',
      AUTO_ONBOARD_WEBHOOKS: 'true'
    } as never);

    expect(config.maxRepos).toBe(7);
    expect(config.topPatchCount).toBe(2);
    expect(config.allowlist.has('acme/api')).toBe(true);
    expect(config.autoOnboardWebhooks).toBe(true);
  });

  it('applies dashboard overrides on top of env defaults', () => {
    const base = readConfig({
      MAX_REPOS: '5',
      TOP_PATCH_COUNT: '3',
      OPENAI_MODEL: 'gpt-5.3-codex',
      ALLOWED_REPOS: ''
    } as never);

    const merged = applyConfigOverrides(base, {
      topPatchCount: 1,
      model: 'gpt-5.3-mini',
      allowlist: new Set(['acme/api']),
      autoOnboardWebhooks: false
    });

    expect(merged.topPatchCount).toBe(1);
    expect(merged.model).toBe('gpt-5.3-mini');
    expect(merged.allowlist.has('acme/api')).toBe(true);
    expect(merged.autoOnboardWebhooks).toBe(false);
  });
});
