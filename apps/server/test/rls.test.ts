import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { APPLICATION_STATES, TRANSITIONS } from '@applyflux/shared';
import { createUser, makeEnv, type TestEnv } from './helpers';

let env: TestEnv;
let a: Awaited<ReturnType<typeof createUser>>;
let b: Awaited<ReturnType<typeof createUser>>;

/** Run SQL as a Supabase end user (role authenticated + JWT claims), exactly as PostgREST/Realtime would. */
async function asUser(userId: string | null, sql: string, params: unknown[] = []) {
  const c = await env.ctx.db.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${userId ? 'authenticated' : 'anon'}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(userId ? { sub: userId, role: 'authenticated' } : { role: 'anon' })]);
    const r = await c.query(sql, params);
    await c.query('rollback');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  env = await makeEnv('applyflux_it_rls');
  a = await createUser(env, 'a@example.com');
  b = await createUser(env, 'b@example.com');
  const job = await env.ctx.db.query(
    `insert into jobs (user_id, origin, url, url_key, fingerprint, company, title) values ($1,'import','https://x.test/1','https://x.test/1','x','X','Y') returning id`,
    [a.id],
  );
  await env.ctx.db.query(`insert into applications (user_id, job_id, idempotency_key) values ($1,$2,'k1')`, [a.id, job.rows[0].id]);
  await env.ctx.db.query(`insert into extension_connections (user_id, token_hash, expires_at) values ($1, 'secret-hash', now() + interval '1 day')`, [a.id]);
});
afterAll(() => env.close());

describe('new-user bootstrap trigger', () => {
  it('creates profile and preferences', async () => {
    const r = await env.ctx.db.query(
      `select (select count(*) from profiles where user_id=$1) p, (select count(*) from automation_preferences where user_id=$1) ap`,
      [a.id],
    );
    expect(r.rows[0]).toMatchObject({ p: '1', ap: '1' });
  });
});

describe('row level security', () => {
  it('users see only their own rows', async () => {
    expect((await asUser(a.id, 'select * from applications')).rowCount).toBe(1);
    expect((await asUser(b.id, 'select * from applications')).rowCount).toBe(0);
    expect((await asUser(b.id, 'select * from jobs')).rowCount).toBe(0);
    expect((await asUser(b.id, 'select * from candidate_profiles')).rows.map((r) => r.user_id)).toEqual([b.id]);
  });
  it('anonymous users can read nothing personal', async () => {
    await expect(asUser(null, 'select * from candidate_profiles')).resolves.toMatchObject({ rowCount: 0 });
  });
  it('users cannot write applications, usage or consent directly', async () => {
    const job = await env.ctx.db.query('select id from jobs where user_id=$1', [a.id]);
    await expect(asUser(a.id, `insert into applications (user_id, job_id, idempotency_key) values ($1,$2,'k2')`, [a.id, job.rows[0].id])).rejects.toThrow(/row-level security/);
    await expect(asUser(a.id, `insert into usage_ledger (user_id, kind, ref) values ($1,'application','x')`, [a.id])).rejects.toThrow(/row-level security/);
    const upd = await asUser(a.id, `update automation_preferences set auto_submit_consent_at = now() where user_id=$1`, [a.id]);
    expect(upd.rowCount).toBe(0);
    const st = await asUser(a.id, `update applications set state='SUBMITTED' where user_id=$1`, [a.id]);
    expect(st.rowCount).toBe(0);
  });
  it('users cannot write into another user\'s profile', async () => {
    const r = await asUser(b.id, `update candidate_profiles set first_name='Mallory' where user_id=$1`, [a.id]);
    expect(r.rowCount).toBe(0);
    await expect(asUser(b.id, `insert into work_experiences (user_id, company, title) values ($1,'Evil','Corp')`, [a.id])).rejects.toThrow(/row-level security/);
  });
  it('extension token hashes are never readable', async () => {
    await expect(asUser(a.id, 'select token_hash from extension_connections')).rejects.toThrow(/permission denied/);
    expect((await asUser(a.id, 'select id, name from extension_connections')).rowCount).toBe(1);
    await expect(asUser(a.id, 'select * from extension_pairing_codes')).resolves.toMatchObject({ rowCount: 0 });
  });
  it('storage objects are confined to the owner folder', async () => {
    await env.ctx.db.query(`insert into storage.objects (bucket_id, name) values ('documents', $1), ('documents', $2)`, [`${a.id}/d1/cv.pdf`, `${b.id}/d2/cv.pdf`]);
    const r = await asUser(a.id, `select name from storage.objects where bucket_id='documents'`);
    expect(r.rows.map((x) => x.name)).toEqual([`${a.id}/d1/cv.pdf`]);
  });
});

describe('database state machine', () => {
  it('matches the TypeScript transition table exactly', async () => {
    for (const from of APPLICATION_STATES) {
      for (const to of APPLICATION_STATES) {
        if (from === to) continue;
        const r = await env.ctx.db.query('select public.application_transition_allowed($1, $2) as ok', [from, to]);
        expect([from, to, r.rows[0].ok]).toEqual([from, to, TRANSITIONS[from].includes(to)]);
      }
    }
  });
  it('rejects illegal transitions at the database level', async () => {
    await expect(env.ctx.db.query(`update applications set state='INTERVIEW' where user_id=$1`, [a.id])).rejects.toThrow(/invalid application state transition/);
  });
  it('refuses to mark SUBMITTED without evidence', async () => {
    const c = new pg.Client({ connectionString: (env.ctx.config.DATABASE_URL) });
    await c.connect();
    await c.query(`update applications set state='QUEUED' where user_id=$1`, [a.id]);
    await c.query(`update applications set state='IN_PROGRESS' where user_id=$1`, [a.id]);
    await expect(c.query(`update applications set state='SUBMITTED' where user_id=$1`, [a.id])).rejects.toThrow(/submitted_requires_evidence/);
    await c.query(`update applications set submit_attempted_at = now() where user_id=$1`, [a.id]);
    await expect(c.query(`update applications set state='QUEUED' where user_id=$1`, [a.id])).rejects.toThrow(/refusing to re-queue/);
    await c.end();
  });
});
