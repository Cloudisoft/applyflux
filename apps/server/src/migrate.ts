/**
 * Applies supabase/migrations/*.sql in order, recording each in
 * public.applyflux_migrations. Equivalent to `supabase db push` for
 * environments without the Supabase CLI (e.g. Replit).
 *   DATABASE_URL=... pnpm db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export async function migrate(databaseUrl: string, dir: string, opts: { ssl?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const client = new pg.Client({ connectionString: databaseUrl, ssl: opts.ssl ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    await client.query('create table if not exists public.applyflux_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query('select name from public.applyflux_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      log(`applying ${file}`);
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('insert into public.applyflux_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations');
  migrate(url, dir, { ssl: process.env.DATABASE_SSL === 'true' })
    .then(() => console.log('migrations up to date'))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
