import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { clearDiscoveryCache, runDiscovery } from '../src/services/autodiscover';
import { renderPdf } from '../src/services/documents';
import { heuristicExtract } from '../src/services/resume';
import { groundingIssues } from '../src/ai/grounding';
import { completeProfile, createUser, makeEnv, pairExtension, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv('applyflux_it_api', { ai: true });
});
afterAll(() => env.close());

const RESUME_TEXT = `Grace Hopper
grace.hopper@example.com | +1 415 555 0100 | linkedin.com/in/gracehopper
Summary
Engineer and leader who builds compilers and developer tools.
Experience
Senior Software Engineer at Eckert Computing
Jan 2018 - Present
• Led a team of 6 building a TypeScript compiler toolchain
• Cut build times by 40%
Software Engineer, Remington Rand
Jun 2014 - Dec 2017
• Built COBOL tooling
Education
Bachelor of Science in Mathematics
Vassar College, 2010 - 2014
Skills
TypeScript, Node.js, PostgreSQL, Leadership`;

describe('resume intelligence', () => {
  it('heuristic extraction pulls contact, roles and education without inventing', () => {
    const e = heuristicExtract(RESUME_TEXT);
    expect(e).toMatchObject({ firstName: 'Grace', lastName: 'Hopper', email: 'grace.hopper@example.com', linkedinUrl: 'https://linkedin.com/in/gracehopper' });
    expect(e.experiences).toHaveLength(2);
    expect(e.experiences[0]).toMatchObject({ title: 'Senior Software Engineer', company: 'Eckert Computing', startDate: '2018-01', isCurrent: true });
    expect(e.experiences[1]).toMatchObject({ company: 'Remington Rand', startDate: '2014-06', endDate: '2017-12' });
    expect(e.educations[0]).toMatchObject({ institution: 'Vassar College', degree: 'Bachelor of Science in Mathematics', endDate: '2014' });
    expect(e.skills).toEqual(expect.arrayContaining(['TypeScript', 'PostgreSQL']));
  });

  it('upload PDF → parse (AI, cross-checked) → review → apply as unverified facts', async () => {
    const u = await createUser(env, 'grace@example.com');
    // AI returns one real role and one fabricated one; the fabricated one must be dropped.
    env.setAiResponder(() =>
      JSON.stringify({
        firstName: 'Grace', lastName: 'Hopper', email: 'grace.hopper@example.com', phone: '+1 415 555 0100',
        skills: ['TypeScript', 'Node.js'],
        experiences: [
          { company: 'Eckert Computing', title: 'Senior Software Engineer', startDate: 'Jan 2018', endDate: null, isCurrent: true, achievements: ['Led a team of 6'] },
          { company: 'Hallucinated Corp', title: 'Chief Wizard', startDate: '2001', endDate: '2002', isCurrent: false, achievements: [] },
        ],
        educations: [{ institution: 'Vassar College', degree: 'Bachelor of Science', fieldOfStudy: 'Mathematics', startDate: '2010', endDate: '2014' }],
      }),
    );
    const pdf = await renderPdf('Grace Hopper', null, [{ text: RESUME_TEXT.split('\n').slice(1).join('\n') }]);
    const up = await request(env.app).post('/api/documents').set('Authorization', `Bearer ${u.token}`).field('kind', 'resume').attach('file', pdf, 'Grace_Hopper_CV.pdf');
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ parseStatus: 'parsed', isDefault: true, mimeType: 'application/pdf' });
    expect(up.body.data.storagePath).toBeUndefined();

    const parsed = await u.post(`/api/documents/${up.body.data.id}/parse`);
    expect(parsed.status).toBe(201);
    expect(parsed.body.data.method).toBe('ai');
    expect(parsed.body.data.extracted.experiences.map((x: { company: string }) => x.company)).toEqual(['Eckert Computing']);
    expect(parsed.body.data.warnings.join(' ')).toMatch(/Hallucinated Corp/);

    const applied = await u.post(`/api/resume-parses/${parsed.body.data.id}/apply`, { extracted: parsed.body.data.extracted, confirmedFields: ['firstName'] });
    expect(applied.status).toBe(200);
    const prof = (await u.get('/api/profile')).body.data;
    expect(prof.profile.firstName).toBe('Grace');
    expect(prof.profile.fieldMeta.firstName).toEqual({ source: 'resume', verified: true });
    expect(prof.profile.fieldMeta.phone).toEqual({ source: 'resume', verified: false });
    expect(prof.experiences[0]).toMatchObject({ company: 'Eckert Computing', startDate: '2018-01', source: 'resume', verified: false });
    expect(prof.assessment.readyForAutomation).toBe(false);
    expect(prof.assessment.unverified).toEqual(expect.arrayContaining(['phone']));

    // File download is scoped to the owner.
    const other = await createUser(env, 'eve@example.com');
    expect((await other.get(`/api/documents/${up.body.data.id}/file`)).status).toBe(404);
    const own = await u.get(`/api/documents/${up.body.data.id}/file`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('application/pdf');

    // New version
    const v2 = await request(env.app).post('/api/documents').set('Authorization', `Bearer ${u.token}`).field('rootDocumentId', up.body.data.id).attach('file', pdf, 'v2.pdf');
    expect(v2.body.data.version).toBe(2);
  });

  it('rejects files whose content does not match an allowed type', async () => {
    const u = await createUser(env, 'badfile@example.com');
    const r = await request(env.app).post('/api/documents').set('Authorization', `Bearer ${u.token}`).attach('file', Buffer.from('MZ\x90\x00 not a pdf'), 'cv.pdf');
    expect(r.status).toBe(415);
  });
});

describe('profile editing and validation', () => {
  it('user edits are verified facts; invalid data is rejected', async () => {
    const u = await createUser(env, 'edit@example.com');
    const r = await u.patch('/api/profile', { firstName: 'Ada', linkedinUrl: 'javascript:alert(1)' });
    expect(r.status).toBe(422);
    const ok = await u.patch('/api/profile', { firstName: 'Ada', desiredSalaryMin: 100000, desiredSalaryMax: 90000 });
    expect(ok.body.data.profile.fieldMeta.firstName.verified).toBe(true);
    expect(ok.body.data.assessment.issues.map((i: { message: string }) => i.message)).toContain('Maximum salary is below minimum salary');
    const exp = await u.post('/api/profile/experiences', { company: 'A', title: 'B', startDate: 'last year' });
    expect(exp.status).toBe(422);
  });

  it('cross-user access is impossible through the API', async () => {
    const a = await createUser(env, 'xa@example.com');
    const b = await createUser(env, 'xb@example.com');
    const e = await a.post('/api/profile/experiences', { company: 'A', title: 'B' });
    expect((await b.patch(`/api/profile/experiences/${e.body.data.id}`, { company: 'Hacked' })).status).toBe(404);
    expect((await b.del(`/api/profile/experiences/${e.body.data.id}`)).status).toBe(404);
    const job = await a.post('/api/jobs/import', { url: 'https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111', title: 'Eng', company: 'Acme' });
    expect((await b.get(`/api/jobs/${job.body.data.id}`)).status).toBe(404);
    expect((await b.post('/api/applications/enqueue', { jobIds: [job.body.data.id] })).body.data[0].status).toBe('skipped');
  });

  it('rejects unauthenticated and forged tokens', async () => {
    expect((await request(env.app).get('/api/profile')).status).toBe(401);
    expect((await request(env.app).get('/api/profile').set('Authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.')).status).toBe(401);
  });
});

describe('job discovery & matching', () => {
  const GH = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
  const ghJobs = (ids: number[]) => ({
    status: 200,
    json: {
      jobs: ids.map((id) => ({
        id,
        title: id === 1 ? 'Senior Frontend Engineer' : 'Accountant',
        absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
        location: { name: 'Remote' },
        content: '&lt;p&gt;We use React, TypeScript and Node.js.&lt;/p&gt;',
        first_published: '2026-09-01T00:00:00Z',
      })),
    },
  });

  it('syncs a public board, scores matches, and marks vanished postings expired', async () => {
    const u = await createUser(env, 'disc@example.com');
    await completeProfile(u);
    env.setBoards({ [GH]: ghJobs([1, 2]) });
    const src = await u.post('/api/sources', { url: 'https://job-boards.greenhouse.io/acme', name: 'Acme' });
    expect(src.body.data).toMatchObject({ kind: 'greenhouse', identifier: 'acme' });
    const sync = await u.post(`/api/sources/${src.body.data.id}/sync`);
    expect(sync.body.data).toMatchObject({ created: 2, total: 2, expired: 0 });
    const list = (await u.get('/api/jobs?sort=score')).body.data;
    expect(list.total).toBe(2);
    expect(list.items[0].title).toBe('Senior Frontend Engineer');
    expect(list.items[0].score).toBeGreaterThan(list.items[1].score);
    expect(list.items[0].breakdown.matchedSkills).toEqual(expect.arrayContaining(['react', 'typescript']));
    // Re-sync: same postings are not duplicated; a removed one becomes expired.
    env.setBoards({ [GH]: ghJobs([1]) });
    const again = await u.post(`/api/sources/${src.body.data.id}/sync`);
    expect(again.body.data).toMatchObject({ created: 0, total: 1, expired: 1 });
    const expired = (await u.get('/api/jobs?q=Accountant')).body.data.items[0];
    expect(expired.liveness).toBe('expired');
    // Expired jobs are not queued.
    const q = await u.post('/api/applications/enqueue', { jobIds: [expired.id] });
    expect(q.body.data[0]).toMatchObject({ status: 'skipped', reason: 'Listing has expired' });
  });

  it('honours exclusions and reports source failures honestly', async () => {
    const u = await createUser(env, 'disc2@example.com');
    await u.put('/api/automation/preferences', { mode: 'review', dailyLimit: 5, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: ['Acme'], excludedKeywords: [] });
    const j = await u.post('/api/jobs/import', { url: 'https://acme.example/jobs/1?utm_source=x', title: 'Eng', company: 'ACME Inc' });
    const dup = await u.post('/api/jobs/import', { url: 'https://acme.example/jobs/1', title: 'Eng', company: 'ACME Inc' });
    expect(dup.body.data.id).toBe(j.body.data.id);
    expect((await u.post('/api/applications/enqueue', { jobIds: [j.body.data.id] })).body.data[0].reason).toMatch(/exclusion/);
    env.setBoards({});
    const src = await u.post('/api/sources', { kind: 'lever', identifier: 'nope' });
    const s = await u.post(`/api/sources/${src.body.data.id}/sync`);
    expect(s.status).toBe(502);
    expect(s.body.error.message).toMatch(/not found/);
  });

  it('rounds fractional salaries so one posting cannot fail a sync', async () => {
    const u = await createUser(env, 'disc3@example.com');
    const src = await u.post('/api/sources', { kind: 'lever', identifier: 'hourly' });
    env.setBoards({
      'https://api.lever.co/v0/postings/hourly?mode=json': {
        status: 200,
        json: [{ id: 'a1', hostedUrl: 'https://jobs.lever.co/hourly/a1', text: 'Support Engineer', categories: { location: 'Remote' }, salaryRange: { min: 52.5, max: 61.25, currency: 'USD' } }],
      },
    });
    const s = await u.post(`/api/sources/${src.body.data.id}/sync`);
    expect(s.body.data).toMatchObject({ created: 1, skipped: 0, total: 1 });
  });
});

describe('error handling', () => {
  it('answers malformed JSON with 400, not 500', async () => {
    const u = await createUser(env, 'json@example.com');
    const r = await request(env.app).patch('/api/profile').set('authorization', `Bearer ${u.token}`).set('content-type', 'application/json').send('{"firstName":');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('answer engine', () => {
  it('saved > verified profile facts > grounded AI; sensitive questions never go to AI', async () => {
    const u = await createUser(env, 'ans@example.com');
    await completeProfile(u);
    const ext = await pairExtension(env, u);
    await u.post('/api/answers', { question: 'How did you hear about us?', answer: 'Company website' });
    const job = (await u.post('/api/sandbox/jobs', { scenario: 'standard' })).body.data;
    await u.post('/api/applications/enqueue', { jobIds: [job.jobId] });
    await u.post('/api/automation/start');
    const task = (await ext.post('/api/ext/next')).body.data;
    expect(task.answers.map((a: { question: string }) => a.question)).toContain('How did you hear about us?');

    env.aiCalls.length = 0;
    env.setAiResponder((messages) => {
      const user = messages.find((m) => m.role === 'user')!.content;
      expect(user).toContain('<job_posting>');
      expect(user).toContain('<candidate_facts>');
      return JSON.stringify({
        answers: [
          { key: 'why', answer: 'I have built TypeScript and React products at Analytical Engines and want to bring that to Northwind.', supported: true, confidence: 0.8 },
          { key: 'award', answer: 'I won 12 Turing Awards in 2015.', supported: true, confidence: 0.9 },
        ],
      });
    });
    const res = await ext.post('/api/ext/answers', {
      applicationId: task.applicationId,
      questions: [
        { key: 'heard', label: 'How did you hear about us?', kind: 'select', options: ['Job board', 'Company website', 'Referral'], required: false },
        { key: 'auth', label: 'Are you legally authorized to work in the United Kingdom?', kind: 'radio', options: ['Yes', 'No'], required: true },
        { key: 'gender', label: 'What is your gender?', kind: 'select', options: ['Female', 'Male', 'Decline to self-identify'], required: false },
        { key: 'why', label: 'Why do you want to work at Northwind Labs?', kind: 'textarea', required: true },
        { key: 'award', label: 'Tell us about an award you have won', kind: 'textarea', required: false },
      ],
    });
    const by = Object.fromEntries(res.body.data.map((a: { key: string }) => [a.key, a]));
    expect(by.heard).toMatchObject({ answer: 'Company website', source: 'saved', needsUser: false });
    expect(by.auth).toMatchObject({ answer: 'Yes', source: 'profile', needsUser: false });
    expect(by.gender).toMatchObject({ answer: null, needsUser: true });
    expect(by.why).toMatchObject({ source: 'ai', needsUser: false });
    // Fabricated numbers are caught by the grounding guard.
    expect(by.award).toMatchObject({ source: 'ai', needsUser: true });
    // Only the two non-sensitive questions were sent to the model.
    const prompt = env.aiCalls[0].messages.find((m) => m.role === 'user')!.content;
    expect(prompt).not.toContain('gender');
    expect(prompt).not.toContain('legally authorized');
    // Drafts are saved for review but never auto-approved.
    const answers = (await u.get('/api/answers')).body.data;
    expect(answers.find((a: { question: string }) => a.question.startsWith('Why do you want'))).toMatchObject({ approved: false, source: 'ai_draft' });
    expect(answers.find((a: { question: string }) => a.question === 'What is your gender?')).toMatchObject({ approved: false, answer: '' });
  });

  it('grounding guard flags unsupported numbers and credentials', () => {
    const facts = 'Senior Engineer at Acme 2019-present. Led team of 6. BSc Mathematics.';
    expect(groundingIssues('I led a team of 6 at Acme.', facts)).toEqual([]);
    expect(groundingIssues('I have an MBA and grew revenue 300%.', facts).length).toBe(2);
  });
});

describe('cover letters and studio', () => {
  it('generates a grounded draft, renders a verified PDF attachment', async () => {
    const u = await createUser(env, 'cl@example.com');
    await completeProfile(u);
    const job = (await u.post('/api/sandbox/jobs', { scenario: 'standard' })).body.data;
    env.setAiResponder(() => 'Dear Hiring Team,\n\nI build reliable TypeScript and React systems at Analytical Engines...\n\nSincerely,\nAda Lovelace');
    const g = await u.post('/api/cover-letters/generate', { jobId: job.jobId, length: 'concise' });
    expect(g.status).toBe(201);
    expect(g.body.data).toMatchObject({ generated: true, status: 'draft' });
    expect(g.body.data.warnings).toEqual([]);
    await u.patch(`/api/cover-letters/${g.body.data.id}`, { status: 'approved' });
    const pdf = await u.post(`/api/cover-letters/${g.body.data.id}/render`);
    expect(pdf.body.data).toMatchObject({ kind: 'cover_letter', mimeType: 'application/pdf' });
  });

  it('studio gap analysis separates real skills from missing ones', async () => {
    const u = await createUser(env, 'studio@example.com');
    await completeProfile(u);
    const pdf = await renderPdf('Ada Lovelace', null, [{ text: 'Experience with React and Node.js.' }]);
    const up = await request(env.app).post('/api/documents').set('Authorization', `Bearer ${u.token}`).attach('file', pdf, 'cv.pdf');
    const job = (await u.post('/api/jobs/import', { url: 'https://example.com/j/1', title: 'Engineer', company: 'X', description: 'React, TypeScript, Kubernetes required' })).body.data;
    const a = (await u.post('/api/studio/analyze', { documentId: up.body.data.id, jobId: job.id })).body.data;
    expect(a.analysis.inResume).toEqual(['react']);
    expect(a.analysis.inProfileOnly).toEqual(['typescript']);
    expect(a.analysis.missing).toEqual(['kubernetes']);
  });
});

describe('privacy', () => {
  it('exports and deletes all personal data', async () => {
    const u = await createUser(env, 'gone@example.com');
    await completeProfile(u);
    const pdf = await renderPdf('Ada', null, [{ text: 'x'.repeat(100) }]);
    await request(env.app).post('/api/documents').set('Authorization', `Bearer ${u.token}`).attach('file', pdf, 'cv.pdf');
    const ex = await u.get('/api/account/export');
    expect(ex.body.candidate_profiles[0].firstName).toBe('Ada');
    expect(JSON.stringify(ex.body)).not.toContain('token_hash');
    const before = env.storage.files.size;
    expect((await u.del('/api/account', { confirm: 'nope' })).status).toBe(422);
    expect((await u.del('/api/account', { confirm: 'DELETE' })).status).toBe(200);
    expect(env.storage.files.size).toBe(before - 1);
    const left = await env.ctx.db.query(`select (select count(*) from candidate_profiles where user_id=$1) + (select count(*) from documents where user_id=$1) + (select count(*) from work_experiences where user_id=$1) as n`, [u.id]);
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it('public endpoints expose an honest platform matrix and no plans', async () => {
    expect((await request(env.app).get('/api/public/plans')).status).not.toBe(200);
    const platforms = (await request(env.app).get('/api/public/platforms')).body.data;
    const li = platforms.find((p: { id: string }) => p.id === 'linkedin');
    expect(li).toMatchObject({ autofill: false, autoSubmit: false, testStatus: 'manual_only' });
    expect(platforms.find((p: { id: string }) => p.id === 'greenhouse').autoSubmit).toBe(false);
    expect(platforms.find((p: { id: string }) => p.id === 'sandbox').autoSubmit).toBe(true);
  });
});

describe('automatic job discovery', () => {
  it('finds recent matching jobs from the catalogue and feeds with no setup, then queues the best', async () => {
    clearDiscoveryCache();
    const day = 86_400_000;
    const recent = new Date(Date.now() - 2 * day).toISOString();
    const old = new Date(Date.now() - 60 * day).toISOString();
    env.setBoards({
      'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs': {
        status: 200,
        json: { jobs: [
          { id: 101, title: 'Senior Frontend Engineer', absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/101', location: { name: 'Remote, US' }, first_published: recent },
          { id: 102, title: 'Frontend Engineer', absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/102', location: { name: 'Remote' }, first_published: old },
          { id: 103, title: 'Account Executive', absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/103', location: { name: 'Remote' }, first_published: recent },
          { id: 104, title: 'Frontend Engineering Intern', absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/104', location: { name: 'Remote' }, first_published: recent },
        ] },
      },
      'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs/101': { status: 200, json: { content: '&lt;p&gt;React and TypeScript&lt;/p&gt;' } },
      'https://remotive.com/api/remote-jobs': {
        status: 200,
        json: { jobs: [{ id: 9, url: 'https://remotive.com/remote-jobs/software-dev/front-end-developer-9', title: 'Front-End Developer', company_name: 'Acme', candidate_required_location: 'Worldwide', publication_date: recent, description: '<p>React</p>' }] },
      },
    });
    const u = await createUser(env, 'auto-disc@example.com');
    await completeProfile(u);
    await u.patch('/api/profile', { desiredTitles: ['Frontend Engineer'], workplaceTypes: ['remote'], yearsExperience: 6, country: 'United States' });
    await u.put('/api/automation/preferences', { mode: 'review', dailyLimit: 5, maxConcurrency: 1, minMatchScore: 0, excludedCompanies: [], excludedKeywords: [] });
    // The profile save already started a run; wait for it rather than racing it.
    // Saving the profile starts a run (and a re-run for edits made meanwhile); wait for them rather than racing.
    for (let i = 0; i < 100 && (await u.get('/api/discovery')).body.data.running; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 100 && (await u.get('/api/discovery')).body.data.running; i++) await new Promise((r) => setTimeout(r, 100));
    const s = await runDiscovery(env.ctx, u.id);
    const status = (await u.get('/api/discovery')).body.data;
    expect(status.last).toMatchObject({ status: 'ok' });
    const titles = (await u.get('/api/jobs?pageSize=50')).body.data.items.map((j: { title: string }) => j.title).sort();
    expect(titles).toEqual(['Front-End Developer', 'Senior Frontend Engineer']); // old, off-target and intern postings dropped
    const ghId = (await u.get('/api/jobs?q=Senior')).body.data.items[0].id;
    const gh = (await u.get(`/api/jobs/${ghId}`)).body.data;
    expect(gh.job?.description ?? gh.description).toMatch(/React and TypeScript/);
    expect(s?.added ?? 0, JSON.stringify(s)).toBe(0); // a second run adds nothing new
    const queued = await env.ctx.db.query(`select count(*)::int n from applications where user_id=$1 and state='QUEUED'`, [u.id]);
    expect(queued.rows[0].n).toBe(2);
  });

  it('asks for target titles when there is nothing to search for', async () => {
    clearDiscoveryCache();
    const u = await createUser(env, 'no-titles@example.com');
    const s = await runDiscovery(env.ctx, u.id);
    expect(s).toMatchObject({ status: 'needs_titles' });
  });
});

