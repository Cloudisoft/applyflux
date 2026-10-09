import { Router } from 'express';
import { z } from 'zod';
import {
  APPLICATION_STATES,
  AUTO_SUBMIT_CONSENT_TEXT,
  AUTO_SUBMIT_CONSENT_VERSION,
  AutomationPreferencesInput,
  assessProfile,
} from '@applyflux/shared';
import type { AppContext } from '../context';
import { camel, many, one } from '../db';
import { AppError, ah, notFound } from '../lib/errors';
import type { AuthedRequest } from '../lib/auth';
import { currentRun, enqueueJobs, pauseRun, startRun, stopRun, userAction } from '../services/queue';
import { audit } from '../services/notify';
import { loadFullProfile } from '../services/profile';
import { planFor, usageSummary } from '../services/usage';

const ACTION = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry') }),
  z.object({ action: z.literal('skip'), reason: z.string().max(300).optional() }),
  z.object({ action: z.literal('approve_submit') }),
  z.object({ action: z.literal('mark_submitted_manually'), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('confirm_submitted'), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('set_outcome'), outcome: z.enum(['INTERVIEW', 'REJECTED', 'WITHDRAWN']) }),
  z.object({ action: z.literal('dequeue') }),
  z.object({ action: z.literal('stop') }),
]);

const APP_SELECT = `select a.id, a.state, a.mode, a.priority, a.attempts, a.max_attempts, a.current_step, a.progress, a.adapter, a.intervention, a.last_error,
  a.submit_attempted_at, a.submitted_at, a.state_changed_at, a.created_at, a.updated_at, a.resume_document_id, a.cover_letter_id, a.verification_challenges,
  a.submit_approved_at, j.id as job_id, j.title, j.company, j.url, j.location, j.ats_vendor, m.score
  from applications a join jobs j on j.id = a.job_id left join job_matches m on m.job_id = j.id`;

export function applicationRoutes(ctx: AppContext) {
  const r = Router();

  r.get(
    '/applications',
    ah<AuthedRequest>(async (req, res) => {
      const q = z
        .object({
          state: z.union([z.enum(APPLICATION_STATES), z.array(z.enum(APPLICATION_STATES))]).optional(),
          q: z.string().max(200).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      const states = q.state ? (Array.isArray(q.state) ? q.state : [q.state]) : null;
      const params: unknown[] = [req.user.id];
      let where = 'a.user_id = $1';
      if (states) {
        params.push(states);
        where += ` and a.state = any($${params.length}::application_state[])`;
      }
      if (q.q) {
        params.push(`%${q.q}%`);
        where += ` and (j.title ilike $${params.length} or j.company ilike $${params.length})`;
      }
      const total = await one<{ n: string }>(ctx.db, `select count(*) as n from applications a join jobs j on j.id=a.job_id where ${where}`, params);
      const rows = await many(ctx.db, `${APP_SELECT} where ${where} order by a.updated_at desc limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`, params);
      res.json({ data: { items: rows.map((x) => camel(x)), total: Number(total!.n), page: q.page, pageSize: q.pageSize } });
    }),
  );

  r.get(
    '/applications/:id',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const row = await one(ctx.db, `${APP_SELECT.replace('a.verification_challenges,', 'a.verification_challenges, a.fields, a.submission_evidence, a.notes,')} where a.id=$1 and a.user_id=$2`, [id, req.user.id]);
      if (!row) throw notFound('Application');
      const events = await many(ctx.db, 'select id, type, from_state, to_state, actor, message, data, created_at from application_events where application_id=$1 order by id', [id]);
      res.json({ data: { ...camel(row), events: events.map((e) => camel(e)) } });
    }),
  );

  r.post(
    '/applications/enqueue',
    ah<AuthedRequest>(async (req, res) => {
      const body = z.object({ jobIds: z.array(z.string().uuid()).min(1).max(200), resumeDocumentId: z.string().uuid().nullish(), priority: z.number().int().min(-10).max(10).optional() }).parse(req.body);
      if (body.resumeDocumentId) {
        const d = await one(ctx.db, `select 1 from documents where id=$1 and user_id=$2 and kind='resume'`, [body.resumeDocumentId, req.user.id]);
        if (!d) throw notFound('Resume');
      }
      res.json({ data: await enqueueJobs(ctx.db, req.user.id, body.jobIds, body) });
    }),
  );

  r.post(
    '/applications/:id/actions',
    ah<AuthedRequest>(async (req, res) => {
      const act = ACTION.parse(req.body);
      res.json({ data: await userAction(ctx.db, req.user.id, z.string().uuid().parse(req.params.id), act) });
    }),
  );

  r.patch(
    '/applications/:id',
    ah<AuthedRequest>(async (req, res) => {
      const body = z.object({ notes: z.string().max(5000).nullable().optional(), resumeDocumentId: z.string().uuid().nullable().optional(), coverLetterId: z.string().uuid().nullable().optional() }).parse(req.body);
      const id = z.string().uuid().parse(req.params.id);
      if (body.resumeDocumentId && !(await one(ctx.db, `select 1 from documents where id=$1 and user_id=$2 and kind='resume'`, [body.resumeDocumentId, req.user.id]))) throw notFound('Resume');
      if (body.coverLetterId && !(await one(ctx.db, `select 1 from cover_letters where id=$1 and user_id=$2`, [body.coverLetterId, req.user.id]))) throw notFound('Cover letter');
      const r2 = await ctx.db.query(
        `update applications set notes = case when $3 then $4 else notes end,
            resume_document_id = case when $5 then $6::uuid else resume_document_id end,
            cover_letter_id = case when $7 then $8::uuid else cover_letter_id end
          where id=$1 and user_id=$2 and state in ('DISCOVERED','SHORTLISTED','QUEUED','NEEDS_ATTENTION','FAILED','SKIPPED','SUBMITTED','SUBMISSION_UNVERIFIED','INTERVIEW')`,
        [id, req.user.id, 'notes' in body, body.notes ?? null, 'resumeDocumentId' in body, body.resumeDocumentId ?? null, 'coverLetterId' in body, body.coverLetterId ?? null],
      );
      if (!r2.rowCount) throw new AppError('CONFLICT', 'Application cannot be edited while it is running');
      res.json({ data: { ok: true } });
    }),
  );

  /* Dashboard -------------------------------------------------------- */

  r.get(
    '/dashboard',
    ah<AuthedRequest>(async (req, res) => {
      const uid = req.user.id;
      const counts = await many<{ state: string; n: number }>(ctx.db, 'select state, count(*)::int as n from applications where user_id=$1 group by state', [uid]);
      const byState = Object.fromEntries(APPLICATION_STATES.map((s) => [s, 0])) as Record<string, number>;
      for (const c of counts) byState[c.state] = c.n;
      const t = await one<Record<string, number>>(
        ctx.db,
        `select
          (select count(*)::int from applications where user_id=$1 and state in ('SUBMITTED','SUBMISSION_UNVERIFIED','INTERVIEW','REJECTED','WITHDRAWN') and submitted_at >= date_trunc('day', now())) as submitted_today,
          (select count(*)::int from applications where user_id=$1 and state in ('SUBMITTED','SUBMISSION_UNVERIFIED','INTERVIEW','REJECTED','WITHDRAWN') and submitted_at >= now() - interval '7 days') as submitted_week,
          (select count(*)::int from jobs where user_id=$1) as jobs_discovered,
          (select count(*)::int from jobs where user_id=$1 and created_at >= now() - interval '7 days') as jobs_discovered_week`,
        [uid],
      );
      const recent = await many(
        ctx.db,
        `select e.id, e.type, e.message, e.to_state, e.created_at, e.application_id, j.title, j.company
           from application_events e join applications a on a.id=e.application_id join jobs j on j.id=a.job_id
          where e.user_id=$1 and e.type <> 'progress' order by e.id desc limit 15`,
        [uid],
      );
      const attention = await many(ctx.db, `${APP_SELECT} where a.user_id=$1 and a.state in ('AWAITING_HUMAN_VERIFICATION','AWAITING_REVIEW','NEEDS_ATTENTION') order by a.state_changed_at desc limit 20`, [uid]);
      const full = await loadFullProfile(ctx.db, uid);
      const run = await currentRun(ctx.db, uid);
      res.json({
        data: {
          byState,
          submittedToday: t!.submitted_today,
          submittedThisWeek: t!.submitted_week,
          jobsDiscovered: t!.jobs_discovered,
          jobsDiscoveredThisWeek: t!.jobs_discovered_week,
          confirmedSubmissions: byState.SUBMITTED,
          unverifiedSubmissions: byState.SUBMISSION_UNVERIFIED,
          interviews: byState.INTERVIEW,
          responses: byState.INTERVIEW + byState.REJECTED,
          profileCompleteness: assessProfile(full).completeness,
          usage: await usageSummary(ctx.db, uid),
          recentActivity: recent.map((x) => camel(x)),
          attention: attention.map((x) => camel(x)),
          run: run ? camel(run) : null,
        },
      });
    }),
  );

  /* Automation -------------------------------------------------------- */

  r.get(
    '/automation',
    ah<AuthedRequest>(async (req, res) => {
      const prefs = await one(ctx.db, 'select * from automation_preferences where user_id=$1', [req.user.id]);
      const run = await currentRun(ctx.db, req.user.id);
      const active = await many(ctx.db, `${APP_SELECT} where a.user_id=$1 and a.state in ('IN_PROGRESS','AWAITING_HUMAN_VERIFICATION','AWAITING_REVIEW') order by a.state_changed_at`, [req.user.id]);
      const plan = await planFor(ctx.db, req.user.id);
      const runCounts = run
        ? await many<{ state: string; n: number }>(ctx.db, `select state, count(*)::int as n from applications where run_id=$1 group by state`, [run.id])
        : [];
      res.json({
        data: {
          preferences: camel(prefs),
          run: run ? camel(run) : null,
          runCounts: Object.fromEntries(runCounts.map((c) => [c.state, c.n])),
          active: active.map((x) => camel(x)),
          plan,
          consent: { text: AUTO_SUBMIT_CONSENT_TEXT, version: AUTO_SUBMIT_CONSENT_VERSION },
          autoSubmitPlatforms: ctx.config.AUTO_SUBMIT_PLATFORMS.split(',').map((s) => s.trim()),
        },
      });
    }),
  );

  r.put(
    '/automation/preferences',
    ah<AuthedRequest>(async (req, res) => {
      const p = AutomationPreferencesInput.parse(req.body);
      const plan = await planFor(ctx.db, req.user.id);
      if (p.mode === 'auto' && !plan.auto_mode_allowed) throw new AppError('FORBIDDEN', `Auto Mode is not included in the ${plan.name} plan`);
      if (p.defaultResumeId && !(await one(ctx.db, `select 1 from documents where id=$1 and user_id=$2 and kind='resume'`, [p.defaultResumeId, req.user.id]))) throw notFound('Resume');
      await ctx.db.query(
        `update automation_preferences set mode=$2, daily_limit=$3, max_concurrency=$4, min_match_score=$5, excluded_companies=$6, excluded_keywords=$7,
           require_sponsorship_friendly=$8, notify_browser=$9, default_resume_id=$10, cover_letter_policy=$11 where user_id=$1`,
        [req.user.id, p.mode, Math.min(p.dailyLimit, plan.daily_application_limit), Math.min(p.maxConcurrency, plan.max_concurrency), p.minMatchScore, p.excludedCompanies, p.excludedKeywords, p.requireSponsorshipFriendly, p.notifyBrowser, p.defaultResumeId ?? null, p.coverLetterPolicy],
      );
      await audit(ctx.db, req.user.id, 'automation.preferences', undefined, { mode: p.mode });
      res.json({ data: camel(await one(ctx.db, 'select * from automation_preferences where user_id=$1', [req.user.id])) });
    }),
  );

  r.post(
    '/automation/consent',
    ah<AuthedRequest>(async (req, res) => {
      const body = z.object({ version: z.literal(AUTO_SUBMIT_CONSENT_VERSION), accepted: z.literal(true) }).parse(req.body);
      await ctx.db.query('update automation_preferences set auto_submit_consent_at=now(), auto_submit_consent_version=$2 where user_id=$1', [req.user.id, body.version]);
      await audit(ctx.db, req.user.id, 'automation.consent_granted', undefined, { version: body.version });
      res.json({ data: { ok: true } });
    }),
  );

  r.delete(
    '/automation/consent',
    ah<AuthedRequest>(async (req, res) => {
      await ctx.db.query(`update automation_preferences set auto_submit_consent_at=null, auto_submit_consent_version=null, mode = case when mode='auto' then 'assisted' else mode end where user_id=$1`, [req.user.id]);
      await audit(ctx.db, req.user.id, 'automation.consent_revoked');
      res.json({ data: { ok: true } });
    }),
  );

  r.post('/automation/start', ah<AuthedRequest>(async (req, res) => res.json({ data: await startRun(ctx.db, req.user.id) })));
  r.post('/automation/resume', ah<AuthedRequest>(async (req, res) => res.json({ data: await startRun(ctx.db, req.user.id) })));
  r.post('/automation/pause', ah<AuthedRequest>(async (req, res) => res.json({ data: await pauseRun(ctx.db, req.user.id) })));
  r.post('/automation/stop', ah<AuthedRequest>(async (req, res) => res.json({ data: await stopRun(ctx.db, req.user.id) })));

  return r;
}
