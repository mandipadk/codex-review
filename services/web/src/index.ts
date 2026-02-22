import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPgPool, parseEnv, runMigrations, RunStore } from '@pr-guardian/common';

import { buildServer, repoAllowlistFromEnv } from './server.js';
import { BullRunScheduler } from './scheduler.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const env = parseEnv();
  const pool = createPgPool(env.DATABASE_URL);

  if (env.AUTO_MIGRATE) {
    const migrationsDir = path.resolve(dirname, '../../../db/migrations');
    await runMigrations(pool, migrationsDir);
  }

  const store = new RunStore(pool);
  const scheduler = new BullRunScheduler(env.REDIS_URL);

  const app = buildServer({
    store,
    scheduler,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    repoAllowlist: repoAllowlistFromEnv(env.REPO_ALLOWLIST),
    maxRepos: env.MAX_REPOS
  });

  const close = async () => {
    await app.close();
    await scheduler.close();
    await store.close();
  };

  process.on('SIGINT', async () => {
    await close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await close();
    process.exit(0);
  });

  await app.listen({ port: env.WEB_PORT, host: '0.0.0.0' });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
