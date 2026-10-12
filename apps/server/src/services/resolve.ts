import { atsVendorOf, normalizeText, titleFit } from '@applyflux/shared';
import type { AppContext } from '../context';
import { many } from '../db';
import { BOARD_CATALOG } from './board-catalog';
import { fetchBoard, type SourcedJob } from './discovery';

/**
 * Jobs saved from LinkedIn, Indeed, Monster and similar boards are applied to on the employer's own
 * site. This finds the same posting on the employer's public Greenhouse / Lever / Ashby board (the
 * forms ApplyFlux can fill), by company and title. Nothing is fetched from the job board itself.
 */

/** Platforms whose application forms ApplyFlux fills directly. */
const FILLABLE = new Set(['greenhouse', 'lever', 'ashby', 'workday', 'icims', 'smartrecruiters', 'workable', 'bamboohr', 'jobvite', 'teamtailor', 'recruitee', 'personio']);

export function isFillableUrl(url: string) {
  const v = atsVendorOf(url);
  return !!v && FILLABLE.has(v);
}

type Kind = 'greenhouse' | 'lever' | 'ashby';
const boardCache = new Map<string, { at: number; jobs: SourcedJob[] | null }>();
const TTL = 60 * 60_000;

async function board(ctx: AppContext, kind: Kind, slug: string, name: string): Promise<SourcedJob[] | null> {
  const key = `${kind}:${slug.toLowerCase()}`;
  const hit = boardCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.jobs;
  // Missing boards are remembered too, so guesses are not retried for every saved job.
  const jobs = await fetchBoard(kind, slug, name, ctx.fetchJson, { withContent: false }).catch(() => null);
  boardCache.set(key, { at: Date.now(), jobs });
  return jobs;
}

/** Likely board identifiers for a company name: "Scale AI" -> scaleai, scale-ai, scale. */
export function slugCandidates(company: string): string[] {
  // "Kahuna | Skills & Competency Management" -> "Kahuna"
  const base = normalizeText(company.split(/\s[|–—]\s|\s-\s/)[0])
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|technologies|technology|labs?|group|holdings)\b\.?/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim();
  if (!base) return [];
  const words = base.split(/\s+/).filter(Boolean);
  return [...new Set([words.join(''), words.join('-'), words[0], `${words.join('')}hq`, `${words.join('')}inc`].filter((s) => s.length >= 2 && s.length <= 60))];
}

const sameTitle = (a: string, b: string) => {
  const na = normalizeText(a).replace(/[^a-z0-9]+/g, ' ').trim();
  const nb = normalizeText(b).replace(/[^a-z0-9]+/g, ' ').trim();
  if (na === nb) return 1;
  // Both directions must fit: "Senior QA Analyst" vs "QA Analyst, Senior" yes; "QA Analyst" vs "QA Analyst Manager" no.
  return Math.min(titleFit(a, [b]), titleFit(b, [a]));
};

const placeOverlap = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a || !b) return 0;
  const wa = new Set(normalizeText(a).split(/[^a-z]+/).filter((w) => w.length > 2));
  return normalizeText(b).split(/[^a-z]+/).some((w) => w.length > 2 && wa.has(w)) ? 1 : 0;
};

export async function resolveEmployerPosting(ctx: AppContext, userId: string, job: { title: string; company: string; location?: string | null }): Promise<SourcedJob | null> {
  const company = normalizeText(job.company);
  const known = [
    ...BOARD_CATALOG,
    ...(await many<{ kind: Kind; identifier: string; name: string | null }>(ctx.db, 'select kind, identifier, name from job_sources where user_id=$1', [userId])).map((s) => ({ ...s, name: s.name ?? s.identifier })),
  ].filter((b) => normalizeText(b.name) === company || normalizeText(b.identifier) === company.replace(/[^a-z0-9]/g, ''));
  const guesses = slugCandidates(job.company).flatMap((slug) => (['greenhouse', 'ashby', 'lever'] as Kind[]).map((kind) => ({ kind, identifier: slug, name: job.company })));
  const seen = new Set<string>();
  let best: { job: SourcedJob; score: number } | null = null;
  for (const b of [...known, ...guesses].slice(0, 18)) {
    const key = `${b.kind}:${b.identifier.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const postings = await board(ctx, b.kind, b.identifier, b.name);
    if (!postings?.length) continue;
    for (const p of postings) {
      const t = sameTitle(job.title, p.title);
      if (t < 0.6) continue;
      const score = t + 0.2 * placeOverlap(job.location, p.location);
      if (!best || score > best.score) best = { job: { ...p, company: p.company || job.company }, score };
    }
    // A board that matches the company exactly and has an exact title match is good enough.
    if (best && best.score >= 1) break;
  }
  return best?.job ?? null;
}

export interface SavedJobInput {
  url: string;
  title: string;
  company: string;
  location?: string | null;
  description?: string | null;
  /** The employer's application link as shown on the job page, if any. */
  applyUrl?: string | null;
}

const BOARD_HOST = /(^|\.)(linkedin|indeed|monster|glassdoor|ziprecruiter)\.[a-z.]+$/;
const employerUrl = (u?: string | null) => {
  try {
    const x = u ? new URL(u) : null;
    return x && /^https?:$/.test(x.protocol) && !BOARD_HOST.test(x.hostname) ? x.href : null;
  } catch {
    return null;
  }
};

/**
 * Save jobs the person picked on a job board. Each one is matched to the employer's own posting when
 * possible and queued; jobs that cannot be matched are saved for the person to apply to themselves.
 */
export async function saveJobsFromBoard(ctx: AppContext, userId: string, jobs: SavedJobInput[], opts: { queue: boolean }) {
  const { upsertJob, refreshMatches } = await import('./jobs');
  const { enqueueJobs } = await import('./queue');
  const { loadFullProfile } = await import('./profile');
  const results: Array<{ title: string; company: string; status: 'queued' | 'saved' | 'needs_you'; url: string; reason?: string; jobId?: string }> = [];
  const toQueue: string[] = [];
  const ids: string[] = [];
  for (const j of jobs) {
    try {
      const direct = isFillableUrl(j.url);
      // The employer link shown on the job page beats a lookup; otherwise find the posting on the employer's board.
      const shown = direct ? null : employerUrl(j.applyUrl);
      const posting = direct || shown ? null : await resolveEmployerPosting(ctx, userId, j);
      const record = posting
        ? { ...posting, company: posting.company || j.company, description: posting.description ?? j.description ?? null }
        : { url: shown ?? j.url, title: j.title, company: j.company, location: j.location ?? null, description: j.description ?? null };
      const r = await upsertJob(ctx.db, userId, { origin: 'extension', ...record });
      ids.push(r.id);
      if (direct || shown || posting) {
        toQueue.push(r.id);
        results.push({ title: j.title, company: j.company, status: opts.queue ? 'queued' : 'saved', url: record.url, jobId: r.id });
      } else {
        results.push({ title: j.title, company: j.company, status: 'needs_you', url: j.url, reason: "Couldn't find this job on the employer's own site; apply to it yourself from the job page." });
      }
    } catch (e) {
      results.push({ title: j.title, company: j.company, status: 'needs_you', url: j.url, reason: e instanceof Error ? e.message : 'Could not save' });
    }
  }
  if (ids.length) await refreshMatches(ctx.db, userId, await loadFullProfile(ctx.db, userId), ids);
  if (opts.queue && toQueue.length) {
    // Already applied / excluded jobs are reported honestly instead of as queued.
    for (const q of await enqueueJobs(ctx.db, userId, toQueue)) {
      if (q.status === 'queued') continue;
      for (const row of results) if (row.jobId === q.jobId) Object.assign(row, { status: 'saved', reason: q.reason });
    }
  }
  return {
    queued: results.filter((r) => r.status === 'queued').length,
    saved: results.filter((r) => r.status === 'saved').length,
    needsYou: results.filter((r) => r.status === 'needs_you').length,
    results,
  };
}
