import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPgPool,
  GitHubAppClientFactory,
  parseEnv,
  parsePrivateKey,
  runMigrations,
  RunStore
} from '@pr-guardian/common';

import { GitHubServiceImpl } from './github.js';
import { RunOrchestrator } from './orchestrator.js';
import { startRunWorker } from './worker.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const env = parseEnv();

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required for worker startup');
  }

  const pool = createPgPool(env.DATABASE_URL);

  if (env.AUTO_MIGRATE) {
    const migrationsDir = path.resolve(dirname, '../../../db/migrations');
    await runMigrations(pool, migrationsDir);
  }

  const store = new RunStore(pool);
  const githubFactory = new GitHubAppClientFactory({
    appId: env.GITHUB_APP_ID,
    privateKey: parsePrivateKey(env.GITHUB_APP_PRIVATE_KEY)
  });

  const orchestrator = new RunOrchestrator({
    store,
    github: new GitHubServiceImpl(githubFactory),
    codexBin: env.CODEX_BIN,
    runTimeoutMs: env.RUN_TIMEOUT_MS
  });

  const runtime = startRunWorker({
    redisUrl: env.REDIS_URL,
    concurrency: env.WORKER_CONCURRENCY,
    orchestrator
  });

  const shutdown = async () => {
    await runtime.worker.close();
    await store.close();
  };

  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
