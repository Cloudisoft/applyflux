import { buildAutofillProfile, discoveryTitles, isRecent, locationFits, normalizeText, titleFit } from '@applyflux/shared';
import type { AppContext } from '../context';
import { many, one } from '../db';
import { BOARD_CATALOG } from './board-catalog';
import { fetchBoard, fetchFeed, greenhouseDescription, type FeedId, type SourcedJob } from './discovery';
import { refreshMatches, upsertJob } from './jobs';
import { loadFullProfile } from './profile';
import { enqueueJobs } from './queue';

/**
 * Automatic job discovery: no setup needed. Scans public company boards (career-ops' catalogue plus
 * well-known employers and any board the person added) and public job feeds, keeps recent postings
 * that fit the person's target titles and location, stores them, scores them, and queues the best
 * matches so Auto Apply always has work.
 */

const RECENT_DAYS = 21;
const MAX_NEW_PER_RUN = 300;
const JUNIOR_ONLY = /\b(intern|internship|new grad|graduate program|apprentice|co-?op)\b/i;
const CACHE_MS = 60 * 60_000;
const FEEDS: FeedId[] = ['remotive', 'remoteok', 'arbeitnow', 'himalayas', 'themuse', 'adzuna'];

type Found = { job: SourcedJob; board?: { kind: 'greenhouse' | 'lever' | 'ashby'; identifier: string } };

/** Board feeds are shared by everyone: fetch each at most once an hour, and never twice at the same time. */
const cache = new Map<string, { at: number; value: Promise<SourcedJob[]> }>();
function cached(key: string, load: () => Promise<SourcedJob[]>): Promise<SourcedJob[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = load()
    // Keep memory bounded: descriptions are only needed for the few postings that match.
    .then((jobs) => jobs.map((j) => ({ ...j, description: j.description?.slice(0, 6000) ?? null })))
    .catch((e) => {
      cache.delete(key);
      throw e;
    });
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const running = new Set<string>();
const rerun = new Set<string>();

/** Tests only. */
export function clearDiscoveryCache() {
  cache.clear();
}

export interface DiscoverySummary {
  status: 'ok' | 'needs_titles' | 'failed';
  startedAt: string;
  finishedAt: string;
  titles: string[];
  scanned: number;
  matched: number;
  added: number;
  queued: number;
  sourcesFailed: number;
  message?: string;
}

export function discoveryRunning(userId: string) {
  return running.has(userId);
}

/** Run discovery for one person. Safe to call repeatedly: concurrent calls for the same person are ignored. */
export async function runDiscovery(ctx: AppContext, userId: string): Promise<DiscoverySummary | null> {
  if (running.has(userId)) {
    // Settings changed mid-run: search again with them as soon as this run ends.
    rerun.add(userId);
    return null;
  }
  running.add(userId);
  const startedAt = new Date().toISOString();
  try {
    const summary = await discover(ctx, userId, startedAt);
    await ctx.db.query('update automation_preferences set last_discovered_at = now(), last_discovery = $2 where user_id = $1', [userId, JSON.stringify(summary)]);
    return summary;
  } catch (e) {
    const summary: DiscoverySummary = { status: 'failed', startedAt, finishedAt: new Date().toISOString(), titles: [], scanned: 0, matched: 0, added: 0, queued: 0, sourcesFailed: 0, message: e instanceof Error ? e.message.slice(0, 300) : 'Discovery failed' };
    console.error(JSON.stringify({ level: 'error', msg: 'job discovery failed', userId, message: summary.message }));
    await ctx.db.query('update automation_preferences set last_discovered_at = now(), last_discovery = $2 where user_id = $1', [userId, JSON.stringify(summary)]).catch(() => {});
    return summary;
  } finally {
    running.delete(userId);
    if (rerun.delete(userId)) void runDiscovery(ctx, userId);
  }
}

async function discover(ctx: AppContext, userId: string, startedAt: string): Promise<DiscoverySummary> {
  const { db, config, fetchJson } = ctx;
  const profile = await loadFullProfile(db, userId);
  const autofill = buildAutofillProfile(profile);
  const titles = discoveryTitles({ desiredTitles: profile.profile.desiredTitles, currentTitle: autofill.currentTitle });
  const base = { startedAt, titles, scanned: 0, matched: 0, added: 0, queued: 0, sourcesFailed: 0 };
  if (!titles.length) return { ...base, status: 'needs_titles', finishedAt: new Date().toISOString(), message: 'Add the job titles you want (Candidate profile → Job preferences) or upload your resume.' };

  const prefs = await one<Record<string, any>>(db, 'select * from automation_preferences where user_id = $1', [userId]);
  const own = await many<{ kind: 'greenhouse' | 'lever' | 'ashby'; identifier: string; name: string | null }>(db, 'select kind, identifier, name from job_sources where user_id = $1 and enabled', [userId]);
  const boards = new Map<string, { kind: 'greenhouse' | 'lever' | 'ashby'; identifier: string; name: string }>();
  for (const b of [...BOARD_CATALOG, ...own.map((o) => ({ ...o, name: o.name ?? o.identifier }))]) boards.set(`${b.kind}:${b.identifier.toLowerCase()}`, b);

  const found: Found[] = [];
  let failed = 0;
  const adzuna = config.ADZUNA_APP_ID && config.ADZUNA_APP_KEY ? { appId: config.ADZUNA_APP_ID, appKey: config.ADZUNA_APP_KEY } : null;
  const titleKey = titles.map((t) => normalizeText(t)).sort().join('|');
  const tasks: Array<() => Promise<void>> = [
    ...[...boards.values()].map((b) => async () => {
      const jobs = await cached(`board:${b.kind}:${b.identifier.toLowerCase()}`, () => fetchBoard(b.kind, b.identifier, b.name, fetchJson, { withContent: false }));
      for (const job of jobs) found.push({ job, board: { kind: b.kind, identifier: b.identifier } });
    }),
    ...FEEDS.filter((f) => f !== 'adzuna' || adzuna).map((f) => async () => {
      const searchable = f === 'himalayas' || f === 'themuse' || f === 'adzuna';
      const key = `feed:${f}${searchable ? `:${titleKey}:${f === 'adzuna' ? `${profile.profile.country}:${profile.profile.city}` : ''}` : ''}`;
      const jobs = await cached(key, () => fetchFeed(f, { titles, country: profile.profile.country, city: profile.profile.city, fetchJson, adzuna }));
      for (const job of jobs) found.push({ job });
    }),
  ];
  await pool(tasks, 10, async (t) => {
    try {
      await t();
    } catch (e) {
      failed++;
      console.warn(JSON.stringify({ level: 'warn', msg: 'discovery source failed', message: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    }
  });

  const excludedCompanies = ((prefs?.excluded_companies ?? []) as string[]).map((c) => normalizeText(c));
  const excludedKeywords = ((prefs?.excluded_keywords ?? []) as string[]).map((k) => normalizeText(k));
  const locPrefs = { workplaceTypes: profile.profile.workplaceTypes, desiredLocations: profile.profile.desiredLocations, city: profile.profile.city, country: profile.profile.country };
  const entryLevel = profile.profile.experienceLevel === 'entry' || (profile.profile.yearsExperience ?? 99) < 1 || /intern|graduate|student/i.test(titles.join(' '));
  const seen = new Set<string>();
  const matches = found
    .map((f) => ({ ...f, fit: titleFit(f.job.title, titles) }))
    .filter(({ job, fit }) => {
      if (fit <= 0 || !isRecent(job.postedAt, RECENT_DAYS)) return false;
      // Internships and new-grad programmes only for people starting out.
      if (!entryLevel && JUNIOR_ONLY.test(job.title)) return false;
      // Same role listed with its cities in a different order is one job.
      const where = normalizeText(job.location ?? '').split(/[;,|/·]+/).map((x) => x.trim()).filter(Boolean).sort().join(',');
      const key = `${normalizeText(job.company)}|${normalizeText(job.title)}|${where}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (excludedCompanies.some((c) => c && normalizeText(job.company).includes(c))) return false;
      const text = normalizeText(`${job.title} ${job.description ?? ''}`);
      if (excludedKeywords.some((k) => k && text.includes(k))) return false;
      return locationFits(job, locPrefs);
    })
    // Best title fit first, then newest; direct company boards (fillable forms) win ties.
    .sort((a, b) => b.fit - a.fit || (Date.parse(b.job.postedAt ?? '') || 0) - (Date.parse(a.job.postedAt ?? '') || 0) || (b.board ? 1 : 0) - (a.board ? 1 : 0))
    .slice(0, MAX_NEW_PER_RUN);

  // Full descriptions only for the Greenhouse postings we keep (they make match scores meaningful).
  await pool(matches.filter((m) => m.board?.kind === 'greenhouse' && !m.job.description), 6, async (m) => {
    m.job = { ...m.job, description: await greenhouseDescription(m.board!.identifier, m.job.externalId, fetchJson).catch(() => null) };
  });

  let added = 0;
  const ids: string[] = [];
  for (const { job } of matches) {
    try {
      const r = await upsertJob(db, userId, { origin: 'discovery', ...job });
      if (r.created && !r.duplicateOf) {
        added++;
        ids.push(r.id);
      }
    } catch (e) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'skipped discovered job', url: job.url, message: e instanceof Error ? e.message : String(e) }));
    }
  }
  if (ids.length) await refreshMatches(db, userId, profile, ids);
  const queued = prefs?.auto_queue === false ? 0 : await autoQueue(ctx, userId, prefs);
  return { ...base, status: 'ok', finishedAt: new Date().toISOString(), scanned: found.length, matched: matches.length, added, queued, sourcesFailed: failed };
}

/**
 * Keep the queue topped up with the best new matches (score >= the person's minimum), enough for about
 * two days at their daily limit. Jobs they skipped or already applied to are never re-queued.
 */
async function autoQueue(ctx: AppContext, userId: string, prefs: Record<string, any> | null): Promise<number> {
  const daily = prefs?.daily_limit ?? 10;
  const queuedNow = await one<{ n: number }>(ctx.db, `select count(*)::int as n from applications where user_id = $1 and state = 'QUEUED'`, [userId]);
  const room = Math.max(0, daily * 2 - (queuedNow?.n ?? 0));
  if (!room) return 0;
  const rows = await many<{ id: string }>(
    ctx.db,
    `select j.id from jobs j join job_matches m on m.job_id = j.id
      where j.user_id = $1 and j.liveness <> 'expired' and m.score >= $2
        and not exists (select 1 from applications a where a.job_id = j.id)
      order by m.score desc, j.posted_at desc nulls last limit $3`,
    [userId, prefs?.min_match_score ?? 50, room],
  );
  if (!rows.length) return 0;
  const res = await enqueueJobs(ctx.db, userId, rows.map((r) => r.id), { actor: 'system' });
  return res.filter((r) => r.status === 'queued').length;
}

/** Background loop: re-run discovery for people whose last run is older than the interval. */
export function startDiscoveryScheduler(ctx: AppContext): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const due = await many<{ user_id: string }>(
        ctx.db,
        `select p.user_id from automation_preferences p join candidate_profiles c on c.user_id = p.user_id
          where p.auto_discover and (cardinality(c.desired_titles) > 0 or exists (select 1 from work_experiences w where w.user_id = p.user_id))
            and (p.last_discovered_at is null or p.last_discovered_at < now() - make_interval(hours => $1))
          order by p.last_discovered_at nulls first limit 3`,
        [ctx.config.DISCOVERY_INTERVAL_HOURS],
      );
      for (const d of due) await runDiscovery(ctx, d.user_id);
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'discovery scheduler failed', message: e instanceof Error ? e.message : String(e) }));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 5 * 60_000);
  setTimeout(tick, 30_000).unref();
  return () => clearInterval(timer);
}
