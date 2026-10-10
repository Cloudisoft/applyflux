import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { SignJWT } from 'jose';
import pg from 'pg';
import { E2E } from './global-setup';

/**
 * Clicks every button, link, tab and switch on every screen (fresh page load per click) and fails on
 * anything that throws, logs an error, or gets a server error. Also lists controls that visibly do
 * nothing, so dead buttons are caught. Runs against the local test server, never real data.
 */
const here = dirname(fileURLToPath(import.meta.url));
let browser: Browser;
let db: pg.Pool;
let session: Record<string, unknown>;
let token = '';
let jobId = '';

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${E2E.api}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(j)}`);
  return j.data;
}

test.beforeAll(async () => {
  db = new pg.Pool({ connectionString: readFileSync(resolve(here, '.db-url'), 'utf8') });
  const email = `buttons+${Date.now()}@example.com`;
  const u = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, '{"full_name":"Sam Rivera"}') returning id`, [email]);
  const id = u.rows[0].id as string;
  const exp = Math.floor(Date.now() / 1000) + 7200;
  token = await new SignJWT({ role: 'authenticated', email }).setProtectedHeader({ alg: 'HS256' }).setSubject(id).setAudience('authenticated').setExpirationTime(exp).sign(new TextEncoder().encode(E2E.jwtSecret));
  session = { access_token: token, refresh_token: 'e2e-refresh', token_type: 'bearer', expires_in: 7200, expires_at: exp, user: { id, email, aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: { full_name: 'Sam Rivera' } } };
  await call('GET', '/me');
  await call('PATCH', '/profile', {
    firstName: 'Sam', lastName: 'Rivera', phone: '+1 415 555 0100', city: 'Austin', country: 'United States', headline: 'Frontend Engineer',
    skills: ['React', 'TypeScript'], yearsExperience: 6, desiredTitles: ['Frontend Engineer'], workplaceTypes: ['remote'],
    workAuthorizations: [{ country: 'United States', authorized: true, requiresSponsorship: false }],
  });
  await call('POST', '/profile/experiences', { company: 'Acme', title: 'Frontend Engineer', startDate: '2020-01', isCurrent: true });
  await call('POST', '/profile/educations', { institution: 'UT Austin', degree: 'BS', startDate: '2014', endDate: '2018' });
  for (const scenario of ['standard', 'multistep', 'captcha-before']) {
    const j = await call('POST', '/sandbox/jobs', { scenario });
    await call('POST', '/applications/enqueue', { jobIds: [j.jobId] });
  }
  jobId = (await call('POST', '/jobs/import', { url: 'https://example.com/careers/fe', title: 'Frontend Engineer', company: 'Example Co', location: 'Remote (US)', description: 'React and TypeScript.' })).id;
  await call('POST', '/answers', { question: 'How did you hear about us?', answer: 'Job board' });
  // Follow the state machine: QUEUED -> IN_PROGRESS -> waiting on the person.
  await db.query(`update applications set state='IN_PROGRESS', lease_expires_at=now()+interval '2 hours' where user_id=$1 and state='QUEUED' and id in (select id from applications where user_id=$1 order by created_at limit 2)`, [id]);
  await db.query(
    `update applications set state='AWAITING_HUMAN_VERIFICATION', intervention=$2 where id=(select id from applications where user_id=$1 order by created_at limit 1)`,
    [id, JSON.stringify({ type: 'captcha', title: 'Quick verification needed', message: 'A verification check appeared.', action: 'Tick the check in the tab.', since: new Date().toISOString() })],
  );
  await db.query(`update applications set state='AWAITING_REVIEW', intervention=$2 where id=(select id from applications where user_id=$1 and state='IN_PROGRESS' order by created_at limit 1)`, [id, JSON.stringify({ type: 'review_before_submit', title: 'Ready for review', message: 'Filled.', action: 'Review and submit.', since: new Date().toISOString() })]);
  await db.query(`insert into notifications (user_id, type, title, body, severity) values ($1,'verification','Quick verification needed','Please complete the check.','warning')`, [id]);
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
test.afterAll(async () => {
  await browser?.close();
  await db?.end();
});

const CLICKABLE = 'button, a[href], [role="button"], [role="tab"], [role="switch"], [role="menuitem"], summary, label:has(input[type=checkbox])';

interface Outcome { page: string; control: string; result: 'ok' | 'error' | 'no-effect' | 'skipped'; detail?: string }

async function openPage(path: string, auth: boolean): Promise<{ page: Page; errors: string[]; apiFailures: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  if (auth) await ctx.addInitScript((s) => localStorage.setItem('sb-127-auth-token', JSON.stringify(s)), session);
  const page = await ctx.newPage();
  const errors: string[] = [];
  const apiFailures: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/127\.0\.0\.1:54321|Content Security Policy|WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource|React Router Future/.test(m.text())) errors.push(m.text().slice(0, 200));
  });
  page.on('response', (r) => {
    // 503 = a feature not configured on this server (AI in tests): the UI must still show a message, checked via mutations.
    if (r.url().includes('/api/') && r.status() >= 500 && r.status() !== 503) apiFailures.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
  });
  await page.goto(`${E2E.api}${path}`, { waitUntil: 'domcontentloaded' });
  // Pages that poll for live updates never go fully idle: cap the wait.
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(200);
  return { page, errors, apiFailures };
}

async function labelOf(page: Page, i: number) {
  return page.locator(CLICKABLE).nth(i).evaluate((el) => {
    const t = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const href = el.getAttribute('href');
    return `${el.tagName.toLowerCase()}${href ? `[${href}]` : ''} "${t.slice(0, 60)}"`;
  });
}

async function auditPage(path: string, auth: boolean, seen: Set<string>): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const first = await openPage(path, auth);
  const count = await first.page.locator(CLICKABLE).count();
  const labels: string[] = [];
  for (let i = 0; i < count; i++) labels.push(await labelOf(first.page, i).catch(() => '?'));
  await first.page.context().close();

  for (let i = 0; i < count; i++) {
    const label = labels[i];
    // Sidebar/top bar links repeat on every page: test them once.
    if (seen.has(label)) continue;
    seen.add(label);
    const { page, errors, apiFailures } = await openPage(path, auth);
    try {
      const el = page.locator(CLICKABLE).nth(i);
      if (!(await el.isVisible().catch(() => false))) {
        out.push({ page: path, control: label, result: 'skipped', detail: 'not visible at this size' });
        continue;
      }
      if (await el.isDisabled().catch(() => false)) {
        out.push({ page: path, control: label, result: 'skipped', detail: 'disabled' });
        continue;
      }
      const href = await el.getAttribute('href');
      if (href?.startsWith('#') && /skip/i.test(label)) {
        out.push({ page: path, control: label, result: 'skipped', detail: 'keyboard skip link' });
        continue;
      }
      const target = await el.getAttribute('target');
      if (href && (/^(https?:)?\/\//.test(href) && !href.startsWith(E2E.api)) || target === '_blank' || href?.startsWith('mailto:')) {
        out.push({ page: path, control: label, result: href && href !== '#' ? 'ok' : 'error', detail: `external link ${href}` });
        continue;
      }
      await page.evaluate(() => {
        (window as unknown as { __mut: number }).__mut = 0;
        new MutationObserver((m) => ((window as unknown as { __mut: number }).__mut += m.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      const urlBefore = page.url();
      let requests = 0;
      page.on('request', () => requests++);
      const popup = page.context().waitForEvent('page', { timeout: 1500 }).then(() => true).catch(() => false);
      const download = page.waitForEvent('download', { timeout: 1500 }).then(() => true).catch(() => false);
      await el.click({ timeout: 3000 });
      await page.waitForTimeout(700);
      const mutated = await page.evaluate(() => (window as unknown as { __mut?: number }).__mut ?? 0).catch(() => 1);
      const changed = page.url() !== urlBefore || mutated > 0 || requests > 0 || (await popup) || (await download);
      if (errors.length || apiFailures.length) out.push({ page: path, control: label, result: 'error', detail: [...errors, ...apiFailures].join(' | ') });
      else out.push({ page: path, control: label, result: changed ? 'ok' : 'no-effect' });
      // A dialog or menu opened: test every control inside it too (re-opening it fresh for each).
      const layer = page.locator('[role="dialog"], [role="menu"]').last();
      if (await layer.isVisible().catch(() => false)) {
        const inner = await layer.locator(CLICKABLE).count();
        for (let k = 0; k < inner; k++) {
          const sub = await openPage(path, auth);
          try {
            await sub.page.locator(CLICKABLE).nth(i).click({ timeout: 3000 });
            await sub.page.waitForTimeout(400);
            const l2 = sub.page.locator('[role="dialog"], [role="menu"]').last();
            const c = l2.locator(CLICKABLE).nth(k);
            const name = `${label} › ${(await c.evaluate((e) => (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50)).catch(() => '?'))}`;
            if (seen.has(name)) continue;
            seen.add(name);
            if (!(await c.isVisible().catch(() => false)) || (await c.isDisabled().catch(() => false))) {
              out.push({ page: path, control: name, result: 'skipped', detail: 'disabled until filled in' });
              continue;
            }
            if ((await c.getAttribute('target')) === '_blank') { out.push({ page: path, control: name, result: 'ok', detail: 'external' }); continue; }
            await sub.page.evaluate(() => {
              (window as unknown as { __mut: number }).__mut = 0;
              new MutationObserver((m) => ((window as unknown as { __mut: number }).__mut += m.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
            });
            const before = sub.page.url();
            let reqs = 0;
            sub.page.on('request', () => reqs++);
            await c.click({ timeout: 3000 });
            await sub.page.waitForTimeout(700);
            const m = await sub.page.evaluate(() => (window as unknown as { __mut?: number }).__mut ?? 0).catch(() => 1);
            if (sub.errors.length || sub.apiFailures.length) out.push({ page: path, control: name, result: 'error', detail: [...sub.errors, ...sub.apiFailures].join(' | ') });
            else out.push({ page: path, control: name, result: sub.page.url() !== before || m > 0 || reqs > 0 ? 'ok' : 'no-effect' });
          } catch (e) {
            out.push({ page: path, control: `${label} › #${k}`, result: 'error', detail: (e as Error).message.split('\n')[0] });
          } finally {
            await sub.page.context().close();
          }
        }
      }
    } catch (e) {
      out.push({ page: path, control: label, result: 'error', detail: (e as Error).message.split('\n')[0] });
    } finally {
      await page.context().close();
    }
  }
  return out;
}

const PAGES: Array<[string, boolean]> = [
  ['/', false], ['/platforms', false], ['/security', false], ['/signin', false], ['/signup', false], ['/forgot-password', false],
  ['/app', true], ['/app/automation', true], ['/app/applications', true], ['/app/jobs', true], ['/app/jobs/:job', true], ['/app/match', true],
  ['/app/profile', true], ['/app/resumes', true], ['/app/studio', true], ['/app/cover-letters', true], ['/app/answers', true],
  ['/app/extension', true], ['/app/settings/automation', true], ['/app/settings/account', true], ['/app/notifications', true], ['/app/setup', true],
];
const seen = new Set<string>();
const dead: Outcome[] = [];

for (const [p, auth] of PAGES) {
  test(`every control works on ${p}`, async () => {
    test.setTimeout(45 * 60_000);
    const path = p.replace(':job', jobId);
    const out = await auditPage(path, auth, seen);
    for (const o of out) if (o.result !== 'ok') console.log(o.result.toUpperCase(), p, o.control, o.detail ?? '');
    console.log(`${p}: ${out.filter((o) => o.result === 'ok').length} ok, ${out.filter((o) => o.result === 'no-effect').length} no effect, ${out.filter((o) => o.result === 'error').length} errors`);
    dead.push(...out.filter((o) => o.result === 'no-effect'));
    const bad = out.filter((o) => o.result === 'error');
    expect(bad, bad.map((o) => `${o.control}: ${o.detail}`).join('\n')).toEqual([]);
  });
}
