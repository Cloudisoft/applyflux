import type { Queryable } from '../db';
import { one } from '../db';

/**
 * Daily application limit (the person's own setting in Automation Settings).
 *  - An application counts once ApplyFlux submits it (SUBMITTED or SUBMISSION_UNVERIFIED).
 *    Failed, skipped, stopped and manually completed applications never count.
 *  - Claiming an application reserves one slot under a per-user advisory lock so
 *    concurrent claims cannot exceed the limit; the reservation is released when the
 *    application leaves the active states without a submission.
 *  - The ledger is unique per application, so retries and duplicate reports never count twice.
 */

export async function usageSummary(q: Queryable, userId: string) {
  const r = await one<{ day_apps: string; reserved: string; daily_limit: number | null }>(
    q,
    `select
       (select count(*) from usage_ledger where user_id=$1 and kind='application' and created_at >= date_trunc('day', now())) as day_apps,
       (select count(*) from applications where user_id=$1 and quota_reserved) as reserved,
       (select daily_limit from automation_preferences where user_id=$1) as daily_limit`,
    [userId],
  );
  return {
    applications: { usedToday: Number(r!.day_apps), reserved: Number(r!.reserved), dailyLimit: r!.daily_limit ?? 10 },
  };
}

/** Must run inside a transaction holding the per-user advisory lock. */
export async function canReserveApplication(q: Queryable, userId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { applications: a } = await usageSummary(q, userId);
  if (a.usedToday + a.reserved >= a.dailyLimit) return { ok: false, reason: `Daily limit of ${a.dailyLimit} applications reached` };
  return { ok: true };
}

export async function lockUser(q: Queryable, userId: string) {
  await q.query('select pg_advisory_xact_lock(hashtext($1))', [`user:${userId}`]);
}

export async function chargeApplication(q: Queryable, userId: string, applicationId: string) {
  await q.query(`insert into usage_ledger (user_id, kind, ref) values ($1, 'application', $2) on conflict do nothing`, [userId, applicationId]);
}
