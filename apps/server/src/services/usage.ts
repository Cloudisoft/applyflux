import type { Queryable } from '../db';
import { one } from '../db';
import { AppError } from '../lib/errors';

/**
 * Usage policy (documented in docs/USAGE_POLICY.md):
 *  - An application counts against quota once ApplyFlux submits it (SUBMITTED or
 *    SUBMISSION_UNVERIFIED). Failed, skipped, cancelled and user-completed-manually
 *    applications never count.
 *  - When an application is claimed for execution, a reservation holds one unit
 *    so concurrent executors cannot exceed the limit. Reservations are released
 *    when the application leaves the active states without a submission.
 *  - The ledger is unique per (user, kind, application), so retries and duplicate
 *    reports can never charge twice.
 *  - AI generations count per request with a client idempotency key.
 */

export interface Plan {
  id: string;
  name: string;
  monthly_application_limit: number;
  daily_application_limit: number;
  max_concurrency: number;
  monthly_ai_generations: number;
  auto_mode_allowed: boolean;
}

export async function planFor(q: Queryable, userId: string): Promise<Plan> {
  const p = await one<Plan>(
    q,
    `select * from (
       select p.*, 0 as pri from subscriptions s join plans p on p.id = s.plan_id where s.user_id = $1 and s.status = 'active'
       union all select p.*, 1 as pri from plans p where p.id = 'free'
     ) x order by pri limit 1`,
    [userId],
  );
  if (!p) throw new AppError('INTERNAL', 'No plan configured. Apply the plans migration.');
  return p;
}

export async function usageSummary(q: Queryable, userId: string) {
  const plan = await planFor(q, userId);
  const r = await one<Record<string, string>>(
    q,
    `select
       (select count(*) from usage_ledger where user_id=$1 and kind='application' and created_at >= date_trunc('month', now())) as month_apps,
       (select count(*) from usage_ledger where user_id=$1 and kind='application' and created_at >= date_trunc('day', now())) as day_apps,
       (select count(*) from usage_ledger where user_id=$1 and kind='ai_generation' and created_at >= date_trunc('month', now())) as month_ai,
       (select count(*) from applications where user_id=$1 and quota_reserved) as reserved`,
    [userId],
  );
  const monthApps = Number(r!.month_apps);
  const reserved = Number(r!.reserved);
  return {
    plan,
    applications: { usedThisMonth: monthApps, usedToday: Number(r!.day_apps), reserved, monthlyLimit: plan.monthly_application_limit, dailyLimit: plan.daily_application_limit },
    ai: { usedThisMonth: Number(r!.month_ai), monthlyLimit: plan.monthly_ai_generations },
    periodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
  };
}

/** Must run inside a transaction holding the per-user advisory lock. */
export async function canReserveApplication(q: Queryable, userId: string, userDailyLimit: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  const s = await usageSummary(q, userId);
  const a = s.applications;
  if (a.usedThisMonth + a.reserved >= a.monthlyLimit) return { ok: false, reason: `Monthly limit of ${a.monthlyLimit} applications reached on the ${s.plan.name} plan` };
  const daily = Math.min(a.dailyLimit, userDailyLimit);
  if (a.usedToday + a.reserved >= daily) return { ok: false, reason: `Daily limit of ${daily} applications reached` };
  return { ok: true };
}

export async function lockUser(q: Queryable, userId: string) {
  await q.query('select pg_advisory_xact_lock(hashtext($1))', [`user:${userId}`]);
}

export async function chargeApplication(q: Queryable, userId: string, applicationId: string) {
  await q.query(`insert into usage_ledger (user_id, kind, ref) values ($1, 'application', $2) on conflict do nothing`, [userId, applicationId]);
}

/** Atomically check and record one AI generation. Idempotent per key. */
export async function chargeAi(q: Queryable, userId: string, key: string) {
  await lockUser(q, userId);
  const exists = await one(q, `select 1 from usage_ledger where user_id=$1 and kind='ai_generation' and ref=$2`, [userId, key]);
  if (exists) return;
  const s = await usageSummary(q, userId);
  if (s.ai.usedThisMonth >= s.ai.monthlyLimit) throw new AppError('QUOTA_EXCEEDED', `You've used all ${s.ai.monthlyLimit} AI generations this month on the ${s.plan.name} plan.`);
  await q.query(`insert into usage_ledger (user_id, kind, ref) values ($1, 'ai_generation', $2) on conflict do nothing`, [userId, key]);
}
