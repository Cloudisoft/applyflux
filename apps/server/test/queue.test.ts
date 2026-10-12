import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_SUBMIT_CONSENT_VERSION } from '@applyflux/shared';
import { enqueueJobs, sweepExpiredLeases } from '../src/services/queue';
import { fetchBoard } from '../src/services/discovery';
import { upsertJob } from '../src/services/jobs';
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
    expect(usage.applications.usedToday).toBe(1);
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
    await env.ctx.db.query(`update automation_preferences set max_concurrency = 5 where user_id=$1`, [u.id]);
    await u.post('/api/applications/enqueue', { jobIds: jobs });
    await u.post('/api/automation/start');
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => ext.post('/api/ext/next')));
    const claimed = results.filter((r) => r.body.data.applicationId);
    expect(claimed).toHaveLength(1);
  });
});

describe('auto mode safeguards', () => {
  it('requires explicit consent, then allows submit only on enabled platforms', async () => {
    const u = await createUser(env, 'm1@example.com');
    await completeProfile(u);
    await pairExtension(env, u);
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

describe('automatically queued jobs', () => {
  it('skips a job ApplyFlux queued itself once it no longer fits the target titles, but keeps fitting ones', async () => {
    const { u, ext } = await setup('relevance@example.com');
    await u.patch('/api/profile', { desiredTitles: ['QA Analyst', 'Software Test Engineer'] });
    const design = (await u.post('/api/jobs/import', { url: 'https://example.com/jobs/design', title: 'Senior Product Designer', company: 'Acme' })).body.data.id;
    const qa = (await u.post('/api/jobs/import', { url: 'https://example.com/jobs/qa', title: 'Senior QA Analyst', company: 'Acme' })).body.data.id;
    const q = await enqueueJobs(env.ctx.db, u.id, [design, qa], { actor: 'system' });
    expect(q.map((r) => r.status), JSON.stringify(q)).toEqual(['queued', 'queued']);
    await u.post('/api/automation/start');
    // Claim until a job is handed out; everything auto-queued that does not fit is skipped on the way.
    let task: { job?: { title: string } } = {};
    for (let i = 0; i < 8 && !task.job; i++) task = (await ext.post('/api/ext/next')).body.data;
    expect(task.job?.title).toBe('Senior QA Analyst');
    const designer = await env.ctx.db.query(`select a.state from applications a where a.job_id=$1`, [design]);
    expect(designer.rows[0].state).toBe('SKIPPED');
  });
});

describe('Greenhouse jobs on company websites', () => {
  it('opens Greenhouse\'s own application page, which the extension can fill, instead of the company page', async () => {
    const { u, ext } = await setup('gh-embed@example.com');
    await u.patch('/api/profile', { desiredTitles: ['Abuse Investigator'] });
    const jobs = await fetchBoard('greenhouse', 'stripe', 'Stripe', async () => ({
      status: 200,
      json: { jobs: [{ id: 8172510, title: 'Abuse Investigator', absolute_url: 'https://stripe.com/jobs/search?gh_jid=8172510', location: { name: 'Remote' } }] },
    }), { withContent: false });
    expect(jobs[0].applyUrl).toBe('https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8172510');
    const { id } = await upsertJob(env.ctx.db, u.id, { origin: 'discovery', ...jobs[0] });
    await env.ctx.db.query(`update applications set state='SKIPPED' where user_id=$1 and state='QUEUED'`, [u.id]).catch(() => {});
    await enqueueJobs(env.ctx.db, u.id, [id]);
    await u.post('/api/automation/start');
    let task: { job?: { url: string; atsVendor: string | null } } = {};
    for (let i = 0; i < 8 && !task.job; i++) task = (await ext.post('/api/ext/next')).body.data;
    expect(task.job?.url).toBe('https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8172510');
    expect(task.job?.atsVendor).toBe('greenhouse');
  });
});

describe('Save to ApplyFlux from job boards', () => {
  it('matches LinkedIn/Indeed jobs to the employer\'s own posting and queues them; unmatched ones are left for the person', async () => {
    const { u, ext } = await setup('clip@example.com');
    env.setBoards({
      'https://boards-api.greenhouse.io/v1/boards/acmehealth/jobs': {
        status: 200,
        json: { jobs: [
          { id: 501, title: 'Senior QA Analyst', absolute_url: 'https://job-boards.greenhouse.io/acmehealth/jobs/501', location: { name: 'Remote, US' } },
          { id: 502, title: 'Product Designer', absolute_url: 'https://job-boards.greenhouse.io/acmehealth/jobs/502', location: { name: 'Remote' } },
        ] },
      },
    });
    const res = await ext.post('/api/ext/jobs/save', {
      jobs: [
        { url: 'https://www.linkedin.com/jobs/view/4012345678', title: 'Senior QA Analyst', company: 'Acme Health', location: 'United States (Remote)' },
        { url: 'https://job-boards.greenhouse.io/othercorp/jobs/77', title: 'QA Engineer', company: 'OtherCorp' },
        { url: 'https://www.indeed.com/viewjob?jk=abc123', title: 'Test Lead', company: 'Nowhere Widgets Ltd' },
      ],
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ queued: 2, needsYou: 1 });
    // The LinkedIn job is stored as the employer's Greenhouse posting, which ApplyFlux can fill.
    expect(d.results[0]).toMatchObject({ status: 'queued', url: 'https://job-boards.greenhouse.io/acmehealth/jobs/501' });
    expect(d.results[2]).toMatchObject({ status: 'needs_you' });
    const queued = await env.ctx.db.query(`select j.url from applications a join jobs j on j.id=a.job_id where a.user_id=$1 and a.state='QUEUED' order by j.url`, [u.id]);
    expect(queued.rows.map((r) => r.url)).toEqual(expect.arrayContaining(['https://job-boards.greenhouse.io/acmehealth/jobs/501', 'https://job-boards.greenhouse.io/othercorp/jobs/77']));
    // An employer link shown on the job page is used directly (any employer site, e.g. Workday).
    const shown = (await ext.post('/api/ext/jobs/save', { jobs: [{ url: 'https://www.linkedin.com/jobs/view/4055555555', title: 'QA Lead', company: 'Delta Logistics', applyUrl: 'https://delta.wd1.myworkdayjobs.com/careers/job/QA-Lead_R1' }] })).body.data;
    expect(shown.results[0]).toMatchObject({ status: 'queued', url: 'https://delta.wd1.myworkdayjobs.com/careers/job/QA-Lead_R1' });
    // Saving the same jobs again does not duplicate anything.
    const again = (await ext.post('/api/ext/jobs/save', { jobs: [{ url: 'https://www.linkedin.com/jobs/view/4012345678', title: 'Senior QA Analyst', company: 'Acme Health' }] })).body.data;
    expect(again.queued).toBe(0);
  });
});

describe('answers the person gives in a form are remembered', () => {
  it('parks for the answers, resumes, and reuses them (and similar wordings) on the next form', async () => {
    const { u, ext, jobs } = await setup('learn@example.com');
    await u.post('/api/applications/enqueue', { jobIds: [jobs[0]] });
    await u.post('/api/automation/start');
    let t: { applicationId?: string } = {};
    for (let i = 0; i < 8 && !t.applicationId; i++) t = (await ext.post('/api/ext/next')).body.data;
    const id = t.applicationId!;
    await ext.post(`/api/ext/applications/${id}/report`, { type: 'intervention', data: { intervention: 'review_before_submit', message: '2 question(s) need your answer: veteran; why', pageUrl: 'https://example.com' } });
    expect((await u.get(`/api/applications/${id}`)).body.data.state).toBe('AWAITING_REVIEW');
    const r = await ext.post(`/api/ext/applications/${id}/report`, {
      type: 'answers_provided',
      data: { answers: [{ question: 'Are you a veteran, active member or reservist of the United States Armed Forces?', answer: 'No' }, { question: 'Why do you want to join our team?', answer: 'I like building reliable test automation.' }] },
    });
    expect(r.body.data.state).toBe('IN_PROGRESS');
    // Next form: different wording, still answered from what the person gave.
    const next = (await ext.post('/api/ext/answers', {
      applicationId: id,
      questions: [
        { key: 'vet', label: 'Veteran Status', kind: 'select', options: ['I am a protected veteran', 'No', 'Decline to self-identify'], required: true },
        { key: 'why', label: 'Why do you want to join our team at Acme?', kind: 'textarea', required: true },
      ],
    })).body.data;
    const by = Object.fromEntries(next.map((a: { key: string }) => [a.key, a]));
    expect(by.vet).toMatchObject({ answer: 'No', needsUser: false });
    expect(by.why).toMatchObject({ answer: 'I like building reliable test automation.', source: 'saved' });
    const profile = (await u.get('/api/profile')).body.data.profile;
    expect(profile.screening).toMatchObject({ eeo: 'answer', veteranStatus: 'No' });
  });
});

