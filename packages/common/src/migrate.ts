import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPgPool, runMigrations } from './db.js';
import { parseEnv } from './env.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(dirname, '../../../db/migrations');

async function main() {
  const env = parseEnv();
  const pool = createPgPool(env.DATABASE_URL);

  try {
    await runMigrations(pool, migrationsDir);
    console.log(`Applied migrations from ${migrationsDir}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
