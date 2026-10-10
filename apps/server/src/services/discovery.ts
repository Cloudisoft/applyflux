/**
 * Job discovery from open, unauthenticated, public ATS job-board APIs.
 * Approach and SSRF hardening follow career-ops providers/greenhouse.mjs,
 * lever.mjs and ashby.mjs (MIT): fixed HTTPS host allowlists, redirect:'error',
 * board identifiers validated before they reach a URL.
 *
 * These are the employers' own public posting feeds, published for exactly
 * this kind of consumption. No scraping, no logged-in sources.
 */

export interface SourcedJob {
  externalId: string;
  url: string;
  title: string;
  company: string;
  location: string | null;
  workplaceType: 'remote' | 'hybrid' | 'onsite' | null;
  employmentType: string | null;
  description: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postedAt: string | null;
}

export type SourceKind = 'greenhouse' | 'lever' | 'ashby';

const HOSTS: Record<SourceKind, Set<string>> = {
  greenhouse: new Set(['boards-api.greenhouse.io']),
  lever: new Set(['api.lever.co', 'api.eu.lever.co']),
  ashby: new Set(['api.ashbyhq.com']),
};

const SLUG = /^[A-Za-z0-9._-]{1,100}$/;

export type FetchJson = (url: string) => Promise<{ status: number; json: unknown }>;

export function makeFetchJson(fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): FetchJson {
  return async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { redirect: 'error', signal: ctrl.signal, headers: { accept: 'application/json', 'user-agent': 'ApplyFlux/0.1 (+job discovery)' } });
      const json = res.status === 200 ? await res.json() : null;
      return { status: res.status, json };
    } finally {
      clearTimeout(t);
    }
  };
}

function assertHost(kind: SourceKind, url: string) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !HOSTS[kind].has(u.hostname)) throw new Error(`${kind}: refusing untrusted host ${u.hostname}`);
  return url;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+|#\d+);/gi, (m, e: string) => {
    if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return m;
  });
}
/** Greenhouse double-encodes HTML content: decode, strip tags, decode again. */
export function htmlToText(html: unknown): string {
  if (typeof html !== 'string' || !html) return '';
  const once = decodeEntities(html);
  return decodeEntities(
    once
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|li|h\d|br)>|<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function workplace(location: string, remoteFlag?: boolean | null, wt?: string | null): SourcedJob['workplaceType'] {
  const s = `${wt ?? ''} ${location}`.toLowerCase();
  if (remoteFlag || /remote|anywhere|distributed/.test(s)) return 'remote';
  if (/hybrid/.test(s)) return 'hybrid';
  if (/on-?site|in[- ]office/.test(s)) return 'onsite';
  return null;
}

function employment(s: string | null | undefined): string | null {
  const t = (s ?? '').toLowerCase();
  if (/full/.test(t)) return 'full_time';
  if (/part/.test(t)) return 'part_time';
  if (/contract|freelance/.test(t)) return 'contract';
  if (/intern/.test(t)) return 'internship';
  if (/temp/.test(t)) return 'temporary';
  return null;
}

const iso = (v: unknown) => {
  if (v == null || v === '') return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** `withContent: false` skips Greenhouse descriptions (much smaller); fetch them per job with greenhouseDescription(). */
export async function fetchBoard(kind: SourceKind, identifier: string, companyName: string, fetchJson: FetchJson, opts: { withContent?: boolean } = {}): Promise<SourcedJob[]> {
  if (!SLUG.test(identifier)) throw new Error('Invalid board identifier');
  if (kind === 'greenhouse') {
    const url = assertHost(kind, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identifier)}/jobs${opts.withContent === false ? '' : '?content=true'}`);
    const { status, json } = await fetchJson(url);
    if (status === 404) throw new Error(`Greenhouse board "${identifier}" not found`);
    if (status !== 200) throw new Error(`Greenhouse returned HTTP ${status}`);
    const jobs = ((json as { jobs?: unknown[] })?.jobs ?? []) as Array<Record<string, any>>;
    return jobs
      .filter((j) => j.absolute_url)
      .map((j) => {
        const location = j.location?.name ?? '';
        return {
          externalId: String(j.id),
          url: j.absolute_url,
          title: j.title ?? '',
          company: companyName,
          location: location || null,
          workplaceType: workplace(location),
          employmentType: null,
          description: htmlToText(j.content) || null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          postedAt: iso(j.first_published ?? j.updated_at),
        };
      });
  }
  if (kind === 'lever') {
    const url = assertHost(kind, `https://api.lever.co/v0/postings/${encodeURIComponent(identifier)}?mode=json`);
    const { status, json } = await fetchJson(url);
    if (status === 404) throw new Error(`Lever board "${identifier}" not found`);
    if (status !== 200 || !Array.isArray(json)) throw new Error(`Lever returned HTTP ${status}`);
    return (json as Array<Record<string, any>>).map((j) => {
      const cats = j.categories ?? {};
      const locs = [cats.location, ...(Array.isArray(cats.allLocations) ? cats.allLocations : [])].filter((x, i, a) => x && a.indexOf(x) === i);
      const location = locs.join('; ');
      const sr = j.salaryRange;
      return {
        externalId: String(j.id),
        url: j.hostedUrl,
        title: j.text ?? '',
        company: companyName,
        location: location || null,
        workplaceType: workplace(location, null, j.workplaceType),
        employmentType: employment(cats.commitment),
        description: typeof j.descriptionPlain === 'string' ? `${j.descriptionPlain}\n\n${(j.lists ?? []).map((l: any) => `${l.text}\n${htmlToText(l.content)}`).join('\n\n')}`.trim() : null,
        salaryMin: typeof sr?.min === 'number' ? Math.round(sr.min) : null,
        salaryMax: typeof sr?.max === 'number' ? Math.round(sr.max) : null,
        salaryCurrency: typeof sr?.currency === 'string' ? sr.currency.slice(0, 3) : null,
        postedAt: iso(j.createdAt),
      };
    });
  }
  const url = assertHost(kind, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(identifier)}?includeCompensation=true`);
  const { status, json } = await fetchJson(url);
  if (status === 404) throw new Error(`Ashby board "${identifier}" not found`);
  if (status !== 200) throw new Error(`Ashby returned HTTP ${status}`);
  const jobs = ((json as { jobs?: unknown[] })?.jobs ?? []) as Array<Record<string, any>>;
  return jobs
    .filter((j) => j.jobUrl && j.isListed !== false)
    .map((j) => {
      const location = [j.location, ...(Array.isArray(j.secondaryLocations) ? j.secondaryLocations.map((s: any) => s.location) : [])].filter(Boolean).join('; ');
      const comp = j.compensation?.summaryComponents?.find?.((c: any) => c.compensationType === 'Salary');
      return {
        externalId: String(j.id),
        url: j.jobUrl,
        title: j.title ?? '',
        company: companyName,
        location: location || null,
        workplaceType: workplace(location, j.isRemote, j.workplaceType),
        employmentType: employment(j.employmentType),
        description: typeof j.descriptionPlain === 'string' ? j.descriptionPlain : htmlToText(j.descriptionHtml) || null,
        salaryMin: typeof comp?.minValue === 'number' ? Math.round(comp.minValue) : null,
        salaryMax: typeof comp?.maxValue === 'number' ? Math.round(comp.maxValue) : null,
        salaryCurrency: typeof comp?.currencyCode === 'string' ? comp.currencyCode : null,
        postedAt: iso(j.publishedAt),
      };
    });
}

/** One Greenhouse posting's description (used after filtering, so only matching jobs are downloaded in full). */
export async function greenhouseDescription(identifier: string, jobId: string, fetchJson: FetchJson): Promise<string | null> {
  if (!SLUG.test(identifier) || !/^\d{1,20}$/.test(jobId)) return null;
  const url = assertHost('greenhouse', `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identifier)}/jobs/${jobId}`);
  const { status, json } = await fetchJson(url);
  if (status !== 200) return null;
  return htmlToText((json as { content?: string })?.content) || null;
}

/* ------------------------------------------------------------------ */
/* Public job feeds (aggregators). Ported from career-ops providers   */
/* (remotive, remoteok, arbeitnow, himalayas, themuse; MIT).           */
/* ------------------------------------------------------------------ */

export type FeedId = 'remotive' | 'remoteok' | 'arbeitnow' | 'himalayas' | 'themuse' | 'adzuna';
const FEED_HOSTS: Record<FeedId, string> = {
  remotive: 'remotive.com',
  remoteok: 'remoteok.com',
  arbeitnow: 'www.arbeitnow.com',
  himalayas: 'himalayas.app',
  themuse: 'www.themuse.com',
  adzuna: 'api.adzuna.com',
};
function feedUrl(id: FeedId, url: string) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== FEED_HOSTS[id]) throw new Error(`${id}: refusing untrusted host ${u.hostname}`);
  return url;
}
const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
};
const epoch = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return iso(v);
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
};
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const textOf = (v: unknown, max = 20000) => (typeof v === 'string' ? htmlToText(v).slice(0, max) || null : null);

/** The Muse categories, matched against the person's target titles. */
const MUSE_CATEGORIES: Array<[RegExp, string]> = [
  [/engineer|developer|software|devops|sre|programmer/i, 'Software Engineering'],
  [/data|analyst|analytics|scientist|machine learning|\bml\b|\bai\b/i, 'Data and Analytics'],
  [/design|ux|ui\b/i, 'Design and UX'],
  [/product manager|product owner/i, 'Product Management'],
  [/project|program manager|scrum/i, 'Project Management'],
  [/sales|account (executive|manager)|business development/i, 'Sales'],
  [/marketing|growth|seo|content/i, 'Marketing'],
  [/customer|support|success/i, 'Customer Service'],
  [/nurse|clinical|medical|health|physician|therap/i, 'Healthcare'],
  [/teacher|education|tutor|instructor/i, 'Education'],
  [/account|finance|financial|audit|tax|controller/i, 'Accounting and Finance'],
  [/recruit|talent|hr\b|human resources|people/i, 'Human Resources and Recruitment'],
  [/admin|assistant|office|reception/i, 'Administration and Office'],
  [/writer|editor|journalist|copy/i, 'Writing and Editing'],
  [/legal|lawyer|attorney|paralegal|counsel/i, 'Legal Services'],
];

const ADZUNA_COUNTRIES: Record<string, string> = {
  'united states': 'us', usa: 'us', us: 'us', 'united kingdom': 'gb', uk: 'gb', canada: 'ca', india: 'in', australia: 'au', germany: 'de',
  france: 'fr', netherlands: 'nl', spain: 'es', italy: 'it', poland: 'pl', brazil: 'br', mexico: 'mx', singapore: 'sg', 'new zealand': 'nz',
  austria: 'at', belgium: 'be', switzerland: 'ch', 'south africa': 'za',
};

/**
 * Fetch recent postings from one public feed. `titles` narrows feeds that support search; the
 * caller filters everything by title, location and recency afterwards.
 */
export async function fetchFeed(
  id: FeedId,
  ctx: { titles: string[]; country: string | null; city: string | null; fetchJson: FetchJson; adzuna?: { appId: string; appKey: string } | null },
): Promise<SourcedJob[]> {
  const { fetchJson } = ctx;
  const get = async (url: string) => {
    const r = await fetchJson(feedUrl(id, url));
    if (r.status !== 200) throw new Error(`${id} returned HTTP ${r.status}`);
    return r.json as any;
  };
  const out: SourcedJob[] = [];
  const push = (j: { [K in keyof SourcedJob]?: SourcedJob[K] | null } & { url: string | null; title: string; company: string }) => {
    if (!j.url || !j.title) return;
    out.push({
      externalId: j.externalId ?? j.url,
      url: j.url,
      title: j.title.trim().slice(0, 300),
      company: (j.company || 'Unknown company').trim().slice(0, 200),
      location: j.location?.trim() || null,
      workplaceType: j.workplaceType ?? workplace(j.location ?? ''),
      employmentType: j.employmentType ?? null,
      description: j.description ?? null,
      salaryMin: j.salaryMin ?? null,
      salaryMax: j.salaryMax ?? null,
      salaryCurrency: j.salaryCurrency ?? null,
      postedAt: j.postedAt ?? null,
    });
  };

  if (id === 'remotive') {
    const json = await get('https://remotive.com/api/remote-jobs');
    for (const j of (json?.jobs ?? []) as Array<Record<string, any>>)
      push({ externalId: `remotive:${j.id}`, url: httpsUrl(j.url), title: j.title, company: j.company_name, location: j.candidate_required_location ? `Remote (${j.candidate_required_location})` : 'Remote', workplaceType: 'remote', employmentType: employment(j.job_type), description: textOf(j.description), postedAt: iso(j.publication_date) });
  } else if (id === 'remoteok') {
    const json = await get('https://remoteok.com/api');
    for (const j of (Array.isArray(json) ? json : []) as Array<Record<string, any>>) {
      if (!j?.position) continue;
      push({ externalId: `remoteok:${j.id}`, url: httpsUrl(j.apply_url) ?? httpsUrl(j.url), title: j.position, company: j.company, location: j.location ? `Remote (${j.location})` : 'Remote', workplaceType: 'remote', description: textOf(j.description), salaryMin: num(j.salary_min), salaryMax: num(j.salary_max), salaryCurrency: num(j.salary_min) ? 'USD' : null, postedAt: epoch(j.epoch) ?? iso(j.date) });
    }
  } else if (id === 'arbeitnow') {
    for (let page = 1; page <= 2; page++) {
      const json = await get(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
      for (const j of (json?.data ?? []) as Array<Record<string, any>>)
        push({ externalId: `arbeitnow:${j.slug}`, url: httpsUrl(j.url), title: j.title, company: j.company_name, location: [j.location, j.remote ? 'Remote' : ''].filter(Boolean).join(' · '), workplaceType: j.remote ? 'remote' : null, description: textOf(j.description), postedAt: epoch(j.created_at) });
    }
  } else if (id === 'himalayas') {
    for (const t of ctx.titles.slice(0, 4)) {
      const json = await get(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(t)}&sort=recent`);
      for (const j of (json?.jobs ?? []) as Array<Record<string, any>>) {
        const regions = Array.isArray(j.locationRestrictions) ? j.locationRestrictions.join(', ') : '';
        push({ externalId: `himalayas:${j.guid}`, url: httpsUrl(j.applicationLink) ?? httpsUrl(j.guid), title: j.title, company: j.companyName, location: regions ? `Remote (${regions})` : 'Remote', workplaceType: 'remote', employmentType: employment(j.employmentType), description: textOf(j.description), salaryMin: num(j.minSalary), salaryMax: num(j.maxSalary), salaryCurrency: typeof j.currency === 'string' ? j.currency.slice(0, 3) : null, postedAt: epoch(j.pubDate) });
      }
    }
  } else if (id === 'themuse') {
    const cats = [...new Set(ctx.titles.flatMap((t) => MUSE_CATEGORIES.filter(([re]) => re.test(t)).map(([, c]) => c)))].slice(0, 3);
    for (const c of cats) {
      for (let page = 1; page <= 2; page++) {
        const json = await get(`https://www.themuse.com/api/public/jobs?page=${page}&descending=true&category=${encodeURIComponent(c)}`);
        for (const j of (json?.results ?? []) as Array<Record<string, any>>) {
          const locs = Array.isArray(j.locations) ? j.locations.map((l: any) => l?.name).filter(Boolean).join('; ') : '';
          push({ externalId: `themuse:${j.id}`, url: httpsUrl(j.refs?.landing_page), title: j.name, company: j.company?.name, location: locs, workplaceType: /flexible|remote/i.test(locs) ? 'remote' : null, description: textOf(j.contents), postedAt: iso(j.publication_date) });
        }
      }
    }
  } else if (id === 'adzuna') {
    // Broad, many-country search engine. Optional: needs ADZUNA_APP_ID / ADZUNA_APP_KEY (free at developer.adzuna.com).
    if (!ctx.adzuna) return [];
    const cc = ADZUNA_COUNTRIES[normalizeCountry(ctx.country)] ?? 'us';
    for (const t of ctx.titles.slice(0, 4)) {
      const where = ctx.city ? `&where=${encodeURIComponent(ctx.city)}` : '';
      const json = await get(`https://api.adzuna.com/v1/api/jobs/${cc}/search/1?app_id=${encodeURIComponent(ctx.adzuna.appId)}&app_key=${encodeURIComponent(ctx.adzuna.appKey)}&results_per_page=50&max_days_old=21&sort_by=date&what=${encodeURIComponent(t)}${where}&content-type=application/json`);
      for (const j of (json?.results ?? []) as Array<Record<string, any>>)
        push({ externalId: `adzuna:${j.id}`, url: httpsUrl(j.redirect_url), title: htmlToText(j.title), company: j.company?.display_name, location: j.location?.display_name ?? null, employmentType: employment(j.contract_time), description: textOf(j.description), salaryMin: num(j.salary_min), salaryMax: num(j.salary_max), postedAt: iso(j.created) });
    }
  }
  return out;
}

function normalizeCountry(c: string | null): string {
  return (c ?? '').toLowerCase().replace(/[^a-z ]/g, '').trim();
}

/** Identify a board from a careers URL the person pasted. */
export function boardFromUrl(raw: string): { kind: SourceKind; identifier: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const seg = u.pathname.split('/').filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(u.hostname)) {
    const id = u.searchParams.get('for') ?? (seg[0] === 'embed' ? null : seg[0]);
    return id && SLUG.test(id) ? { kind: 'greenhouse', identifier: id } : null;
  }
  if (/^jobs\.(eu\.)?lever\.co$/.test(u.hostname) && seg[0] && SLUG.test(seg[0])) return { kind: 'lever', identifier: seg[0] };
  if (u.hostname === 'jobs.ashbyhq.com' && seg[0] && SLUG.test(seg[0])) return { kind: 'ashby', identifier: seg[0] };
  return null;
}

/**
 * Liveness for postings from a known board: a job that the board's own API
 * no longer lists (or returns 404 for) is expired. Anything else stays
 * uncertain rather than being guessed expired.
 */
export async function checkPostingLive(url: string, fetchJson: FetchJson): Promise<{ result: 'active' | 'expired' | 'uncertain'; reason: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { result: 'uncertain', reason: 'Invalid URL' };
  }
  const seg = u.pathname.split('/').filter(Boolean);
  try {
    if (/(^|\.)greenhouse\.io$/.test(u.hostname)) {
      const board = seg[0];
      const id = u.searchParams.get('gh_jid') ?? seg[seg.indexOf('jobs') + 1];
      if (!board || !id || !SLUG.test(board) || !/^\d+$/.test(id)) return { result: 'uncertain', reason: 'Unrecognised Greenhouse URL' };
      const { status } = await fetchJson(assertHost('greenhouse', `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`));
      return status === 200 ? { result: 'active', reason: 'Listed on Greenhouse board' } : status === 404 ? { result: 'expired', reason: 'Greenhouse no longer lists this job' } : { result: 'uncertain', reason: `HTTP ${status}` };
    }
    if (/^jobs\.(eu\.)?lever\.co$/.test(u.hostname) && seg.length >= 2) {
      if (!SLUG.test(seg[0]) || !/^[0-9a-f-]{36}$/i.test(seg[1])) return { result: 'uncertain', reason: 'Unrecognised Lever URL' };
      const { status } = await fetchJson(assertHost('lever', `https://api.lever.co/v0/postings/${seg[0]}/${seg[1]}`));
      return status === 200 ? { result: 'active', reason: 'Listed on Lever' } : status === 404 ? { result: 'expired', reason: 'Lever no longer lists this job' } : { result: 'uncertain', reason: `HTTP ${status}` };
    }
  } catch (e) {
    return { result: 'uncertain', reason: e instanceof Error ? e.message : 'check failed' };
  }
  return { result: 'uncertain', reason: 'Liveness can only be checked for Greenhouse and Lever postings' };
}
