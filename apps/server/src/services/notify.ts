import type { Queryable } from '../db';

export async function notify(
  q: Queryable,
  userId: string,
  n: { type: string; title: string; body?: string; applicationId?: string | null; severity?: 'info' | 'success' | 'warning' | 'danger' },
) {
  await q.query(
    `insert into notifications (user_id, type, title, body, application_id, severity) values ($1,$2,$3,$4,$5,$6)`,
    [userId, n.type, n.title.slice(0, 200), n.body?.slice(0, 1000) ?? null, n.applicationId ?? null, n.severity ?? 'info'],
  );
}

/** Audit significant actions. Metadata must not contain personal data (it survives account deletion). */
export async function audit(q: Queryable, userId: string | null, action: string, target?: { type: string; id: string }, metadata?: Record<string, unknown>) {
  await q.query(`insert into audit_events (user_id, action, target_type, target_id, metadata) values ($1,$2,$3,$4,$5)`, [
    userId,
    action,
    target?.type ?? null,
    target?.id ?? null,
    metadata ? JSON.stringify(metadata) : null,
  ]);
}
