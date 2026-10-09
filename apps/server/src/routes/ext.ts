import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AnswerRequest, ExtensionReport } from '@applyflux/shared';
import type { AppContext } from '../context';
import { one, tx } from '../db';
import { AppError, ah, notFound } from '../lib/errors';
import { randomToken, requireExtension, sha256, verifyDownload, type ExtRequest } from '../lib/auth';
import { resolveAnswers } from '../services/answers';
import { claimNext, handleReport, heartbeat } from '../services/queue';
import { upsertJob, refreshMatches } from '../services/jobs';
import { loadFullProfile } from '../services/profile';
import { audit } from '../services/notify';

/**
 * Endpoints used only by the ApplyFlux browser extension. Documented in
 * docs/EXTENSION_PROTOCOL.md. Authentication is a revocable, 90-day opaque
 * token obtained by exchanging a one-time pairing code; it carries no
 * Supabase credentials.
 */
export function extRoutes(ctx: AppContext) {
  const r = Router();
  const pairLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  r.post(
    '/pair',
    pairLimiter,
    ah(async (req, res) => {
      const b = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/), name: z.string().max(60).default('Chrome'), version: z.string().max(20).optional() }).parse(req.body);
      const code = b.code.replace('-', '');
      const out = await tx(ctx.db, async (c) => {
        const row = await one<{ user_id: string; expires_at: Date; used_at: Date | null }>(c, 'select * from extension_pairing_codes where code_hash=$1 for update', [sha256(code)]);
        if (!row || row.used_at || row.expires_at < new Date()) throw new AppError('UNAUTHENTICATED', 'That pairing code is invalid or expired. Generate a new one in ApplyFlux.');
        await c.query('update extension_pairing_codes set used_at=now() where code_hash=$1', [sha256(code)]);
        const token = randomToken(32);
        const conn = await one<{ id: string }>(
          c,
          `insert into extension_connections (user_id, name, token_hash, extension_version, user_agent, expires_at) values ($1,$2,$3,$4,$5, now() + interval '90 days') returning id`,
          [row.user_id, b.name, sha256(token), b.version ?? null, req.header('user-agent')?.slice(0, 300) ?? null],
        );
        await audit(c, row.user_id, 'extension.paired', { type: 'extension', id: conn!.id });
        return { token, connectionId: conn!.id, userId: row.user_id };
      });
      res.status(201).json({ data: { token: out.token, connectionId: out.connectionId } });
    }),
  );

  // Signed download links (HMAC, 10 minutes) — no bearer token needed so fetch() from the service worker stays simple.
  r.get(
    '/documents/:id',
    ah(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const q = z.object({ u: z.string().uuid(), e: z.string(), s: z.string() }).parse(req.query);
      if (!verifyDownload(ctx.config.DOWNLOAD_SIGNING_SECRET, id, q.u, q.e, q.s)) throw new AppError('FORBIDDEN', 'Download link expired');
      const d = await one<{ storage_path: string; mime_type: string; file_name: string }>(ctx.db, 'select storage_path, mime_type, file_name from documents where id=$1 and user_id=$2', [id, q.u]);
      if (!d) throw notFound('Document');
      res.setHeader('content-type', d.mime_type);
      res.setHeader('content-disposition', `attachment; filename="${d.file_name.replace(/"/g, '')}"`);
      res.setHeader('cache-control', 'private, no-store');
      res.send(await ctx.storage.get(d.storage_path));
    }),
  );

  r.use(requireExtension(ctx.db, ctx.config));

  r.get(
    '/session',
    ah<ExtRequest>(async (req, res) => {
      const run = await one(ctx.db, `select status, mode from automation_runs where user_id=$1 and status in ('running','paused') limit 1`, [req.user.id]);
      const counts = await one(
        ctx.db,
        `select count(*) filter (where state='QUEUED')::int as queued, count(*) filter (where state in ('AWAITING_HUMAN_VERIFICATION','AWAITING_REVIEW','NEEDS_ATTENTION'))::int as attention from applications where user_id=$1`,
        [req.user.id],
      );
      const prof = await one<{ first_name: string | null }>(ctx.db, 'select first_name from candidate_profiles where user_id=$1', [req.user.id]);
      res.json({ data: { connectionId: req.connectionId, run, counts, firstName: prof?.first_name ?? null } });
    }),
  );

  r.post('/next', ah<ExtRequest>(async (req, res) => res.json({ data: await claimNext(ctx.db, ctx.config, req.user.id, req.connectionId) })));

  r.post(
    '/applications/:id/heartbeat',
    ah<ExtRequest>(async (req, res) => res.json({ data: await heartbeat(ctx.db, req.user.id, req.connectionId, z.string().uuid().parse(req.params.id)) })),
  );

  r.post(
    '/applications/:id/report',
    ah<ExtRequest>(async (req, res) => {
      const report = ExtensionReport.parse(req.body);
      res.json({ data: await handleReport(ctx.db, req.user.id, req.connectionId, z.string().uuid().parse(req.params.id), report) });
    }),
  );

  r.post(
    '/answers',
    ah<ExtRequest>(async (req, res) => {
      const body = AnswerRequest.parse(req.body);
      const app = await one(ctx.db, 'select lease_connection_id from applications where id=$1 and user_id=$2', [body.applicationId, req.user.id]);
      if (!app) throw notFound('Application');
      if (app.lease_connection_id !== req.connectionId) throw new AppError('LEASE_LOST', 'This browser no longer holds this application');
      res.json({ data: await resolveAnswers(ctx.db, ctx.ai, req.user.id, body) });
    }),
  );

  /** "Save this job" from the page the person is viewing. Only the posting's own details are sent. */
  r.post(
    '/jobs',
    ah<ExtRequest>(async (req, res) => {
      const b = z.object({ url: z.string().url().max(2000), title: z.string().trim().min(1).max(300), company: z.string().trim().min(1).max(200), location: z.string().max(300).optional(), description: z.string().max(60000).optional() }).parse(req.body);
      const out = await upsertJob(ctx.db, req.user.id, { origin: 'extension', ...b });
      await refreshMatches(ctx.db, req.user.id, await loadFullProfile(ctx.db, req.user.id), [out.id]);
      res.status(out.created ? 201 : 200).json({ data: out });
    }),
  );

  r.post(
    '/disconnect',
    ah<ExtRequest>(async (req, res) => {
      await ctx.db.query('update extension_connections set revoked_at=now() where id=$1', [req.connectionId]);
      res.json({ data: { ok: true } });
    }),
  );

  return r;
}
