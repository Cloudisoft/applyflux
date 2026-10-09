import pg from 'pg';
import type { Config } from './config';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Fail fast instead of hanging when the database or its pooler is unreachable or saturated.
    // Client-side query timeout: works through Supabase's pooler, which may drop startup parameters.
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  pool.on('error', (e) => console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', message: e.message })));
  return pool;
}

export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function one<T = Record<string, unknown>>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await q.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = Record<string, unknown>>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await q.query(sql, params);
  return r.rows as T[];
}

/** snake_case row → camelCase object (shallow). */
export function camel<T = Record<string, unknown>>(row: Record<string, unknown> | null): T {
  if (!row) return row as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v instanceof Date ? v.toISOString() : v;
  return out as T;
}
