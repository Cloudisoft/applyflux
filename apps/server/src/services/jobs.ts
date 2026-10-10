import {
  atsVendorOf,
  computeMatch,
  jobFingerprint,
  normalizeText,
  sponsorshipUnavailable,
  urlKey,
  type JobSearchQuery,
  type MatchProfile,
  type FullCandidateProfile,
} from '@applyflux/shared';
import { camel, many, one, type Queryable } from '../db';
import { AppError } from '../lib/errors';
import type { SourcedJob } from './discovery';

export interface JobInsert {
  origin: 'source' | 'import' | 'extension' | 'discovery';
  sourceId?: string | null;
  externalId?: string | null;
  url: string;
  title: string;
  company: string;
  location?: string | null;
  workplaceType?: string | null;
  employmentType?: string | null;
  description?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  postedAt?: string | null;
}

/** Insert or refresh a job; duplicates (same canonical URL) are merged, never duplicated. */
export async function upsertJob(q: Queryable, userId: string, j: JobInsert): Promise<{ id: string; created: boolean; duplicateOf: string | null }> {
  const key = urlKey(j.url);
  if (!key) throw new AppError('VALIDATION_FAILED', 'Job URL must be an http(s) URL');
  const fp = jobFingerprint(j.company, j.title, j.location);
  const r = await one<{ id: string; created: boolean }>(
    q,
    `insert into jobs (user_id, source_id, origin, external_id, url, url_key, fingerprint, company, title, location, workplace_type,
        employment_type, salary_min, salary_max, salary_currency, description, posted_at, ats_vendor)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     on conflict (user_id, url_key) do update set
        last_seen_at = now(),
        title = excluded.title,
        location = coalesce(excluded.location, jobs.location),
        description = coalesce(excluded.description, jobs.description),
        salary_min = coalesce(excluded.salary_min, jobs.salary_min),
        salary_max = coalesce(excluded.salary_max, jobs.salary_max),
        liveness = case when jobs.liveness = 'expired' and excluded.origin = 'source' then 'active' else jobs.liveness end
     returning id, (xmax = 0) as created`,
    [
      userId, j.sourceId ?? null, j.origin, j.externalId ?? null, j.url, key, fp, j.company.slice(0, 200), j.title.slice(0, 300),
      j.location ?? null, j.workplaceType ?? null, j.employmentType ?? null, j.salaryMin ?? null, j.salaryMax ?? null,
      j.salaryCurrency ?? null, j.description?.slice(0, 60000) ?? null, j.postedAt ?? null, atsVendorOf(j.url),
    ],
  );
  // Cross-source duplicate: same company/title/location from another URL.
  const dup = await one<{ id: string }>(q, `select id from jobs where user_id=$1 and fingerprint=$2 and id<>$3 order by created_at limit 1`, [userId, fp, r!.id]);
  return { id: r!.id, created: r!.created, duplicateOf: dup?.id ?? null };
}

export async function upsertSourcedJobs(q: Queryable, userId: string, sourceId: string, jobs: SourcedJob[]) {
  let created = 0;
  let skipped = 0;
  for (const j of jobs) {
    // One malformed posting must not abort the whole sync.
    try {
      const r = await upsertJob(q, userId, { origin: 'source', sourceId, ...j });
      if (r.created) created++;
    } catch (e) {
      skipped++;
      console.warn(JSON.stringify({ level: 'warn', msg: 'skipped sourced job', sourceId, url: j.url, message: e instanceof Error ? e.message : String(e) }));
    }
  }
  // Postings that vanished from the board are expired (source data permits it).
  const keys = jobs.map((j) => urlKey(j.url)).filter(Boolean);
  const expired = await q.query(
    `update jobs set liveness='expired', liveness_reason='No longer listed on the source board', liveness_checked_at=now()
      where user_id=$1 and source_id=$2 and liveness <> 'expired' and not (url_key = any($3::text[])) returning id`,
    [userId, sourceId, keys],
  );
  return { created, skipped, total: jobs.length, expired: expired.rowCount ?? 0 };
}

export function matchProfileFrom(p: FullCandidateProfile): MatchProfile {
  return {
    skills: p.profile.skills,
    desiredTitles: p.profile.desiredTitles,
    yearsExperience: p.profile.yearsExperience,
    experienceLevel: p.profile.experienceLevel,
    desiredLocations: [...p.profile.desiredLocations, p.profile.city ?? ''].filter(Boolean),
    workplaceTypes: p.profile.workplaceTypes,
    employmentTypes: p.profile.employmentTypes,
    desiredSalaryMin: p.profile.desiredSalaryMin,
    requiresSponsorship: p.profile.workAuthorizations.some((w) => w.requiresSponsorship) ? true : p.profile.workAuthorizations.length ? false : null,
    pastTitles: p.experiences.map((e) => e.title),
  };
}

/** Recompute match scores for jobs whose score is missing or stale (profile changed). */
export async function refreshMatches(q: Queryable, userId: string, profile: FullCandidateProfile & { version: number }, onlyJobIds?: string[]) {
  const rows = await many<Record<string, any>>(
    q,
    `select j.id, j.title, j.company, j.description, j.location, j.workplace_type, j.employment_type, j.salary_min, j.salary_max
       from jobs j left join job_matches m on m.job_id = j.id
      where j.user_id = $1 and (m.job_id is null or m.profile_version <> $2) ${onlyJobIds ? 'and j.id = any($3::uuid[])' : ''}
      limit 2000`,
    onlyJobIds ? [userId, profile.version, onlyJobIds] : [userId, profile.version],
  );
  const mp = matchProfileFrom(profile);
  for (const r of rows) {
    const m = computeMatch(mp, {
      title: r.title, company: r.company, description: r.description, location: r.location, workplaceType: r.workplace_type,
      employmentType: r.employment_type, salaryMin: r.salary_min, salaryMax: r.salary_max,
    });
    await q.query(
      `insert into job_matches (job_id, user_id, score, breakdown, profile_version) values ($1,$2,$3,$4,$5)
       on conflict (job_id) do update set score=excluded.score, breakdown=excluded.breakdown, profile_version=excluded.profile_version, computed_at=now()`,
      [r.id, userId, m.score, JSON.stringify(m), profile.version],
    );
  }
  return rows.length;
}

export interface Exclusions {
  excludedCompanies: string[];
  excludedKeywords: string[];
  requireSponsorshipFriendly: boolean;
}

/** Why a job should not be applied to automatically (null = eligible). */
export function exclusionReason(job: { company: string; title: string; description: string | null; liveness: string }, ex: Exclusions): string | null {
  if (job.liveness === 'expired') return 'Listing has expired';
  const company = normalizeText(job.company);
  if (ex.excludedCompanies.some((c) => c && company.includes(normalizeText(c)))) return 'Company is on your exclusion list';
  const text = normalizeText(`${job.title} ${job.description ?? ''}`);
  const kw = ex.excludedKeywords.find((k) => k && text.includes(normalizeText(k)));
  if (kw) return `Contains excluded keyword "${kw}"`;
  if (ex.requireSponsorshipFriendly && sponsorshipUnavailable(job.description)) return 'Posting states sponsorship is unavailable';
  return null;
}

export async function searchJobs(q: Queryable, userId: string, s: JobSearchQuery) {
  const where = ['j.user_id = $1'];
  const p: unknown[] = [userId];
  const add = (sql: string, v: unknown) => {
    p.push(v);
    where.push(sql.replace('?', `$${p.length}`));
  };
  if (s.q) add(`(j.title ilike ? or j.company ilike $${p.length + 1} or j.description ilike $${p.length + 1})`, `%${s.q}%`);
  if (s.location) add('j.location ilike ?', `%${s.location}%`);
  if (s.remoteOnly) where.push(`(j.workplace_type = 'remote' or j.location ilike '%remote%')`);
  if (s.workplaceType) add('j.workplace_type = ?', s.workplaceType);
  if (s.employmentType) add('j.employment_type = ?', s.employmentType);
  if (s.salaryMin) add('coalesce(j.salary_max, j.salary_min) >= ?', s.salaryMin);
  if (s.company) add('j.company ilike ?', `%${s.company}%`);
  if (s.minScore != null) add('coalesce(m.score, 0) >= ?', s.minScore);
  if (s.bookmarked) where.push('j.is_bookmarked');
  if (s.excludeApplied) where.push(`(a.state is null or a.state in ('DISCOVERED','SHORTLISTED'))`);
  if (s.sponsorshipOk) where.push(`not (j.description ~* '(no|not|unable to|cannot|will not)\\s+(provide\\s+|offer\\s+)?(visa\\s+)?sponsor')`);
  const order = s.sort === 'recent' ? 'coalesce(j.posted_at, j.created_at) desc' : s.sort === 'company' ? 'j.company asc, j.title asc' : 'm.score desc nulls last, j.created_at desc';
  const base = `from jobs j left join job_matches m on m.job_id = j.id left join applications a on a.job_id = j.id and a.user_id = j.user_id where ${where.join(' and ')}`;
  const total = await one<{ n: string }>(q, `select count(*) as n ${base}`, p);
  const rows = await many(
    q,
    `select j.id, j.url, j.company, j.title, j.location, j.workplace_type, j.employment_type, j.salary_min, j.salary_max, j.salary_currency,
            j.posted_at, j.ats_vendor, j.liveness, j.liveness_reason, j.is_bookmarked, j.origin, j.created_at,
            m.score, m.breakdown, a.id as application_id, a.state as application_state
       ${base} order by ${order} limit ${s.pageSize} offset ${(s.page - 1) * s.pageSize}`,
    p,
  );
  return { items: rows.map((r) => camel(r)), total: Number(total?.n ?? 0), page: s.page, pageSize: s.pageSize };
}
