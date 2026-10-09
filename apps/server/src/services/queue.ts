import {
  ACTIVE_STATES,
  AUTO_SUBMIT_CONSENT_VERSION,
  INTERVENTION_COPY,
  RETRY_POLICY,
  assessProfile,
  buildAutofillProfile,
  canTransition,
  type ApplicationState,
  type ExecutionTask,
  type ExtensionReport,
  type InterventionType,
} from '@applyflux/shared';
import { judgeEvidence } from '@applyflux/form-engine';
import { autoSubmitPlatforms, type Config } from '../config';
import { camel, many, one, tx, type Db, type Queryable } from '../db';
import { signDownload } from '../lib/auth';
import { AppError, notFound } from '../lib/errors';
import { exclusionReason } from './jobs';
import { audit, notify } from './notify';
import { loadFullProfile } from './profile';
import { canReserveApplication, chargeApplication, lockUser, planFor } from './usage';

type Actor = 'user' | 'extension' | 'system';

export interface AppRow {
  id: string;
  user_id: string;
  job_id: string;
  state: ApplicationState;
  mode: string | null;
  attempts: number;
  max_attempts: number;
  verification_challenges: number;
  lease_connection_id: string | null;
  lease_expires_at: Date | null;
  submit_attempted_at: Date | null;
  submit_approved_at: Date | null;
  quota_reserved: boolean;
  control_signal: 'pause' | 'stop' | null;
  resume_document_id: string | null;
  cover_letter_id: string | null;
  step_state: Record<string, unknown> | null;
  run_id: string | null;
}

export async function lockApplication(q: Queryable, userId: string, id: string): Promise<AppRow> {
  const a = await one<AppRow>(q, 'select * from applications where id = $1 and user_id = $2 for update', [id, userId]);
  if (!a) throw notFound('Application');
  return a;
}

export async function logEvent(
  q: Queryable,
  a: { id: string; user_id: string },
  type: string,
  actor: Actor,
  opts: { from?: ApplicationState; to?: ApplicationState; message?: string; data?: unknown } = {},
) {
  await q.query(
    `insert into application_events (application_id, user_id, type, from_state, to_state, actor, message, data) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.id, a.user_id, type, opts.from ?? null, opts.to ?? null, actor, opts.message?.slice(0, 1000) ?? null, opts.data ? JSON.stringify(opts.data) : null],
  );
}

/** Validated state change. `patch` columns are written in the same statement. */
export async function transition(
  q: Queryable,
  a: AppRow,
  to: ApplicationState,
  actor: Actor,
  opts: { type?: string; message?: string; data?: unknown; patch?: Record<string, unknown> } = {},
) {
  if (!canTransition(a.state, to)) {
    throw new AppError('INVALID_TRANSITION', `Cannot move an application from ${a.state} to ${to}`);
  }
  const patch: Record<string, unknown> = { ...opts.patch, state: to };
  // Leaving the executor-held states releases the lease and any unspent reservation.
  if (!ACTIVE_STATES.includes(to)) {
    patch.lease_connection_id ??= null;
    patch.lease_expires_at ??= null;
    patch.control_signal ??= null;
    if (!['SUBMITTED', 'SUBMISSION_UNVERIFIED'].includes(to)) patch.quota_reserved = false;
  }
  const keys = Object.keys(patch);
  const vals = keys.map((k) => {
    const v = patch[k];
    return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  await q.query(`update applications set ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} where id = $1 and user_id = $2`, [a.id, a.user_id, ...vals]);
  await logEvent(q, a, opts.type ?? 'state_changed', actor, { from: a.state, to, message: opts.message, data: opts.data });
  Object.assign(a, patch);
}

/* ------------------------------------------------------------------ */
/* Queueing                                                            */
/* ------------------------------------------------------------------ */

export async function enqueueJobs(db: Db, userId: string, jobIds: string[], opts: { resumeDocumentId?: string | null; priority?: number } = {}) {
  const results: Array<{ jobId: string; applicationId?: string; status: 'queued' | 'already' | 'skipped'; reason?: string }> = [];
  const prefs = await one<Record<string, any>>(db, 'select * from automation_preferences where user_id = $1', [userId]);
  for (const jobId of jobIds) {
    await tx(db, async (c) => {
      const job = await one<Record<string, any>>(c, 'select * from jobs where id = $1 and user_id = $2', [jobId, userId]);
      if (!job) return results.push({ jobId, status: 'skipped', reason: 'Job not found' });
      const reason = exclusionReason(job as any, {
        excludedCompanies: prefs?.excluded_companies ?? [],
        excludedKeywords: prefs?.excluded_keywords ?? [],
        requireSponsorshipFriendly: prefs?.require_sponsorship_friendly ?? false,
      });
      if (reason) return results.push({ jobId, status: 'skipped', reason });
      // Already applied to the same role through another URL?
      const dup = await one<{ id: string }>(
        c,
        `select a.id from applications a join jobs j on j.id = a.job_id
          where a.user_id = $1 and j.fingerprint = $2 and j.id <> $3 and a.state in ('IN_PROGRESS','AWAITING_HUMAN_VERIFICATION','AWAITING_REVIEW','SUBMITTED','SUBMISSION_UNVERIFIED','INTERVIEW','REJECTED','WITHDRAWN','QUEUED')`,
        [userId, job.fingerprint, jobId],
      );
      if (dup) return results.push({ jobId, status: 'skipped', reason: 'You already have an application for this role (duplicate listing)' });

      await c.query(
        `insert into applications (user_id, job_id, idempotency_key, state, resume_document_id, priority)
         values ($1, $2, $3, 'DISCOVERED', $4, $5) on conflict (user_id, job_id) do nothing`,
        [userId, jobId, `job:${jobId}`, opts.resumeDocumentId ?? null, opts.priority ?? 0],
      );
      const a = await lockApplication(c, userId, (await one<{ id: string }>(c, 'select id from applications where user_id=$1 and job_id=$2', [userId, jobId]))!.id);
      if (!['DISCOVERED', 'SHORTLISTED', 'SKIPPED', 'FAILED'].includes(a.state)) return results.push({ jobId, applicationId: a.id, status: 'already', reason: `Already ${a.state.toLowerCase().replace(/_/g, ' ')}` });
      if (a.state === 'FAILED' && a.submit_attempted_at) return results.push({ jobId, applicationId: a.id, status: 'skipped', reason: 'A submission was already attempted; check it manually' });
      await transition(c, a, 'QUEUED', 'user', {
        type: 'queued',
        patch: { attempts: a.state === 'FAILED' ? 0 : a.attempts, ...(opts.resumeDocumentId ? { resume_document_id: opts.resumeDocumentId } : {}), priority: opts.priority ?? 0, last_error: null, intervention: null },
      });
      results.push({ jobId, applicationId: a.id, status: 'queued' });
    });
  }
  return results;
}

export async function shortlist(db: Db, userId: string, jobId: string) {
  return tx(db, async (c) => {
    const job = await one(c, 'select id from jobs where id=$1 and user_id=$2', [jobId, userId]);
    if (!job) throw notFound('Job');
    await c.query(
      `insert into applications (user_id, job_id, idempotency_key, state) values ($1,$2,$3,'DISCOVERED') on conflict (user_id, job_id) do nothing`,
      [userId, jobId, `job:${jobId}`],
    );
    const id = (await one<{ id: string }>(c, 'select id from applications where user_id=$1 and job_id=$2', [userId, jobId]))!.id;
    const a = await lockApplication(c, userId, id);
    if (a.state === 'SHORTLISTED') return a;
    await transition(c, a, 'SHORTLISTED', 'user', { type: 'shortlisted' });
    return a;
  });
}

/* ------------------------------------------------------------------ */
/* Runs: start / pause / resume / stop                                 */
/* ------------------------------------------------------------------ */

export async function currentRun(q: Queryable, userId: string) {
  return one<Record<string, any>>(q, `select * from automation_runs where user_id = $1 and status in ('running','paused') limit 1`, [userId]);
}

export async function startRun(db: Db, userId: string) {
  return tx(db, async (c) => {
    await lockUser(c, userId);
    const existing = await currentRun(c, userId);
    const prefs = (await one<Record<string, any>>(c, 'select * from automation_preferences where user_id=$1', [userId]))!;
    const plan = await planFor(c, userId);
    if (prefs.mode === 'auto') {
      if (!plan.auto_mode_allowed) throw new AppError('FORBIDDEN', `Auto Mode is not included in the ${plan.name} plan. Use Assisted or Review mode.`);
      if (!prefs.auto_submit_consent_at || prefs.auto_submit_consent_version !== AUTO_SUBMIT_CONSENT_VERSION)
        throw new AppError('CONSENT_REQUIRED', 'Auto Mode needs your explicit authorisation first (Automation Settings).');
      const profile = await loadFullProfile(c, userId);
      const a = assessProfile(profile);
      if (!a.readyForAutomation) throw new AppError('PROFILE_INCOMPLETE', 'Complete and verify your profile before running Auto Mode.', a);
    }
    const conn = await one(c, `select id from extension_connections where user_id=$1 and revoked_at is null and expires_at > now() limit 1`, [userId]);
    if (!conn) throw new AppError('BAD_REQUEST', 'Connect the ApplyFlux browser extension first — applications run in your browser.');
    if (existing) {
      if (existing.status === 'paused') {
        await c.query(`update automation_runs set status='running', paused_at=null, mode=$2 where id=$1`, [existing.id, prefs.mode]);
        await c.query(`update applications set control_signal=null where user_id=$1 and control_signal='pause'`, [userId]);
      }
      return camel((await one(c, 'select * from automation_runs where id=$1', [existing.id]))!);
    }
    const run = await one(c, `insert into automation_runs (user_id, status, mode) values ($1,'running',$2) returning *`, [userId, prefs.mode]);
    await audit(c, userId, 'automation.start', { type: 'run', id: run!.id as string }, { mode: prefs.mode });
    return camel(run);
  });
}

export async function pauseRun(db: Db, userId: string) {
  return tx(db, async (c) => {
    const run = await currentRun(c, userId);
    if (!run) throw new AppError('BAD_REQUEST', 'Automation is not running');
    await c.query(`update automation_runs set status='paused', paused_at=now() where id=$1`, [run.id]);
    // In-flight applications finish their current safe step, then hold.
    await c.query(`update applications set control_signal='pause' where user_id=$1 and state='IN_PROGRESS'`, [userId]);
    await audit(c, userId, 'automation.pause', { type: 'run', id: run.id });
    return camel((await one(c, 'select * from automation_runs where id=$1', [run.id]))!);
  });
}

export async function stopRun(db: Db, userId: string) {
  return tx(db, async (c) => {
    const run = await currentRun(c, userId);
    if (run) await c.query(`update automation_runs set status='stopped', ended_at=now() where id=$1`, [run.id]);
    // Running applications are told to stop; ones that never attempted submission go back to the queue.
    const active = await many<AppRow>(c, `select * from applications where user_id=$1 and state='IN_PROGRESS' for update`, [userId]);
    for (const a of active) {
      if (!a.submit_attempted_at) await transition(c, a, 'QUEUED', 'user', { type: 'stopped', message: 'Automation stopped; returned to queue' });
      else await c.query(`update applications set control_signal='stop' where id=$1`, [a.id]);
    }
    await audit(c, userId, 'automation.stop', run ? { type: 'run', id: run.id } : undefined);
    return { stopped: true, requeued: active.filter((a) => !a.submit_attempted_at).length };
  });
}

/* ------------------------------------------------------------------ */
/* Executor (extension) protocol                                        */
/* ------------------------------------------------------------------ */

function isSandboxUrl(config: Config, url: string) {
  try {
    const u = new URL(url);
    return u.origin === new URL(config.PUBLIC_API_URL).origin && u.pathname.startsWith('/sandbox/');
  } catch {
    return false;
  }
}

export async function claimNext(db: Db, config: Config, userId: string, connectionId: string): Promise<ExecutionTask | { idle: true; reason: string }> {
  return tx(db, async (c) => {
    await lockUser(c, userId);
    const run = await currentRun(c, userId);
    if (!run || run.status !== 'running') return { idle: true as const, reason: run ? 'Automation is paused' : 'Automation is not running' };
    const prefs = (await one<Record<string, any>>(c, 'select * from automation_preferences where user_id=$1', [userId]))!;
    const plan = await planFor(c, userId);
    const inFlight = await one<{ n: string }>(c, `select count(*) as n from applications where user_id=$1 and state='IN_PROGRESS'`, [userId]);
    const concurrency = Math.min(prefs.max_concurrency, plan.max_concurrency);
    if (Number(inFlight!.n) >= concurrency) return { idle: true as const, reason: `Concurrency limit (${concurrency}) reached` };
    const quota = await canReserveApplication(c, userId, prefs.daily_limit);
    if (!quota.ok) {
      await c.query(`update automation_runs set status='paused', paused_at=now() where id=$1`, [run.id]);
      await notify(c, userId, { type: 'quota', title: 'Automation paused', body: quota.reason, severity: 'warning' });
      return { idle: true as const, reason: quota.reason };
    }
    const next = await one<AppRow & { url: string; title: string; company: string; ats_vendor: string | null; description: string | null; liveness: string }>(
      c,
      `select a.*, j.url, j.title, j.company, j.ats_vendor, j.description, j.liveness from applications a join jobs j on j.id = a.job_id
        where a.user_id = $1 and a.state = 'QUEUED' order by a.priority desc, a.created_at for update of a skip locked limit 1`,
      [userId],
    );
    if (!next) {
      await c.query(`update automation_runs set status='completed', ended_at=now() where id=$1 and not exists (select 1 from applications where user_id=$2 and state in ('IN_PROGRESS','AWAITING_HUMAN_VERIFICATION'))`, [run.id, userId]);
      return { idle: true as const, reason: 'Queue is empty' };
    }
    // Re-check exclusions at execution time (preferences may have changed since queueing).
    const excl = exclusionReason(next, { excludedCompanies: prefs.excluded_companies, excludedKeywords: prefs.excluded_keywords, requireSponsorshipFriendly: prefs.require_sponsorship_friendly });
    if (excl) {
      await transition(c, next, 'IN_PROGRESS', 'system', { type: 'claimed' });
      await transition(c, next, 'SKIPPED', 'system', { type: 'skipped', message: excl });
      return { idle: true as const, reason: `Skipped one application: ${excl}` };
    }

    const lease = new Date(Date.now() + RETRY_POLICY.leaseSeconds * 1000);
    await transition(c, next, 'IN_PROGRESS', 'system', {
      type: 'claimed',
      message: `Started (attempt ${next.attempts + 1})`,
      patch: {
        lease_connection_id: connectionId,
        lease_expires_at: lease,
        last_heartbeat_at: new Date(),
        attempts: next.attempts + 1,
        quota_reserved: true,
        mode: prefs.mode,
        run_id: run.id,
        current_step: 'Opening application',
        progress: 5,
      },
    });

    const profile = await loadFullProfile(c, userId);
    const autofill = buildAutofillProfile(profile);
    const answers = await many<Record<string, any>>(c, `select question, question_key, answer, category from saved_answers where user_id=$1 and approved`, [userId]);
    const resumeId =
      next.resume_document_id ??
      prefs.default_resume_id ??
      (await one<{ id: string }>(c, `select id from documents where user_id=$1 and kind='resume' order by is_default desc, created_at desc limit 1`, [userId]))?.id ??
      null;
    const resume = resumeId ? await one<Record<string, any>>(c, `select id, file_name, mime_type from documents where id=$1 and user_id=$2`, [resumeId, userId]) : null;
    let cover: Record<string, any> | null = null;
    if (prefs.cover_letter_policy !== 'never') {
      cover = next.cover_letter_id
        ? await one(c, `select * from cover_letters where id=$1 and user_id=$2`, [next.cover_letter_id, userId])
        : await one(c, `select * from cover_letters where user_id=$1 and job_id=$2 and status='approved' order by updated_at desc limit 1`, [userId, next.job_id]);
    }
    const platform = isSandboxUrl(config, next.url) ? 'sandbox' : (next.ats_vendor ?? 'generic');
    const consented = !!prefs.auto_submit_consent_at && prefs.auto_submit_consent_version === AUTO_SUBMIT_CONSENT_VERSION;
    const allowSubmit =
      !!next.submit_approved_at ||
      (prefs.mode === 'auto' && consented && plan.auto_mode_allowed && autoSubmitPlatforms(config).has(platform) && assessProfile(profile).readyForAutomation);

    const base = config.PUBLIC_API_URL.replace(/\/$/, '');
    return {
      applicationId: next.id,
      leaseExpiresAt: lease.toISOString(),
      mode: prefs.mode,
      allowSubmit,
      job: { id: next.job_id, url: next.url, title: next.title, company: next.company, atsVendor: next.ats_vendor },
      profile: autofill,
      answers: answers.map((a) => ({ question: a.question, questionKey: a.question_key, answer: a.answer, category: a.category })),
      resume: resume
        ? { documentId: resume.id, fileName: resume.file_name, mimeType: resume.mime_type, downloadUrl: `${base}/api/ext/documents/${signDownload(config.DOWNLOAD_SIGNING_SECRET, resume.id, userId)}` }
        : null,
      coverLetter: cover
        ? {
            id: cover.id,
            text: cover.body,
            downloadUrl: cover.document_id ? `${base}/api/ext/documents/${signDownload(config.DOWNLOAD_SIGNING_SECRET, cover.document_id, userId)}` : null,
            fileName: cover.document_id ? 'Cover_Letter.pdf' : null,
          }
        : null,
      resumeFromStep: next.step_state,
      attempt: next.attempts,
    } satisfies ExecutionTask;
  });
}

/** Heartbeat: extends the lease and tells the executor whether to continue. */
export async function heartbeat(db: Db, userId: string, connectionId: string, id: string) {
  return tx(db, async (c) => {
    const a = await lockApplication(c, userId, id);
    if (!ACTIVE_STATES.includes(a.state) || (a.lease_connection_id && a.lease_connection_id !== connectionId)) return { signal: 'stop' as const, state: a.state };
    const run = await currentRun(c, userId);
    const ttl = a.state === 'AWAITING_HUMAN_VERIFICATION' ? RETRY_POLICY.verificationTimeoutSeconds : RETRY_POLICY.leaseSeconds;
    await c.query(`update applications set lease_expires_at = now() + make_interval(secs => $2), last_heartbeat_at = now() where id = $1`, [id, ttl]);
    const signal = a.control_signal ?? (!run || run.status === 'stopped' ? 'stop' : run.status === 'paused' ? 'pause' : 'continue');
    return { signal, state: a.state, submitApproved: !!a.submit_approved_at };
  });
}

function interventionPatch(type: InterventionType, message: string, extra: Record<string, unknown> = {}) {
  return { intervention: { type, message, title: INTERVENTION_COPY[type].title, action: INTERVENTION_COPY[type].action, since: new Date().toISOString(), ...extra } };
}

export async function handleReport(db: Db, userId: string, connectionId: string, id: string, report: ExtensionReport) {
  return tx(db, async (c) => {
    const a = await lockApplication(c, userId, id);
    const holds = a.lease_connection_id === connectionId;
    if (!holds) throw new AppError('LEASE_LOST', 'This browser no longer holds this application');
    const job = (await one<{ title: string; company: string }>(c, 'select title, company from jobs where id=$1', [a.job_id]))!;
    const label = `${job.title} at ${job.company}`;

    switch (report.type) {
      case 'progress': {
        if (a.state !== 'IN_PROGRESS') throw new AppError('INVALID_TRANSITION', `Application is ${a.state}`);
        await c.query(
          `update applications set current_step=$2, progress=$3, adapter=coalesce($4, adapter), fields=coalesce($5, fields), step_state=coalesce($6, step_state),
             lease_expires_at = now() + make_interval(secs => $7), last_heartbeat_at = now() where id=$1`,
          [id, report.data.step, report.data.progress, report.data.adapter ?? null, report.data.fields ? JSON.stringify(report.data.fields) : null, report.data.stepState ? JSON.stringify(report.data.stepState) : null, RETRY_POLICY.leaseSeconds],
        );
        await logEvent(c, a, 'progress', 'extension', { message: report.data.step });
        return { ok: true };
      }

      case 'intervention': {
        const d = report.data;
        if (!['IN_PROGRESS', 'AWAITING_REVIEW'].includes(a.state)) throw new AppError('INVALID_TRANSITION', `Application is ${a.state}`);
        const common = { fields: d.fields ?? undefined, step_state: d.stepState ?? a.step_state };
        if (d.intervention === 'captcha') {
          const n = a.verification_challenges + 1;
          if (n > RETRY_POLICY.maxVerificationChallenges) {
            await transition(c, a, 'NEEDS_ATTENTION', 'extension', {
              type: 'verification_limit',
              message: `Verification appeared ${n} times; automation stopped for this application`,
              patch: { ...common, verification_challenges: n, ...interventionPatch('captcha', 'Repeated verification challenges. Complete this application manually or skip it.', { pageUrl: d.pageUrl }) },
            });
            await notify(c, userId, { type: 'needs_attention', title: 'Application needs attention', body: `${label}: repeated verification challenges. Complete it manually or skip.`, applicationId: id, severity: 'danger' });
            return { ok: true, state: 'NEEDS_ATTENTION' };
          }
          if (a.state === 'AWAITING_REVIEW') throw new AppError('INVALID_TRANSITION', 'Application is awaiting review');
          await transition(c, a, 'AWAITING_HUMAN_VERIFICATION', 'extension', {
            type: 'verification_required',
            message: d.message,
            patch: {
              ...common,
              verification_challenges: n,
              lease_expires_at: new Date(Date.now() + RETRY_POLICY.verificationTimeoutSeconds * 1000),
              ...interventionPatch('captcha', d.message, { pageUrl: d.pageUrl }),
            },
          });
          await notify(c, userId, { type: 'verification', title: 'Human verification required', body: `${label}: please complete the verification in the application tab.`, applicationId: id, severity: 'warning' });
          return { ok: true, state: 'AWAITING_HUMAN_VERIFICATION' };
        }
        const to: ApplicationState = d.intervention === 'review_before_submit' ? 'AWAITING_REVIEW' : 'NEEDS_ATTENTION';
        if (a.state === to) return { ok: true, state: to };
        await transition(c, a, to, 'extension', {
          type: 'intervention',
          message: d.message,
          // Keep the lease for review so the same tab can submit after approval.
          patch: { ...common, ...interventionPatch(d.intervention, d.message, { pageUrl: d.pageUrl }), ...(to === 'AWAITING_REVIEW' ? { lease_connection_id: connectionId, lease_expires_at: new Date(Date.now() + RETRY_POLICY.verificationTimeoutSeconds * 1000) } : {}) },
        });
        await notify(c, userId, {
          type: to === 'AWAITING_REVIEW' ? 'review' : 'needs_attention',
          title: INTERVENTION_COPY[d.intervention].title,
          body: `${label}: ${d.message}`,
          applicationId: id,
          severity: to === 'AWAITING_REVIEW' ? 'info' : 'warning',
        });
        return { ok: true, state: to };
      }

      case 'verification_resolved': {
        if (a.state !== 'AWAITING_HUMAN_VERIFICATION') throw new AppError('INVALID_TRANSITION', `Application is ${a.state}`);
        const e = report.data;
        // Evidence, not a button click: the provider token must be present and no challenge visible.
        if (!e.tokenPresent || e.challengeVisible) {
          await logEvent(c, a, 'verification_check_failed', 'extension', { message: 'Verification not yet complete', data: e });
          throw new AppError('CONFLICT', 'Verification is not complete yet');
        }
        await transition(c, a, 'IN_PROGRESS', 'extension', {
          type: 'verification_resolved',
          message: 'Verification completed by you; resuming from the last safe step',
          data: e,
          patch: { intervention: null, lease_expires_at: new Date(Date.now() + RETRY_POLICY.leaseSeconds * 1000) },
        });
        return { ok: true, state: 'IN_PROGRESS' };
      }

      case 'ready_for_review': {
        if (a.state !== 'IN_PROGRESS') throw new AppError('INVALID_TRANSITION', `Application is ${a.state}`);
        await transition(c, a, 'AWAITING_REVIEW', 'extension', {
          type: 'ready_for_review',
          message: 'Form filled; waiting for your review',
          patch: {
            fields: report.data.fields,
            progress: 90,
            current_step: 'Awaiting your review',
            lease_connection_id: connectionId,
            lease_expires_at: new Date(Date.now() + RETRY_POLICY.verificationTimeoutSeconds * 1000),
            ...interventionPatch('review_before_submit', 'Review the filled application in the tab, then submit it yourself or approve submission.', { pageUrl: report.data.pageUrl }),
          },
        });
        await notify(c, userId, { type: 'review', title: 'Ready for your review', body: label, applicationId: id });
        return { ok: true, state: 'AWAITING_REVIEW' };
      }

      case 'submit_attempted': {
        if (!['IN_PROGRESS', 'AWAITING_REVIEW'].includes(a.state)) throw new AppError('INVALID_TRANSITION', `Application is ${a.state}`);
        if (a.submit_attempted_at) return { ok: true, duplicate: true };
        await c.query(`update applications set submit_attempted_at = now(), current_step='Submitting', progress=95 where id=$1`, [id]);
        await logEvent(c, a, 'submit_attempted', 'extension', { message: 'Submit clicked', data: { pageUrl: report.data.pageUrl } });
        await audit(c, userId, 'application.submit_attempted', { type: 'application', id });
        return { ok: true };
      }

      case 'submission_result': {
        if (!['IN_PROGRESS', 'AWAITING_REVIEW'].includes(a.state)) {
          // Duplicate report after we already recorded the outcome: idempotent no-op.
          if (['SUBMITTED', 'SUBMISSION_UNVERIFIED'].includes(a.state)) return { ok: true, state: a.state, duplicate: true };
          throw new AppError('INVALID_TRANSITION', `Application is ${a.state}`);
        }
        if (!a.submit_attempted_at) throw new AppError('BAD_REQUEST', 'No submit attempt was recorded for this application');
        const verdict = judgeEvidence(report.data);
        if (verdict === 'failed') {
          await transition(c, a, 'NEEDS_ATTENTION', 'extension', {
            type: 'submission_rejected',
            message: 'The site showed validation errors after submit',
            data: report.data,
            patch: { ...interventionPatch('validation_errors', 'The site reported errors after submit. Fix them in the tab and submit, or skip.', { pageUrl: report.data.finalUrl }), submission_evidence: report.data },
          });
          await notify(c, userId, { type: 'needs_attention', title: 'Submission needs attention', body: `${label}: the site reported form errors.`, applicationId: id, severity: 'warning' });
          return { ok: true, state: 'NEEDS_ATTENTION' };
        }
        const to: ApplicationState = verdict === 'confirmed' ? 'SUBMITTED' : 'SUBMISSION_UNVERIFIED';
        await transition(c, a, to, 'extension', {
          type: verdict === 'confirmed' ? 'submitted' : 'submission_unverified',
          message: verdict === 'confirmed' ? 'Confirmation page detected' : 'Submitted, but the site showed no clear confirmation',
          data: report.data,
          patch: { submitted_at: new Date(), submission_evidence: report.data, progress: 100, current_step: verdict === 'confirmed' ? 'Submitted' : 'Submitted (unverified)', intervention: null, quota_reserved: false },
        });
        await chargeApplication(c, userId, id);
        await audit(c, userId, 'application.submitted', { type: 'application', id }, { verdict });
        await notify(c, userId, {
          type: 'submitted',
          title: verdict === 'confirmed' ? 'Application submitted' : 'Submission unverified',
          body: verdict === 'confirmed' ? label : `${label}: no confirmation detected — check your email or the employer's site.`,
          applicationId: id,
          severity: verdict === 'confirmed' ? 'success' : 'warning',
        });
        return { ok: true, state: to };
      }

      case 'failed': {
        const d = report.data;
        if (!ACTIVE_STATES.includes(a.state)) throw new AppError('INVALID_TRANSITION', `Application is ${a.state}`);
        const err = { code: d.code, message: d.message, at: new Date().toISOString(), attempt: a.attempts };
        if (a.submit_attempted_at) {
          // Never retry after a submit click: the employer may have received it.
          await transition(c, a, 'NEEDS_ATTENTION', 'extension', {
            type: 'failed_after_submit',
            message: d.message,
            patch: { last_error: err, ...interventionPatch('executor_lost', 'An error occurred after submit was clicked. Check whether the employer received it before retrying.') },
          });
          return { ok: true, state: 'NEEDS_ATTENTION' };
        }
        if (d.retryable && a.attempts < a.max_attempts && a.state === 'IN_PROGRESS') {
          await transition(c, a, 'QUEUED', 'extension', { type: 'retry_scheduled', message: `${d.message} — will retry (${a.attempts}/${a.max_attempts})`, patch: { last_error: err } });
          return { ok: true, state: 'QUEUED' };
        }
        const to: ApplicationState = a.state === 'AWAITING_HUMAN_VERIFICATION' ? 'NEEDS_ATTENTION' : d.retryable ? 'NEEDS_ATTENTION' : 'FAILED';
        await transition(c, a, to, 'extension', { type: 'failed', message: d.message, patch: { last_error: err } });
        await notify(c, userId, { type: 'failed', title: to === 'FAILED' ? 'Application failed' : 'Application needs attention', body: `${label}: ${d.message}`, applicationId: id, severity: 'danger' });
        return { ok: true, state: to };
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* User actions                                                         */
/* ------------------------------------------------------------------ */

export type UserAction =
  | { action: 'retry' }
  | { action: 'skip'; reason?: string }
  | { action: 'approve_submit' }
  | { action: 'mark_submitted_manually'; note?: string }
  | { action: 'confirm_submitted'; note?: string }
  | { action: 'set_outcome'; outcome: 'INTERVIEW' | 'REJECTED' | 'WITHDRAWN' }
  | { action: 'dequeue' }
  | { action: 'stop' };

export async function userAction(db: Db, userId: string, id: string, act: UserAction) {
  return tx(db, async (c) => {
    const a = await lockApplication(c, userId, id);
    switch (act.action) {
      case 'retry': {
        if (a.submit_attempted_at) throw new AppError('CONFLICT', 'A submission was already attempted. Confirm it manually instead of retrying, to avoid a duplicate application.');
        await transition(c, a, 'QUEUED', 'user', { type: 'retry', patch: { intervention: null, last_error: null, attempts: 0, verification_challenges: 0, step_state: a.step_state } });
        break;
      }
      case 'skip':
        await transition(c, a, 'SKIPPED', 'user', { type: 'skipped', message: act.reason ?? 'Skipped by you', patch: { intervention: null } });
        break;
      case 'dequeue':
        await transition(c, a, 'SHORTLISTED', 'user', { type: 'dequeued' });
        break;
      case 'approve_submit': {
        if (a.state !== 'AWAITING_REVIEW') throw new AppError('INVALID_TRANSITION', 'Only applications awaiting review can be approved');
        await transition(c, a, 'IN_PROGRESS', 'user', {
          type: 'submit_approved',
          message: 'You approved submission',
          patch: { submit_approved_at: new Date(), intervention: null, lease_expires_at: new Date(Date.now() + RETRY_POLICY.leaseSeconds * 1000) },
        });
        await audit(c, userId, 'application.submit_approved', { type: 'application', id });
        break;
      }
      case 'mark_submitted_manually': {
        // The person says they submitted it themselves. Recorded as unverified and never charged.
        const evidence = { userAttested: true, note: act.note ?? null, observedAt: new Date().toISOString(), matchedSignals: [], formStillPresent: false, errorsVisible: false, adapter: 'manual', finalUrl: '' };
        await transition(c, a.state === 'QUEUED' || a.state === 'DISCOVERED' || a.state === 'SHORTLISTED' ? await viaInProgress(c, a) : a, 'SUBMISSION_UNVERIFIED', 'user', {
          type: 'marked_submitted',
          message: 'You marked this as submitted',
          patch: { submitted_at: new Date(), submission_evidence: evidence, intervention: null, quota_reserved: false },
        });
        break;
      }
      case 'confirm_submitted': {
        if (a.state !== 'SUBMISSION_UNVERIFIED') throw new AppError('INVALID_TRANSITION', 'Only unverified submissions can be confirmed');
        const ev = { ...(a as unknown as { submission_evidence: Record<string, unknown> }).submission_evidence, userConfirmed: true, note: act.note ?? null, confirmedAt: new Date().toISOString() };
        await transition(c, a, 'SUBMITTED', 'user', { type: 'confirmed_by_user', message: 'You confirmed the employer received this application', patch: { submission_evidence: ev } });
        break;
      }
      case 'set_outcome':
        await transition(c, a, act.outcome, 'user', { type: 'outcome' });
        break;
      case 'stop': {
        if (a.state === 'IN_PROGRESS' && !a.submit_attempted_at) await transition(c, a, 'QUEUED', 'user', { type: 'stopped' });
        else if (ACTIVE_STATES.includes(a.state)) await c.query(`update applications set control_signal='stop' where id=$1`, [id]);
        else throw new AppError('INVALID_TRANSITION', 'Application is not running');
        break;
      }
    }
    return camel((await one(c, 'select * from applications where id=$1', [id]))!);
  });
}

/** Manual completion from an untouched state passes through IN_PROGRESS so the audit trail is continuous. */
async function viaInProgress(c: Queryable, a: AppRow): Promise<AppRow> {
  if (a.state !== 'QUEUED') await transition(c, a, 'QUEUED', 'user', { type: 'queued' });
  await transition(c, a, 'IN_PROGRESS', 'user', { type: 'manual_completion' });
  return a;
}

/* ------------------------------------------------------------------ */
/* Recovery sweeper                                                     */
/* ------------------------------------------------------------------ */

/** Recover applications whose executor vanished. Safe to run concurrently (row locks + skip locked). */
export async function sweepExpiredLeases(db: Db) {
  let recovered = 0;
  for (;;) {
    const done = await tx(db, async (c) => {
      const a = await one<AppRow>(
        c,
        `select * from applications where state in ('IN_PROGRESS','AWAITING_HUMAN_VERIFICATION','AWAITING_REVIEW')
            and lease_expires_at < now() for update skip locked limit 1`,
      );
      if (!a) return true;
      if (a.state === 'AWAITING_REVIEW') {
        // A review can wait for the person indefinitely; just release the browser lease.
        await c.query(`update applications set lease_expires_at = null where id=$1`, [a.id]);
        return false;
      }
      if (a.state === 'AWAITING_HUMAN_VERIFICATION') {
        await transition(c, a, 'NEEDS_ATTENTION', 'system', {
          type: 'verification_timeout',
          message: 'Verification was not completed in time',
          patch: interventionPatch('captcha', 'Verification was not completed within 30 minutes. Complete the application manually, retry, or skip it.'),
        });
      } else if (!a.submit_attempted_at && a.attempts < a.max_attempts) {
        await transition(c, a, 'QUEUED', 'system', { type: 'executor_lost', message: 'Browser stopped responding; returned to queue', patch: { last_error: { code: 'executor_lost', at: new Date().toISOString() } } });
      } else {
        await transition(c, a, 'NEEDS_ATTENTION', 'system', {
          type: 'executor_lost',
          message: a.submit_attempted_at ? 'Browser disconnected after submit was clicked' : 'Browser stopped responding too many times',
          patch: interventionPatch('executor_lost', a.submit_attempted_at ? 'The browser disconnected after submit was clicked. Check whether the employer received it.' : 'The browser stopped responding repeatedly.'),
        });
        await notify(c, a.user_id, { type: 'needs_attention', title: 'Application needs attention', body: 'A browser session was lost mid-application.', applicationId: a.id, severity: 'warning' });
      }
      recovered++;
      return false;
    });
    if (done) break;
  }
  return recovered;
}
