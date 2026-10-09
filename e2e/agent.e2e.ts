import { fileURLToPath as __f } from 'node:url';
import { dirname as __d } from 'node:path';
const __here = __d(__f(import.meta.url));
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { SignJWT } from 'jose';
import pg from 'pg';
import { AUTO_SUBMIT_CONSENT_VERSION } from '../packages/shared/src';
import { renderPdf } from '../apps/server/src/services/documents';
import { E2E } from './global-setup';

const EXT = resolve(__here, '../apps/extension/dist');
let context: BrowserContext;
let extId: string;
let db: pg.Pool;

type Api = ReturnType<typeof apiFor>;
function apiFor(token: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${E2E.api}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(json)}`);
    return json.data;
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b ?? {}), put: (p: string, b: unknown) => call('PUT', p, b), patch: (p: string, b: unknown) => call('PATCH', p, b), token };
}

async function newUser(email: string): Promise<Api> {
  const r = await db.query('insert into auth.users (email) values ($1) returning id', [email]);
  const token = await new SignJWT({ role: 'authenticated', email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(r.rows[0].id)
    .setAudience('authenticated')
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(E2E.jwtSecret));
  const api = apiFor(token);
  await api.get('/me');
  // Verified profile (the person confirmed these facts in the UI).
  await api.patch('/profile', {
    firstName: 'Ada', lastName: 'Lovelace', phone: '+44 20 7946 0000', city: 'London', country: 'United Kingdom',
    linkedinUrl: 'https://www.linkedin.com/in/ada-example', desiredTitles: ['Senior Frontend Engineer'],
    skills: ['TypeScript', 'React', 'Node.js'], noticePeriod: '4 weeks', yearsExperience: 7, experienceLevel: 'senior',
    workAuthorizations: [{ country: 'United Kingdom', authorized: true, requiresSponsorship: false }],
  });
  await api.post('/profile/experiences', { company: 'Analytical Engines', title: 'Senior Engineer', startDate: '2020-03', isCurrent: true });
  await api.post('/profile/experiences', { company: 'Difference Ltd', title: 'Engineer', startDate: '2016-06', endDate: '2020-02' });
  await api.post('/profile/educations', { institution: 'University of London', degree: 'BSc Mathematics', startDate: '2012', endDate: '2016' });
  // Answers the person approved once and ApplyFlux reuses.
  await api.post('/answers', { question: 'Why do you want to work at Northwind Labs?', answer: 'I enjoy building dependable tools for small businesses, which is exactly what Northwind does.' });
  await api.post('/answers', { question: 'I consent to Northwind Labs processing my data for recruitment purposes.', answer: 'Yes' });
  // Resume upload through the real endpoint.
  const pdf = await renderPdf('Ada Lovelace', 'ada@example.com', [{ heading: 'Experience', text: 'Senior Engineer at Analytical Engines' }]);
  const fd = new FormData();
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'Ada_Lovelace_CV.pdf');
  const up = await fetch(`${E2E.api}/api/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  expect(up.status).toBe(201);
  return api;
}

async function pairViaPopup(api: Api) {
  const { code } = await api.post('/extension/pairing-code');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  if (await popup.locator('#main').isVisible()) {
    await popup.click('#disconnect');
    await expect(popup.locator('#code')).toBeVisible();
  }
  await popup.fill('#code', code);
  await popup.click('#pair-form button');
  await expect(popup.locator('#badge')).toHaveText('Connected');
  await popup.close();
}

async function waitForState(api: Api, id: string, states: string[], timeout = 60_000) {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    const a = await api.get(`/applications/${id}`);
    last = a.state;
    if (states.includes(a.state)) return a;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${states.join('|')} (last: ${last})`);
}

async function sandboxPage(ref: string): Promise<Page> {
  for (let i = 0; i < 40; i++) {
    const p = context.pages().find((pg) => pg.url().includes(`ref=${ref}`));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('application tab not opened');
}

async function submissions(scenario: string, ref: string) {
  const r = await fetch(`${E2E.api}/sandbox/_stats?key=${scenario}:${ref}`);
  return (await r.json()).submissions as number;
}

async function queue(api: Api, scenario: string) {
  const job = await api.post('/sandbox/jobs', { scenario });
  const [q] = await api.post('/applications/enqueue', { jobIds: [job.jobId] });
  expect(q.status).toBe('queued');
  return { ...job, applicationId: q.applicationId as string };
}

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: readFileSync(resolve(__here, '.db-url'), 'utf8') });
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'af-e2e-')), {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
});
test.afterAll(async () => {
  await context?.close();
  await db?.end();
});

test('Auto Mode: fills, attaches resume, submits once, verifies confirmation', async () => {
  const api = await newUser('auto@example.com');
  await pairViaPopup(api);
  await api.put('/automation/preferences', { mode: 'auto', dailyLimit: 10, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
  await api.post('/automation/consent', { version: AUTO_SUBMIT_CONSENT_VERSION, accepted: true });
  const job = await queue(api, 'standard');
  await api.post('/automation/start');

  const done = await waitForState(api, job.applicationId, ['SUBMITTED', 'SUBMISSION_UNVERIFIED', 'NEEDS_ATTENTION', 'AWAITING_REVIEW', 'FAILED']);
  expect(done.state, JSON.stringify(done.intervention ?? done.lastError)).toBe('SUBMITTED');
  expect(done.submissionEvidence.matchedSignals.length).toBeGreaterThan(0);
  expect(await submissions('standard', job.ref)).toBe(1);
  const types = done.events.map((e: { type: string }) => e.type);
  expect(types).toEqual(expect.arrayContaining(['claimed', 'submit_attempted', 'submitted']));
  const usage = await api.get('/usage');
  expect(usage.applications.usedToday).toBe(1);
  await api.post('/automation/stop');
});

test('CAPTCHA before the form: pauses for the person, resumes on evidence, submits once', async () => {
  const api = await newUser('captcha1@example.com');
  await pairViaPopup(api);
  await api.put('/automation/preferences', { mode: 'auto', dailyLimit: 10, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
  await api.post('/automation/consent', { version: AUTO_SUBMIT_CONSENT_VERSION, accepted: true });
  const job = await queue(api, 'captcha-before');
  await api.post('/automation/start');

  const paused = await waitForState(api, job.applicationId, ['AWAITING_HUMAN_VERIFICATION']);
  expect(paused.intervention.type).toBe('captcha');
  // Nothing was typed while the challenge was up.
  const page = await sandboxPage(job.ref);
  expect(await page.inputValue('#first_name').catch(() => '')).toBe('');
  // Still paused a few seconds later: no retry loop, no bypass.
  await new Promise((r) => setTimeout(r, 3000));
  expect((await api.get(`/applications/${job.applicationId}`)).state).toBe('AWAITING_HUMAN_VERIFICATION');

  // The person completes the verification.
  await page.check('#af-captcha-check');
  await page.click('#af-captcha-verify');

  const done = await waitForState(api, job.applicationId, ['SUBMITTED', 'SUBMISSION_UNVERIFIED', 'NEEDS_ATTENTION', 'FAILED']);
  expect(done.state, JSON.stringify(done.intervention ?? done.lastError)).toBe('SUBMITTED');
  expect(done.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['verification_required', 'verification_resolved', 'submitted']));
  expect(await submissions('captcha-before', job.ref)).toBe(1);
  await api.post('/automation/stop');
});

test('CAPTCHA at submit: no duplicate submission after verification', async () => {
  const api = await newUser('captcha2@example.com');
  await pairViaPopup(api);
  await api.put('/automation/preferences', { mode: 'auto', dailyLimit: 10, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
  await api.post('/automation/consent', { version: AUTO_SUBMIT_CONSENT_VERSION, accepted: true });
  const job = await queue(api, 'captcha-submit');
  await api.post('/automation/start');
  await waitForState(api, job.applicationId, ['AWAITING_HUMAN_VERIFICATION']);
  const page = await sandboxPage(job.ref);
  expect(await submissions('captcha-submit', job.ref)).toBe(0);
  await page.click('#af-captcha-verify');
  const done = await waitForState(api, job.applicationId, ['SUBMITTED', 'SUBMISSION_UNVERIFIED', 'NEEDS_ATTENTION', 'FAILED']);
  expect(done.state, JSON.stringify(done.intervention ?? done.lastError)).toBe('SUBMITTED');
  expect(await submissions('captcha-submit', job.ref)).toBe(1);
  await api.post('/automation/stop');
});

test('Review Mode on a multi-step form: fills every step, waits, submits after approval', async () => {
  const api = await newUser('review@example.com');
  await pairViaPopup(api);
  await api.put('/automation/preferences', { mode: 'review', dailyLimit: 10, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
  const job = await queue(api, 'multistep');
  await api.post('/automation/start');
  const review = await waitForState(api, job.applicationId, ['AWAITING_REVIEW', 'NEEDS_ATTENTION', 'FAILED']);
  expect(review.state, JSON.stringify(review.intervention)).toBe('AWAITING_REVIEW');
  const page = await sandboxPage(job.ref);
  // Values from earlier steps are preserved in the form.
  expect(await page.inputValue('#exp1_company')).toBe('Analytical Engines');
  expect(await page.inputValue('#exp1_from')).toBe('03/2020');
  expect(await page.isChecked('#exp1_current')).toBe(true);
  expect(await page.inputValue('#exp2_company')).toBe('Difference Ltd');
  expect(await page.isChecked('input[name=authorized][value=yes]')).toBe(true);
  expect(await page.isChecked('input[name=sponsorship][value=no]')).toBe(true);
  expect(await submissions('multistep', job.ref)).toBe(0);

  await api.post(`/applications/${job.applicationId}/actions`, { action: 'approve_submit' });
  const done = await waitForState(api, job.applicationId, ['SUBMITTED', 'SUBMISSION_UNVERIFIED', 'NEEDS_ATTENTION', 'FAILED']);
  expect(done.state, JSON.stringify(done.intervention ?? done.lastError)).toBe('SUBMITTED');
  expect(await submissions('multistep', job.ref)).toBe(1);
  await api.post('/automation/stop');
});

test('Outcomes are reported honestly: unverified, rejected by validation, sign-in walls', async () => {
  const api = await newUser('outcomes@example.com');
  await pairViaPopup(api);
  await api.put('/automation/preferences', { mode: 'auto', dailyLimit: 10, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
  await api.post('/automation/consent', { version: AUTO_SUBMIT_CONSENT_VERSION, accepted: true });
  const noConf = await queue(api, 'no-confirmation');
  const invalid = await queue(api, 'validation-error');
  const login = await queue(api, 'login');
  await api.post('/automation/start');

  const a = await waitForState(api, noConf.applicationId, ['SUBMITTED', 'SUBMISSION_UNVERIFIED', 'NEEDS_ATTENTION', 'FAILED']);
  expect(a.state).toBe('SUBMISSION_UNVERIFIED');
  const b = await waitForState(api, invalid.applicationId, ['SUBMITTED', 'SUBMISSION_UNVERIFIED', 'NEEDS_ATTENTION', 'FAILED']);
  expect(b.state).toBe('NEEDS_ATTENTION');
  expect(b.intervention.type).toBe('validation_errors');
  // A submit was attempted: retry is refused to prevent a duplicate application.
  await expect(api.post(`/applications/${invalid.applicationId}/actions`, { action: 'retry' })).rejects.toThrow(/409/);
  const c = await waitForState(api, login.applicationId, ['NEEDS_ATTENTION', 'FAILED', 'SUBMITTED']);
  expect(c.intervention.type).toBe('login_required');
  await api.post('/automation/stop');
});
