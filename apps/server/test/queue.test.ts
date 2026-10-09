import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_SUBMIT_CONSENT_VERSION } from '@applyflux/shared';
import { sweepExpiredLeases } from '../src/services/queue';
import { completeProfile, createUser, makeEnv, pairExtension, type TestEnv } from './helpers';

let env: TestEnv;

beforeAll(async () => {
  env = await makeEnv('applyflux_it_queue');
});
afterAll(() => env.close());

const evidenceOk = (url: string) => ({
  finalUrl: url,
  pageTitle: 'Application submitted',
  confirmationText: 'Thank you for applying! Your application has been submitted.',
  matchedSignals: ['text:thank(s| you) for (applying|your application|submitting)'],
  formStillPresent: false,
  errorsVisible: false,
  adapter: 'sandbox',
  observedAt: new Date().toISOString(),
});

async function setup(email: string, mode: 'review' | 'assisted' | 'auto' = 'assisted') {
  const u = await createUser(env, email);
  await completeProfile(u);
  const ext = await pairExtension(env, u);
  await u.put('/api/automation/preferences', { mode, dailyLimit: 5, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
  const jobs: string[] = [];
  for (const scenario of ['standard', 'multistep', 'captcha-submit']) {
    const r = await u.post('/api/sandbox/jobs', { scenario });
    expect(r.status).toBe(201);
    jobs.push(r.body.data.jobId);
  }
  return { u, ext, jobs };
}

describe('queue lifecycle', () => {
  it('enqueue is idempotent and duplicate-safe', async () => {
    const { u, jobs } = await setup('q1@example.com');
    const first = await u.post('/api/applications/enqueue', { jobIds: [jobs[0], jobs[0]] });
    expect(first.body.data.map((r: { status: string }) => r.status)).toEqual(['queued', 'already']);
    const again = await u.post('/api/applications/enqueue', { jobIds: [jobs[0]] });
    expect(again.body.data[0].status).toBe('already');
    const list = await u.get('/api/applications?state=QUEUED');
    expect(list.body.data.total).toBe(1);
  });

  it('requires a connected extension to start, and a running automation to claim', async () => {
    const u = await createUser(env, 'q2@example.com');
    const r = await u.post('/api/automation/start');
    expect(r.status).toBe(400);
    const ext = await pairExtension(env, u);
    expect((await ext.post('/api/ext/next')).body.data).toMatchObject({ idle: true });
  });

  it('full happy path: claim → fill → submit → verified, charged exactly once', async () => {
    const { u, ext, jobs } = await setup('q3@example.com');
    await u.post('/api/applications/enqueue', { jobIds: [jobs[0]] });
    expect((await u.post('/api/automation/start')).status).toBe(200);
    const task = (await ext.post('/api/ext/next')).body.data;
    expect(task.applicationId).toBeTruthy();
    expect(task.mode).toBe('assisted');
    expect(task.allowSubmit).toBe(false); // assisted never auto-submits
    expect(task.profile.firstName).toBe('Ada');
    expect(task.profile.verifiedKeys).toEqual(expect.arrayContaining(['firstName', 'workAuthorizations']));
    // Concurrency 1: nothing else is handed out.
    expect((await ext.post('/api/ext/next')).body.data.idle).toBe(true);

    const id = task.applicationId;
    expect((await ext.post(`/api/ext/applications/${id}/report`, { type: 'progress', data: { step: 'Filling form', progress: 40, adapter: 'sandbox' } })).status).toBe(200);
    // Assisted mode: ready for review, the person approves submission.
    await ext.post(`/api/ext/applications/${id}/report`, { type: 'ready_for_review', data: { fields: [], pageUrl: task.job.url } });
    expect((await u.get(`/api/applications/${id}`)).body.data.state).toBe('AWAITING_REVIEW');
    expect((await u.post(`/api/applications/${id}/actions`, { action: 'approve_submit' })).body.data.state).toBe('IN_PROGRESS');
    const hb = (await ext.post(`/api/ext/applications/${id}/heartbeat`)).body.data;
    expect(hb).toMatchObject({ signal: 'continue', submitApproved: true });

    // Submission result without a recorded submit attempt is refused.
    expect((await ext.post(`/api/ext/applications/${id}/report`, { type: 'submission_result', data: evidenceOk(task.job.url) })).status).toBe(400);
    await ext.post(`/api/ext/applications/${id}/report`, { type: 'submit_attempted', data: { pageUrl: task.job.url } });
    const res = await ext.post(`/api/ext/applications/${id}/report`, { type: 'submission_result', data: evidenceOk(task.job.url) });
    expect(res.body.data.state).toBe('SUBMITTED');
    // A duplicate report (e.g. retry after a network blip) is a no-op and does not double charge.
    const dup = await ext.post(`/api/ext/applications/${id}/report`, { type: 'submission_result', data: evidenceOk(task.job.url) });
    expect(dup.status).toBe(409); // lease released after completion
    const usage = (await u.get('/api/usage')).body.data;
    expect(usage.applications.usedThisMonth).toBe(1);
    expect(usage.applications.reserved).toBe(0);

    const detail = (await u.get(`/api/applications/${id}`)).body.data;
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['queued', 'claimed', 'ready_for_review', 'submit_approved', 'submit_attempted', 'submitted']));
  });

  it('weak evidence becomes SUBMISSION_UNVERIFIED, never SUBMITTED', async () => {
    const { u, ext, jobs } = await setup('q4@example.com');
    await u.post('/api/applications/enqueue', { jobIds: [jobs[0]] });
    await u.post('/api/automation/start');
    const task = (await ext.post('/api/ext/next')).body.data;
    await ext.post(`/api/ext/applications/${task.applicationId}/report`, { type: 'submit_attempted', data: { pageUrl: task.job.url } });
    const r = await ext.post(`/api/ext/applications/${task.applicationId}/report`, {
      type: 'submission_result',
      data: { ...evidenceOk('https://x/careers'), matchedSignals: [], confirmationText: undefined },
    });
    expect(r.body.data.state).toBe('SUBMISSION_UNVERIFIED');
    // The person can later confirm it.
    const c = await u.post(`/api/applications/${task.applicationId}/actions`, { action: 'confirm_submitted', note: 'Got the confirmation email' });
    expect(c.body.data.state).toBe('SUBMITTED');
  });
});

describe('human verification (CAPTCHA) flow', () => {
  it('pauses, refuses a resume without evidence, resumes with evidence', async () => {
    const { u, ext, jobs } = await setup('c1@example.com');
    await u.post('/api/applications/enqueue', { jobIds: [jobs[2]] });
    await u.post('/api/automation/start');
    const task = (await ext.post('/api/ext/next')).body.data;
    const id = task.applicationId;
    const stepState = { step: 1, filled: ['first_name', 'email'] };
    const p = await ext.post(`/api/ext/applications/${id}/report`, { type: 'intervention', data: { intervention: 'captcha', message: 'Verification challenge detected', stepState, pageUrl: task.job.url } });
    expect(p.body.data.state).toBe('AWAITING_HUMAN_VERIFICATION');
    const app = (await u.get(`/api/applications/${id}`)).body.data;
    expect(app.intervention.type).toBe('captcha');
    const notes = (await u.get('/api/notifications')).body.data;
    expect(notes.items[0].type).toBe('verification');

    // A click on "resume" is not evidence.
    const bad = await ext.post(`/api/ext/applications/${id}/report`, { type: 'verification_resolved', data: { challengeVisible: true, tokenPresent: false, provider: 'generic', observedAt: new Date().toISOString() } });
    expect(bad.status).toBe(409);
    expect((await u.get(`/api/applications/${id}`)).body.data.state).toBe('AWAITING_HUMAN_VERIFICATION');

    const good = await ext.post(`/api/ext/applications/${id}/report`, { type: 'verification_resolved', data: { challengeVisible: false, tokenPresent: true, provider: 'generic', observedAt: new Date().toISOString() } });
    expect(good.body.data.state).toBe('IN_PROGRESS');
    // The preserved step state is still there for safe resumption.
    const row = await env.ctx.db.query('select step_state from applications where id=$1', [id]);
    expect(row.rows[0].step_state).toEqual(stepState);
  });

  it('stops after a bounded number of repeated challenges', async () => {
    const { u, ext, jobs } = await setup('c2@example.com');
    await u.post('/api/applications/enqueue', { jobIds: [jobs[1]] });
    await u.post('/api/automation/start');
    const { applicationId: id } = (await ext.post('/api/ext/next')).body.data;
    const solve = { type: 'verification_resolved', data: { challengeVisible: false, tokenPresent: true, provider: 'generic', observedAt: new Date().toISOString() } };
    const captcha = { type: 'intervention', data: { intervention: 'captcha', message: 'again' } };
    for (let i = 0; i < 3; i++) {
      expect((await ext.post(`/api/ext/applications/${id}/report`, captcha)).body.data.state).toBe('AWAITING_HUMAN_VERIFICATION');
      await ext.post(`/api/ext/applications/${id}/report`, solve);
    }
    expect((await ext.post(`/api/ext/applications/${id}/report`, captcha)).body.data.state).toBe('NEEDS_ATTENTION');
  });

  it('a CAPTCHA on one application does not block others', async () => {
    const { u, ext, jobs } = await setup('c3@example.com');
    await u.put('/api/automation/preferences', { mode: 'assisted', dailyLimit: 5, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
    await u.post('/api/applications/enqueue', { jobIds: [jobs[0], jobs[1]] });
    await u.post('/api/automation/start');
    const t1 = (await ext.post('/api/ext/next')).body.data;
    await ext.post(`/api/ext/applications/${t1.applicationId}/report`, { type: 'intervention', data: { intervention: 'captcha', message: 'challenge' } });
    const t2 = (await ext.post('/api/ext/next')).body.data;
    expect(t2.applicationId).toBeTruthy();
    expect(t2.applicationId).not.toBe(t1.applicationId);
  });
});

describe('recovery and duplicate-submission safety', () => {
  it('requeues a lost executor before submit, but never after a submit click', async () => {
    const { u, ext, jobs } = await setup('r1@example.com');
    await env.ctx.db.query(`update subscriptions set plan_id='pro' where user_id=$1`, [u.id]); // pro allows 2 concurrent
    await u.put('/api/automation/preferences', { mode: 'assisted', dailyLimit: 5, maxConcurrency: 2, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
    await u.post('/api/applications/enqueue', { jobIds: [jobs[0], jobs[1]] });
    await u.post('/api/automation/start');
    const t1 = (await ext.post('/api/ext/next')).body.data;
    const t2 = (await ext.post('/api/ext/next')).body.data;
    await ext.post(`/api/ext/applications/${t2.applicationId}/report`, { type: 'submit_attempted', data: { pageUrl: t2.job.url } });
    await env.ctx.db.query(`update applications set lease_expires_at = now() - interval '1 minute' where user_id=$1`, [u.id]);
    expect(await sweepExpiredLeases(env.ctx.db)).toBe(2);
    expect((await u.get(`/api/applications/${t1.applicationId}`)).body.data.state).toBe('QUEUED');
    const a2 = (await u.get(`/api/applications/${t2.applicationId}`)).body.data;
    expect(a2.state).toBe('NEEDS_ATTENTION');
    expect(a2.intervention.type).toBe('executor_lost');
    // Retrying would risk a duplicate submission: refused.
    expect((await u.post(`/api/applications/${t2.applicationId}/actions`, { action: 'retry' })).status).toBe(409);
    // The lost browser cannot keep reporting on it.
    expect((await ext.post(`/api/ext/applications/${t2.applicationId}/report`, { type: 'progress', data: { step: 'x', progress: 1 } })).status).toBe(409);
  });

  it('bounded retries for retryable failures, then needs attention', async () => {
    const { u, ext, jobs } = await setup('r2@example.com');
    await u.post('/api/applications/enqueue', { jobIds: [jobs[0]] });
    await u.post('/api/automation/start');
    let state = '';
    for (let i = 0; i < 3; i++) {
      const t = (await ext.post('/api/ext/next')).body.data;
      state = (await ext.post(`/api/ext/applications/${t.applicationId}/report`, { type: 'failed', data: { code: 'timeout', message: 'Page did not load', retryable: true } })).body.data.state;
    }
    expect(state).toBe('NEEDS_ATTENTION');
  });

  it('pause and stop are honoured by heartbeats', async () => {
    const { u, ext, jobs } = await setup('r3@example.com');
    await u.post('/api/applications/enqueue', { jobIds: [jobs[0]] });
    await u.post('/api/automation/start');
    const t = (await ext.post('/api/ext/next')).body.data;
    await u.post('/api/automation/pause');
    expect((await ext.post(`/api/ext/applications/${t.applicationId}/heartbeat`)).body.data.signal).toBe('pause');
    expect((await ext.post('/api/ext/next')).body.data.idle).toBe(true);
    await u.post('/api/automation/resume');
    expect((await ext.post(`/api/ext/applications/${t.applicationId}/heartbeat`)).body.data.signal).toBe('continue');
    const s = (await u.post('/api/automation/stop')).body.data;
    expect(s.requeued).toBe(1);
    expect((await ext.post(`/api/ext/applications/${t.applicationId}/heartbeat`)).body.data.signal).toBe('stop');
  });

  it('a revoked extension is locked out', async () => {
    const { u, ext } = await setup('r4@example.com');
    const conns = (await u.get('/api/extension/connections')).body.data;
    await u.del(`/api/extension/connections/${conns[0].id}`);
    const r = await ext.get('/api/ext/session');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('EXTENSION_REVOKED');
  });
});

describe('quota enforcement', () => {
  it('concurrent claims cannot exceed the daily limit', async () => {
    const { u, ext, jobs } = await setup('l1@example.com');
    await u.put('/api/automation/preferences', { mode: 'assisted', dailyLimit: 1, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
    await env.ctx.db.query(`update plans set max_concurrency = 5 where id='free'`);
    await env.ctx.db.query(`update automation_preferences set max_concurrency = 5 where user_id=$1`, [u.id]);
    await u.post('/api/applications/enqueue', { jobIds: jobs });
    await u.post('/api/automation/start');
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => ext.post('/api/ext/next')));
    const claimed = results.filter((r) => r.body.data.applicationId);
    expect(claimed).toHaveLength(1);
    await env.ctx.db.query(`update plans set max_concurrency = 1 where id='free'`);
  });
});

describe('auto mode safeguards', () => {
  it('requires plan support and explicit consent, then allows submit only on enabled platforms', async () => {
    const u = await createUser(env, 'm1@example.com');
    await completeProfile(u);
    await pairExtension(env, u);
    const r1 = await u.put('/api/automation/preferences', { mode: 'auto', dailyLimit: 5, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
    expect(r1.status).toBe(403); // free plan has no Auto Mode
    await env.ctx.db.query(`update subscriptions set plan_id='pro' where user_id=$1`, [u.id]);
    await u.put('/api/automation/preferences', { mode: 'auto', dailyLimit: 5, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
    const r2 = await u.post('/api/automation/start');
    expect(r2.body.error.code).toBe('CONSENT_REQUIRED');
    await u.post('/api/automation/consent', { version: AUTO_SUBMIT_CONSENT_VERSION, accepted: true });
    expect((await u.post('/api/automation/start')).status).toBe(200);
    const ext = await pairExtension(env, u);
    const s = (await u.post('/api/sandbox/jobs', { scenario: 'standard' })).body.data;
    const imported = (await u.post('/api/jobs/import', { url: 'https://boards.greenhouse.io/acme/jobs/123', title: 'Engineer', company: 'Acme' })).body.data;
    await u.post('/api/applications/enqueue', { jobIds: [s.jobId], priority: 5 });
    await u.post('/api/applications/enqueue', { jobIds: [imported.id] });
    const t1 = (await ext.post('/api/ext/next')).body.data;
    expect(t1.job.id).toBe(s.jobId);
    expect(t1.allowSubmit).toBe(true);
    await ext.post(`/api/ext/applications/${t1.applicationId}/report`, { type: 'failed', data: { code: 'x', message: 'x', retryable: false } });
    const t2 = (await ext.post('/api/ext/next')).body.data;
    expect(t2.job.atsVendor).toBe('greenhouse');
    expect(t2.allowSubmit).toBe(false); // greenhouse not enabled for auto-submit in this deployment
  });
});
