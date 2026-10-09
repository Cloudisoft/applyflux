import express, { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { AppContext } from '../context';
import { ah, notFound } from '../lib/errors';
import { randomToken, type AuthedRequest } from '../lib/auth';
import { upsertJob, refreshMatches } from '../services/jobs';
import { loadFullProfile } from '../services/profile';
import { SCENARIOS, applyPage, postingPage, thanksPage, type Scenario } from './pages';

/** In-memory counters only (no personal data) so tests can assert "submitted exactly once". */
const submissions = new Map<string, number>();
const rejectedOnce = new Set<string>();

export function sandboxPages() {
  const r = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 2 } });
  const scenario = (s: string): Scenario => {
    if (!(s in SCENARIOS)) throw notFound('Sandbox scenario');
    return s as Scenario;
  };
  const ref = (q: unknown) => z.string().max(64).regex(/^[\w-]*$/).catch('').parse(q);

  r.use((_req, res, next) => {
    // Sandbox pages carry their own inline script; relax CSP for this path only.
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'");
    res.setHeader('x-robots-tag', 'noindex');
    next();
  });
  r.get('/jobs/:scenario', (req, res) => res.type('html').send(postingPage(scenario(req.params.scenario), ref(req.query.ref))));
  r.get('/jobs/:scenario/apply', (req, res) => res.type('html').send(applyPage(scenario(req.params.scenario), ref(req.query.ref))));
  r.post('/jobs/:scenario/submit', upload.any(), express.urlencoded({ extended: false }), (req, res) => {
    const s = scenario(req.params.scenario);
    const key = `${s}:${ref(req.query.ref)}`;
    if (s === 'validation-error' && !rejectedOnce.has(key)) {
      rejectedOnce.add(key);
      return res
        .status(422)
        .type('html')
        .send(applyPage(s, ref(req.query.ref)).replace('<div id="form-error" class="error" role="alert"></div>', '<div id="form-error" class="error" role="alert">Phone number is required for this role. Please correct the errors and resubmit.</div>'));
    }
    submissions.set(key, (submissions.get(key) ?? 0) + 1);
    res.redirect(303, `/sandbox/jobs/${s}/${s === 'no-confirmation' ? 'careers' : 'confirmation'}?ref=${encodeURIComponent(ref(req.query.ref))}`);
  });
  r.get('/jobs/:scenario/confirmation', (req, res) => res.type('html').send(thanksPage(scenario(req.params.scenario))));
  r.get('/jobs/:scenario/careers', (req, res) => res.type('html').send(thanksPage(scenario(req.params.scenario))));
  r.get('/_stats', (req, res) => {
    const k = z.string().max(120).parse(req.query.key ?? '');
    res.json({ submissions: submissions.get(k) ?? 0 });
  });
  return r;
}

/** Authenticated: create sandbox jobs in the person's own job list for a test run. */
export function sandboxApi(ctx: AppContext) {
  const r = Router();
  r.get('/sandbox/scenarios', (_req, res) => res.json({ data: Object.entries(SCENARIOS).map(([id, s]) => ({ id, ...s })) }));
  r.post(
    '/sandbox/jobs',
    ah<AuthedRequest>(async (req, res) => {
      const b = z.object({ scenario: z.enum(Object.keys(SCENARIOS) as [Scenario, ...Scenario[]]).default('standard') }).parse(req.body);
      const ref = randomToken(6).replace(/[^\w-]/g, '');
      const url = `${ctx.config.PUBLIC_API_URL.replace(/\/$/, '')}/sandbox/jobs/${b.scenario}/apply?ref=${ref}`;
      const s = SCENARIOS[b.scenario];
      const out = await upsertJob(ctx.db, req.user.id, {
        origin: 'import',
        url,
        title: `${s.title} (Sandbox)`,
        company: 'Northwind Labs (ApplyFlux Sandbox)',
        location: 'Remote (Europe)',
        workplaceType: 'remote',
        employmentType: 'full_time',
        description: `ApplyFlux Sandbox test posting. ${s.note}. TypeScript, React, Node.js, PostgreSQL, AWS, CI/CD, communication, stakeholder management.`,
      });
      await refreshMatches(ctx.db, req.user.id, await loadFullProfile(ctx.db, req.user.id), [out.id]);
      res.status(201).json({ data: { jobId: out.id, url, ref } });
    }),
  );
  return r;
}
