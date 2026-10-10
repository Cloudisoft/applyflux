import { Router } from 'express';
import { z } from 'zod';
import { JobImportInput, JobSearchQuery, JobSourceInput } from '@applyflux/shared';
import type { AppContext } from '../context';
import { camel, many, one } from '../db';
import { AppError, ah, notFound } from '../lib/errors';
import type { AuthedRequest } from '../lib/auth';
import { boardFromUrl, checkPostingLive, fetchBoard } from '../services/discovery';
import { refreshMatches, searchJobs, upsertJob, upsertSourcedJobs } from '../services/jobs';
import { loadFullProfile } from '../services/profile';
import { discoveryRunning, runDiscovery } from '../services/autodiscover';
import { shortlist } from '../services/queue';

export function jobRoutes(ctx: AppContext) {
  const r = Router();

  r.get(
    '/jobs',
    ah<AuthedRequest>(async (req, res) => {
      const q = JobSearchQuery.parse(req.query);
      res.json({ data: await searchJobs(ctx.db, req.user.id, q) });
    }),
  );

  r.get(
    '/jobs/:id',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const row = await one(
        ctx.db,
        `select j.*, m.score, m.breakdown, a.id as application_id, a.state as application_state
           from jobs j left join job_matches m on m.job_id=j.id left join applications a on a.job_id=j.id
          where j.id=$1 and j.user_id=$2`,
        [id, req.user.id],
      );
      if (!row) throw notFound('Job');
      const dupes = await many(ctx.db, `select id, url, title, company from jobs where user_id=$1 and fingerprint=$2 and id<>$3`, [req.user.id, row.fingerprint, id]);
      res.json({ data: { ...camel(row), duplicates: dupes.map((d) => camel(d)) } });
    }),
  );

  /** Import a single posting by URL. Details come from the person (or the extension); the server does not crawl arbitrary URLs. */
  r.post(
    '/jobs/import',
    ah<AuthedRequest>(async (req, res) => {
      const body = JobImportInput.parse(req.body);
      if (!body.title || !body.company) throw new AppError('VALIDATION_FAILED', 'Title and company are required to import a job');
      const out = await upsertJob(ctx.db, req.user.id, { origin: 'import', url: body.url, title: body.title, company: body.company, location: body.location ?? null, description: body.description ?? null });
      const full = await loadFullProfile(ctx.db, req.user.id);
      await refreshMatches(ctx.db, req.user.id, full, [out.id]);
      res.status(out.created ? 201 : 200).json({ data: out });
    }),
  );

  r.patch(
    '/jobs/:id',
    ah<AuthedRequest>(async (req, res) => {
      const body = z.object({ isBookmarked: z.boolean() }).parse(req.body);
      const r2 = await ctx.db.query('update jobs set is_bookmarked=$3 where id=$1 and user_id=$2', [z.string().uuid().parse(req.params.id), req.user.id, body.isBookmarked]);
      if (!r2.rowCount) throw notFound('Job');
      res.json({ data: { ok: true } });
    }),
  );

  r.delete(
    '/jobs/:id',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const app = await one<{ state: string }>(ctx.db, 'select state from applications where job_id=$1 and user_id=$2', [id, req.user.id]);
      if (app && !['DISCOVERED', 'SHORTLISTED', 'SKIPPED'].includes(app.state)) throw new AppError('CONFLICT', 'This job has an application history and cannot be removed');
      await ctx.db.query('delete from jobs where id=$1 and user_id=$2', [id, req.user.id]);
      res.json({ data: { ok: true } });
    }),
  );

  r.post(
    '/jobs/:id/shortlist',
    ah<AuthedRequest>(async (req, res) => {
      await shortlist(ctx.db, req.user.id, z.string().uuid().parse(req.params.id));
      res.json({ data: { ok: true } });
    }),
  );

  r.post(
    '/jobs/:id/liveness',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const job = await one<{ url: string }>(ctx.db, 'select url from jobs where id=$1 and user_id=$2', [id, req.user.id]);
      if (!job) throw notFound('Job');
      const out = await checkPostingLive(job.url, ctx.fetchJson);
      await ctx.db.query('update jobs set liveness=$2, liveness_reason=$3, liveness_checked_at=now() where id=$1', [id, out.result, out.reason]);
      res.json({ data: out });
    }),
  );

  r.post(
    '/matches/refresh',
    ah<AuthedRequest>(async (req, res) => {
      const full = await loadFullProfile(ctx.db, req.user.id);
      res.json({ data: { updated: await refreshMatches(ctx.db, req.user.id, full) } });
    }),
  );

  /* Sources ---------------------------------------------------------- */

  r.get(
    '/sources',
    ah<AuthedRequest>(async (req, res) => {
      const rows = await many(ctx.db, 'select * from job_sources where user_id=$1 order by created_at', [req.user.id]);
      res.json({ data: rows.map((x) => camel(x)) });
    }),
  );

  r.post(
    '/sources',
    ah<AuthedRequest>(async (req, res) => {
      const raw = z.object({ url: z.string().url().optional() }).passthrough().parse(req.body);
      const fromUrl = raw.url ? boardFromUrl(raw.url) : null;
      if (raw.url && !fromUrl) throw new AppError('VALIDATION_FAILED', 'Paste a Greenhouse, Lever or Ashby careers URL (e.g. https://jobs.lever.co/company)');
      const body = JobSourceInput.parse(fromUrl ? { ...fromUrl, name: (raw as { name?: string }).name } : raw);
      const row = await one(
        ctx.db,
        `insert into job_sources (user_id, kind, identifier, name) values ($1,$2,$3,$4)
         on conflict (user_id, kind, identifier) do update set enabled=true returning *`,
        [req.user.id, body.kind, body.identifier, body.name ?? body.identifier],
      );
      res.status(201).json({ data: camel(row) });
    }),
  );

  r.delete(
    '/sources/:id',
    ah<AuthedRequest>(async (req, res) => {
      await ctx.db.query('delete from job_sources where id=$1 and user_id=$2', [z.string().uuid().parse(req.params.id), req.user.id]);
      res.json({ data: { ok: true } });
    }),
  );

  /* Automatic discovery ---------------------------------------------- */

  r.get(
    '/discovery',
    ah<AuthedRequest>(async (req, res) => {
      const p = await one<{ auto_discover: boolean; auto_queue: boolean; last_discovered_at: string | null; last_discovery: unknown }>(
        ctx.db,
        'select auto_discover, auto_queue, last_discovered_at, last_discovery from automation_preferences where user_id=$1',
        [req.user.id],
      );
      res.json({ data: { running: discoveryRunning(req.user.id), autoDiscover: p?.auto_discover ?? true, autoQueue: p?.auto_queue ?? true, lastRunAt: p?.last_discovered_at ?? null, last: p?.last_discovery ?? null, intervalHours: ctx.config.DISCOVERY_INTERVAL_HOURS } });
    }),
  );

  /** "Find jobs now": runs in the background; poll GET /discovery for the result. */
  r.post(
    '/discovery/run',
    ah<AuthedRequest>(async (req, res) => {
      void runDiscovery(ctx, req.user.id);
      res.status(202).json({ data: { running: true } });
    }),
  );

  r.put(
    '/discovery/settings',
    ah<AuthedRequest>(async (req, res) => {
      const b = z.object({ autoDiscover: z.boolean().optional(), autoQueue: z.boolean().optional() }).parse(req.body);
      await ctx.db.query(
        'update automation_preferences set auto_discover = coalesce($2, auto_discover), auto_queue = coalesce($3, auto_queue) where user_id=$1',
        [req.user.id, b.autoDiscover ?? null, b.autoQueue ?? null],
      );
      res.json({ data: { ok: true } });
    }),
  );

  r.post(
    '/sources/:id/sync',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const src = await one<{ id: string; kind: 'greenhouse' | 'lever' | 'ashby'; identifier: string; name: string }>(ctx.db, 'select * from job_sources where id=$1 and user_id=$2', [id, req.user.id]);
      if (!src) throw notFound('Source');
      try {
        const jobs = await fetchBoard(src.kind, src.identifier, src.name, ctx.fetchJson);
        const out = await upsertSourcedJobs(ctx.db, req.user.id, src.id, jobs);
        await ctx.db.query('update job_sources set last_synced_at=now(), last_error=null, last_job_count=$2 where id=$1', [id, jobs.length]);
        const full = await loadFullProfile(ctx.db, req.user.id);
        await refreshMatches(ctx.db, req.user.id, full);
        res.json({ data: out });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Sync failed';
        await ctx.db.query('update job_sources set last_error=$2, last_synced_at=now() where id=$1', [id, msg.slice(0, 300)]);
        throw new AppError('SOURCE_FAILED', msg);
      }
    }),
  );

  /* Saved searches --------------------------------------------------- */

  r.get(
    '/saved-searches',
    ah<AuthedRequest>(async (req, res) => {
      const rows = await many(ctx.db, 'select * from saved_searches where user_id=$1 order by created_at desc', [req.user.id]);
      res.json({ data: rows.map((x) => camel(x)) });
    }),
  );
  r.post(
    '/saved-searches',
    ah<AuthedRequest>(async (req, res) => {
      const body = z.object({ name: z.string().trim().min(1).max(120), query: JobSearchQuery.partial() }).parse(req.body);
      const row = await one(ctx.db, 'insert into saved_searches (user_id, name, query) values ($1,$2,$3) returning *', [req.user.id, body.name, JSON.stringify(body.query)]);
      res.status(201).json({ data: camel(row) });
    }),
  );
  r.delete(
    '/saved-searches/:id',
    ah<AuthedRequest>(async (req, res) => {
      await ctx.db.query('delete from saved_searches where id=$1 and user_id=$2', [z.string().uuid().parse(req.params.id), req.user.id]);
      res.json({ data: { ok: true } });
    }),
  );

  return r;
}
