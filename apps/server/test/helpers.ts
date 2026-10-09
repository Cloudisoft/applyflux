import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SignJWT } from 'jose';
import request from 'supertest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createAiClient } from '../src/ai/provider';
import { createJwtVerifier } from '../src/lib/auth';
import { MemoryStorage } from '../src/lib/storage';
import { migrate } from '../src/migrate';
import type { AppContext } from '../src/context';
import type { FetchJson } from '../src/services/discovery';

const here = dirname(fileURLToPath(import.meta.url));
export const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long!!';
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://applyflux:applyflux@localhost:5432/postgres';

export async function freshDatabase(name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query(readFileSync(resolve(here, '../../../supabase/tests/supabase_shim.sql'), 'utf8'));
  await c.end();
  await migrate(url, resolve(here, '../../../supabase/migrations'), { log: () => {} });
  return url;
}

export interface TestEnv {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  storage: MemoryStorage;
  aiCalls: Array<{ messages: Array<{ role: string; content: string }> }>;
  setAiResponder: (fn: (messages: Array<{ role: string; content: string }>) => string) => void;
  setBoards: (b: Record<string, { status: number; json: unknown }>) => void;
  close: () => Promise<void>;
}

export async function makeEnv(dbName: string, opts: { ai?: boolean } = {}): Promise<TestEnv> {
  const url = await freshDatabase(dbName);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    SUPABASE_JWT_SECRET: JWT_SECRET,
    STORAGE_DRIVER: 'memory',
    DOWNLOAD_SIGNING_SECRET: 'download-signing-secret-for-tests-0123456789',
    PUBLIC_API_URL: 'http://127.0.0.1:3999',
    AI_PROVIDER: opts.ai ? 'openai' : 'none',
    OPENAI_API_KEY: opts.ai ? 'sk-test' : undefined,
    AUTO_SUBMIT_PLATFORMS: 'sandbox',
  } as NodeJS.ProcessEnv);
  const db = new pg.Pool({ connectionString: url, max: 12 });
  const storage = new MemoryStorage();
  const aiCalls: TestEnv['aiCalls'] = [];
  let responder: (m: Array<{ role: string; content: string }>) => string = () => '{}';
  // Test double for the OpenAI HTTP API (tests only; production uses the real endpoint).
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    aiCalls.push({ messages: body.messages });
    return new Response(JSON.stringify({ choices: [{ message: { content: responder(body.messages) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  let boards: Record<string, { status: number; json: unknown }> = {};
  const fetchJson: FetchJson = async (u) => boards[u] ?? { status: 404, json: null };
  const ctx: AppContext = {
    config,
    db,
    storage,
    ai: createAiClient(config, fakeFetch),
    verifyJwt: createJwtVerifier(config),
    fetchJson,
    supabaseAdmin: null,
  };
  return {
    ctx,
    app: createApp(ctx),
    storage,
    aiCalls,
    setAiResponder: (fn) => (responder = fn),
    setBoards: (b) => (boards = b),
    close: () => db.end(),
  };
}

export async function createUser(env: TestEnv, email: string) {
  const r = await env.ctx.db.query('insert into auth.users (email) values ($1) returning id', [email]);
  const id = r.rows[0].id as string;
  const token = await new SignJWT({ role: 'authenticated', email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(id)
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
  const auth = { Authorization: `Bearer ${token}` };
  return {
    id,
    token,
    get: (p: string) => request(env.app).get(p).set(auth),
    post: (p: string, body?: object) => request(env.app).post(p).set(auth).send(body ?? {}),
    patch: (p: string, body?: object) => request(env.app).patch(p).set(auth).send(body ?? {}),
    put: (p: string, body?: object) => request(env.app).put(p).set(auth).send(body ?? {}),
    del: (p: string, body?: object) => request(env.app).delete(p).set(auth).send(body ?? {}),
  };
}

export async function pairExtension(env: TestEnv, user: Awaited<ReturnType<typeof createUser>>) {
  const code = (await user.post('/api/extension/pairing-code')).body.data.code;
  const r = await request(env.app).post('/api/ext/pair').send({ code, name: 'Test Chrome', version: '0.1.0' });
  if (r.status !== 201) throw new Error(`pair failed ${r.status} ${JSON.stringify(r.body)}`);
  const h = { Authorization: `Ext ${r.body.data.token}`, Origin: 'chrome-extension://testextensionid' };
  return {
    token: r.body.data.token as string,
    connectionId: r.body.data.connectionId as string,
    get: (p: string) => request(env.app).get(p).set(h),
    post: (p: string, body?: object) => request(env.app).post(p).set(h).send(body ?? {}),
  };
}

/** A verified, automation-ready profile. */
export async function completeProfile(user: Awaited<ReturnType<typeof createUser>>) {
  await user.patch('/api/profile', {
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '+44 20 7946 0000',
    city: 'London',
    country: 'United Kingdom',
    desiredTitles: ['Senior Frontend Engineer'],
    skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL'],
    workAuthorizations: [{ country: 'United Kingdom', authorized: true, requiresSponsorship: false }],
    workplaceTypes: ['remote'],
    yearsExperience: 7,
    experienceLevel: 'senior',
  });
  await user.post('/api/profile/experiences', { company: 'Analytical Engines', title: 'Senior Engineer', startDate: '2019-01', isCurrent: true });
}
