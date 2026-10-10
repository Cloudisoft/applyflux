import { Router } from 'express';
import { z } from 'zod';
import { assessProfile } from '@applyflux/shared';
import type { AppContext } from '../context';
import { camel, one, tx } from '../db';
import { ah } from '../lib/errors';
import type { AuthedRequest } from '../lib/auth';
import {
  deleteSectionItem,
  ensureProfileRows,
  insertSectionItem,
  loadFullProfile,
  updateProfile,
  updateSectionItem,
  verifyFields,
} from '../services/profile';
import { runDiscovery } from '../services/autodiscover';
import { refreshMatches } from '../services/jobs';

const SECTION = z.enum(['experiences', 'educations', 'certifications', 'projects']);
const ONBOARDING_STEPS = ['resume', 'review', 'details', 'preferences', 'automation', 'extension', 'test', 'discover', 'done'] as const;

export function profileRoutes(ctx: AppContext) {
  const r = Router();

  r.get(
    '/me',
    ah<AuthedRequest>(async (req, res) => {
      await ensureProfileRows(ctx.db, req.user.id, req.user.email);
      const p = await one(ctx.db, 'select display_name, onboarding_step, onboarding_completed_at, timezone from profiles where user_id=$1', [req.user.id]);
      const full = await loadFullProfile(ctx.db, req.user.id);
      const ext = await one(ctx.db, `select count(*)::int as n from extension_connections where user_id=$1 and revoked_at is null and expires_at > now()`, [req.user.id]);
      const docs = await one(ctx.db, `select count(*)::int as n from documents where user_id=$1 and kind='resume'`, [req.user.id]);
      const sandbox = await one(
        ctx.db,
        `select count(*)::int as n from applications a join jobs j on j.id=a.job_id where a.user_id=$1 and j.url like $2 and a.state in ('SUBMITTED','SUBMISSION_UNVERIFIED','AWAITING_REVIEW')`,
        [req.user.id, `${ctx.config.PUBLIC_API_URL.replace(/\/$/, '')}/sandbox/%`],
      );
      res.json({
        data: {
          user: { id: req.user.id, email: req.user.email },
          account: camel(p),
          assessment: assessProfile(full),
          setup: {
            hasResume: (docs!.n as number) > 0,
            extensionConnected: (ext!.n as number) > 0,
            sandboxTested: (sandbox!.n as number) > 0,
          },
          aiConfigured: ctx.ai.configured,
        },
      });
    }),
  );

  r.patch(
    '/me',
    ah<AuthedRequest>(async (req, res) => {
      const body = z
        .object({ displayName: z.string().trim().max(120).optional(), onboardingStep: z.enum(ONBOARDING_STEPS).optional(), timezone: z.string().max(60).optional() })
        .parse(req.body);
      await ctx.db.query(
        `update profiles set display_name = coalesce($2, display_name), onboarding_step = coalesce($3, onboarding_step),
           onboarding_completed_at = case when $3 = 'done' then coalesce(onboarding_completed_at, now()) else onboarding_completed_at end,
           timezone = coalesce($4, timezone) where user_id = $1`,
        [req.user.id, body.displayName ?? null, body.onboardingStep ?? null, body.timezone ?? null],
      );
      res.json({ data: { ok: true } });
    }),
  );

  r.get(
    '/profile',
    ah<AuthedRequest>(async (req, res) => {
      await ensureProfileRows(ctx.db, req.user.id, req.user.email);
      const full = await loadFullProfile(ctx.db, req.user.id);
      res.json({ data: { ...full, assessment: assessProfile(full) } });
    }),
  );

  r.patch(
    '/profile',
    ah<AuthedRequest>(async (req, res) => {
      const body = z.record(z.string(), z.unknown()).parse(req.body);
      // A user edit is a user-sourced, verified fact for every field they touched.
      const touched = Object.keys(body).filter((k) => k !== 'fieldMeta' && k !== 'verify');
      await tx(ctx.db, async (c) => {
        await updateProfile(c, req.user.id, body as never);
        if (touched.length && body.verify !== false) await verifyFields(c, req.user.id, touched, true);
      });
      const full = await loadFullProfile(ctx.db, req.user.id);
      await refreshMatches(ctx.db, req.user.id, full);
      // New target titles or locations: look for matching jobs right away, in the background.
      if (['desiredTitles', 'desiredLocations', 'workplaceTypes'].some((k) => k in body)) void runDiscovery(ctx, req.user.id);
      res.json({ data: { ...full, assessment: assessProfile(full) } });
    }),
  );

  r.post(
    '/profile/verify',
    ah<AuthedRequest>(async (req, res) => {
      const body = z.object({ fields: z.array(z.string().max(60)).min(1).max(60), verified: z.boolean().default(true) }).parse(req.body);
      await verifyFields(ctx.db, req.user.id, body.fields, body.verified);
      const full = await loadFullProfile(ctx.db, req.user.id);
      res.json({ data: { ...full, assessment: assessProfile(full) } });
    }),
  );

  r.post(
    '/profile/:section',
    ah<AuthedRequest>(async (req, res) => {
      const section = SECTION.parse(req.params.section);
      const id = await insertSectionItem(ctx.db, req.user.id, section, { source: 'user', verified: true, ...req.body });
      res.status(201).json({ data: { id } });
    }),
  );

  r.patch(
    '/profile/:section/:id',
    ah<AuthedRequest>(async (req, res) => {
      const section = SECTION.parse(req.params.section);
      const id = z.string().uuid().parse(req.params.id);
      await updateSectionItem(ctx.db, req.user.id, section, id, req.body);
      res.json({ data: { ok: true } });
    }),
  );

  r.delete(
    '/profile/:section/:id',
    ah<AuthedRequest>(async (req, res) => {
      const section = SECTION.parse(req.params.section);
      await deleteSectionItem(ctx.db, req.user.id, section, z.string().uuid().parse(req.params.id));
      res.json({ data: { ok: true } });
    }),
  );

  return r;
}
