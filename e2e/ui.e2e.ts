import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { SignJWT } from 'jose';
import pg from 'pg';
import { E2E } from './global-setup';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SCREENSHOT_DIR ?? resolve(here, 'screenshots');
let browser: Browser;
let db: pg.Pool;
let session: Record<string, unknown>;

async function call(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${E2E.api}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(j)}`);
  return j.data;
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  db = new pg.Pool({ connectionString: readFileSync(resolve(here, '.db-url'), 'utf8') });
  const email = `designer+${Date.now()}@example.com`;
  const u = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, '{"full_name":"Maya Chen"}') returning id, created_at`, [email]);
  const id = u.rows[0].id as string;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = await new SignJWT({ role: 'authenticated', email }).setProtectedHeader({ alg: 'HS256' }).setSubject(id).setAudience('authenticated').setExpirationTime(exp).sign(new TextEncoder().encode(E2E.jwtSecret));
  session = { access_token: token, refresh_token: 'e2e-refresh', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id, email, aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: { full_name: 'Maya Chen' } } };

  // Realistic, user-entered data (this is the test user's own profile, not marketing content).
  await call(token, 'GET', '/me');
  await call(token, 'PATCH', '/profile', {
    firstName: 'Maya', lastName: 'Chen', phone: '+1 415 555 0142', city: 'San Francisco', region: 'CA', country: 'United States',
    headline: 'Senior Product Designer · B2B SaaS', summary: 'Product designer focused on complex workflows and design systems.',
    skills: ['Figma', 'Design systems', 'User research', 'Prototyping', 'React'], yearsExperience: 8, experienceLevel: 'senior',
    desiredTitles: ['Senior Product Designer', 'Lead Product Designer'], workplaceTypes: ['remote', 'hybrid'], desiredSalaryMin: 160000, salaryCurrency: 'USD',
    workAuthorizations: [{ country: 'United States', authorized: true, requiresSponsorship: false }],
  });
  await call(token, 'POST', '/profile/experiences', { company: 'Northbeam', title: 'Senior Product Designer', startDate: '2021-04', isCurrent: true, achievements: ['Led redesign of the analytics workspace', 'Built the company design system'] });
  await call(token, 'POST', '/profile/experiences', { company: 'Loomly', title: 'Product Designer', startDate: '2017-02', endDate: '2021-03' });
  await call(token, 'POST', '/profile/educations', { institution: 'UC Berkeley', degree: 'BA', fieldOfStudy: 'Cognitive Science', startDate: '2012', endDate: '2016' });
  for (const scenario of ['standard', 'multistep', 'captcha-before', 'no-confirmation']) {
    const j = await call(token, 'POST', '/sandbox/jobs', { scenario });
    await call(token, 'POST', '/applications/enqueue', { jobIds: [j.jobId] });
  }
  await call(token, 'POST', '/jobs/import', { url: 'https://example.com/careers/lead-designer', title: 'Lead Product Designer', company: 'Example Co', location: 'Remote (US)', description: 'We need Figma, design systems and user research. Remote. No visa sponsorship available.' });
  await call(token, 'POST', '/answers', { question: 'How did you hear about us?', answer: 'Company website' });
  await db.query(`update applications set state='IN_PROGRESS', progress=55, current_step='Filled step 2', lease_expires_at=now()+interval '1 hour' where id=(select id from applications where user_id=$1 order by created_at limit 1)`, [id]);
  await db.query(`update applications set state='IN_PROGRESS' where id=(select id from applications where user_id=$1 and state='QUEUED' order by created_at limit 1)`, [id]);
  await db.query(
    `update applications set state='AWAITING_HUMAN_VERIFICATION', intervention=$2 where id=(select id from applications where user_id=$1 and state='IN_PROGRESS' order by created_at desc limit 1)`,
    [id, JSON.stringify({ type: 'captcha', title: 'Human verification required', message: 'A verification challenge appeared. Please complete it in this tab.', action: 'Open the tab and complete the verification yourself. ApplyFlux resumes once the page confirms it.', since: new Date().toISOString() })],
  );
  await db.query(`insert into notifications (user_id, type, title, body, severity) values ($1,'verification','Human verification required','Data Analyst (Sandbox): please complete the verification in the application tab.','warning')`, [id]);

  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
test.afterAll(async () => {
  await browser?.close();
  await db?.end();
});

async function newPage(opts: { auth?: boolean; dark?: boolean; mobile?: boolean } = {}) {
  const ctx = await browser.newContext({ viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 }, colorScheme: opts.dark ? 'dark' : 'light' });
  if (opts.auth) await ctx.addInitScript((s) => localStorage.setItem('sb-127-auth-token', JSON.stringify(s)), session);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/127\.0\.0\.1:54321|Content Security Policy|WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return { page, errors };
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

test('public site renders with real platform data', async () => {
  const { page, errors } = await newPage();
  await page.goto(`${E2E.api}/`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('One profile. Every opportunity.');
  await expect(page.getByText('Greenhouse').first()).toBeVisible();
  await shot(page, '01-landing');
  await page.goto(`${E2E.api}/platforms`);
  await expect(page.getByText("LinkedIn's User Agreement prohibits automated access", { exact: false })).toBeVisible();
  await shot(page, '02-platforms');
  await page.goto(`${E2E.api}/signin`);
  await shot(page, '03-signin');
  expect(errors).toEqual([]);
});

test('authenticated app screens render from the API', async () => {
  const { page, errors } = await newPage({ auth: true });
  const visit = async (path: string, name: string, expectText: string | RegExp) => {
    await page.goto(`${E2E.api}${path}`);
    await expect(page.getByText(expectText).first()).toBeVisible({ timeout: 15_000 });
    await shot(page, name);
  };
  await visit('/app', '10-dashboard', 'Welcome back, Maya');
  await expect(page.getByText('Human verification required').first()).toBeVisible();
  await visit('/app/automation', '11-control-center', 'Control Center');
  await visit('/app/applications', '12-applications', 'Application history');
  await page.getByText('Senior Frontend Engineer (Sandbox)').first().click();
  await expect(page.getByText('Timeline')).toBeVisible();
  await shot(page, '13-application-drawer');
  await visit('/app/jobs', '14-jobs', 'Lead Product Designer');
  await page.getByText('Lead Product Designer').first().click();
  await expect(page.getByText('Why this score')).toBeVisible();
  await expect(page.getByText('Matching skills')).toBeVisible();
  await shot(page, '15-job-detail');
  await visit('/app/match', '16-smart-match', 'Your best matches');
  await visit('/app/profile', '17-profile', 'Candidate profile');
  await visit('/app/resumes', '18-resumes', 'Resume library');
  await visit('/app/studio', '19-studio', 'Resume Studio');
  await visit('/app/cover-letters', '20-cover-letters', 'Cover Letter Studio');
  await visit('/app/answers', '21-answers', 'Saved answers');
  await visit('/app/extension', '22-extension', 'Connect the ApplyFlux Agent');
  await visit('/app/settings/automation', '23-automation-settings', 'Execution mode');
  await visit('/app/notifications', '25-notifications', 'Human verification required');
  await visit('/app/settings/account', '26-account', 'Export my data');
  await visit('/app/setup', '27-setup', 'Setup · step');
  expect(errors).toEqual([]);
});

test('dark mode and mobile layouts', async () => {
  const dark = await newPage({ auth: true, dark: true });
  await dark.page.goto(`${E2E.api}/app`);
  await expect(dark.page.getByText('Welcome back, Maya')).toBeVisible();
  await shot(dark.page, '30-dashboard-dark');
  await dark.page.goto(`${E2E.api}/`);
  await shot(dark.page, '31-landing-dark');
  const m = await newPage({ auth: true, mobile: true });
  await m.page.goto(`${E2E.api}/app`);
  await expect(m.page.getByText('Welcome back, Maya')).toBeVisible();
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) console.log('OVERFLOW', await m.page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((e) => `${e.tagName}.${(e.className as string).toString().slice(0, 80)} ${Math.round(e.getBoundingClientRect().right)}`)));
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(m.page, '32-dashboard-mobile');
  await m.page.goto(`${E2E.api}/`);
  const overflow2 = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow2).toBeLessThanOrEqual(1);
  await shot(m.page, '33-landing-mobile');
  expect([...dark.errors, ...m.errors]).toEqual([]);
});
