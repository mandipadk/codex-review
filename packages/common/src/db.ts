import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';

export function createPgPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export async function runMigrations(pool: Pool, migrationsDir: string): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      id serial primary key,
      filename text not null unique,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const check = await pool.query<{ exists: boolean }>(
      'select exists(select 1 from schema_migrations where filename = $1) as exists',
      [file]
    );

    if (check.rows[0]?.exists) {
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();

    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations(filename) values ($1)', [file]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
