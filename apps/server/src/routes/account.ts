import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context';
import { camel, many, one, tx } from '../db';
import { AppError, ah } from '../lib/errors';
import { randomToken, sha256, type AuthedRequest } from '../lib/auth';
import { audit } from '../services/notify';
import { usageSummary } from '../services/usage';

export function accountRoutes(ctx: AppContext) {
  const r = Router();

  r.get(
    '/notifications',
    ah<AuthedRequest>(async (req, res) => {
      const rows = await many(ctx.db, 'select * from notifications where user_id=$1 order by created_at desc limit 100', [req.user.id]);
      const unread = await one<{ n: number }>(ctx.db, 'select count(*)::int as n from notifications where user_id=$1 and read_at is null', [req.user.id]);
      res.json({ data: { items: rows.map((x) => camel(x)), unread: unread!.n } });
    }),
  );

  r.post(
    '/notifications/read',
    ah<AuthedRequest>(async (req, res) => {
      const b = z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).parse(req.body);
      if (b.ids) await ctx.db.query('update notifications set read_at=now() where user_id=$1 and id = any($2::uuid[]) and read_at is null', [req.user.id, b.ids]);
      else await ctx.db.query('update notifications set read_at=now() where user_id=$1 and read_at is null', [req.user.id]);
      res.json({ data: { ok: true } });
    }),
  );

  r.get('/usage', ah<AuthedRequest>(async (req, res) => res.json({ data: await usageSummary(ctx.db, req.user.id) })));

  /* Extension connections ---------------------------------------------- */

  r.get(
    '/extension/connections',
    ah<AuthedRequest>(async (req, res) => {
      const rows = await many(ctx.db, 'select id, name, extension_version, user_agent, created_at, last_seen_at, expires_at, revoked_at from extension_connections where user_id=$1 order by created_at desc', [req.user.id]);
      res.json({ data: rows.map((x) => camel(x)) });
    }),
  );

  /** One-time pairing code shown in the web app and typed (or sent) into the extension. */
  r.post(
    '/extension/pairing-code',
    ah<AuthedRequest>(async (req, res) => {
      const recent = await one<{ n: number }>(ctx.db, `select count(*)::int as n from extension_pairing_codes where user_id=$1 and created_at > now() - interval '10 minutes'`, [req.user.id]);
      if (recent!.n >= 10) throw new AppError('RATE_LIMITED', 'Too many pairing codes. Wait a few minutes.');
      // 8 chars from an unambiguous alphabet; single use; 10 minute expiry; attempts limited.
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const bytes = randomToken(16);
      let code = '';
      for (let i = 0; code.length < 8; i++) code += alphabet[bytes.charCodeAt(i % bytes.length) % alphabet.length];
      await ctx.db.query(`insert into extension_pairing_codes (code_hash, user_id, expires_at) values ($1,$2, now() + interval '10 minutes')`, [sha256(code), req.user.id]);
      res.status(201).json({ data: { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresInSeconds: 600 } });
    }),
  );

  r.delete(
    '/extension/connections/:id',
    ah<AuthedRequest>(async (req, res) => {
      await ctx.db.query('update extension_connections set revoked_at=now() where id=$1 and user_id=$2 and revoked_at is null', [z.string().uuid().parse(req.params.id), req.user.id]);
      // Anything the revoked browser was holding is recovered by the lease sweeper.
      await audit(ctx.db, req.user.id, 'extension.revoked', { type: 'extension', id: req.params.id });
      res.json({ data: { ok: true } });
    }),
  );

  /* Privacy: export & deletion ----------------------------------------- */

  r.get(
    '/account/export',
    ah<AuthedRequest>(async (req, res) => {
      const uid = req.user.id;
      const tables = ['profiles', 'candidate_profiles', 'work_experiences', 'educations', 'certifications', 'projects', 'saved_answers', 'cover_letters', 'jobs', 'job_matches', 'saved_searches', 'applications', 'application_events', 'automation_preferences', 'automation_runs', 'notifications', 'usage_ledger', 'job_sources', 'resume_parses', 'resume_tailorings'];
      const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), userId: uid, email: req.user.email };
      for (const t of tables) out[t] = (await many(ctx.db, `select * from ${t} where user_id=$1`, [uid])).map((x) => camel(x));
      out.documents = (await many(ctx.db, 'select id, kind, title, file_name, mime_type, size_bytes, version, created_at, parsed_text from documents where user_id=$1', [uid])).map((x) => camel(x));
      out.extension_connections = (await many(ctx.db, 'select id, name, created_at, last_seen_at, revoked_at from extension_connections where user_id=$1', [uid])).map((x) => camel(x));
      await audit(ctx.db, uid, 'account.export');
      res.setHeader('content-disposition', `attachment; filename="applyflux-export-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(out);
    }),
  );

  /** Deletes all data and files, then the auth user. Irreversible. */
  r.delete(
    '/account',
    ah<AuthedRequest>(async (req, res) => {
      z.object({ confirm: z.literal('DELETE') }).parse(req.body);
      const uid = req.user.id;
      const docs = await many<{ storage_path: string }>(ctx.db, 'select storage_path from documents where user_id=$1', [uid]);
      await ctx.storage.remove(docs.map((d) => d.storage_path));
      await tx(ctx.db, async (c) => {
        await audit(c, uid, 'account.deleted');
        for (const t of ['application_events', 'applications', 'notifications', 'usage_ledger', 'job_matches', 'jobs', 'job_sources', 'saved_searches', 'cover_letters', 'resume_tailorings', 'resume_parses', 'documents', 'saved_answers', 'work_experiences', 'educations', 'certifications', 'projects', 'automation_runs', 'extension_connections', 'extension_pairing_codes', 'automation_preferences', 'candidate_profiles', 'subscriptions', 'profiles'])
          await c.query(`delete from ${t} where user_id=$1`, [uid]);
      });
      if (ctx.supabaseAdmin) {
        const { error } = await ctx.supabaseAdmin.auth.admin.deleteUser(uid);
        if (error) throw new AppError('INTERNAL', 'Your data was deleted, but removing the sign-in account failed. Contact support.');
      }
      res.json({ data: { deleted: true } });
    }),
  );

  return r;
}
