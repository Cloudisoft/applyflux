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

export async function fetchBoard(kind: SourceKind, identifier: string, companyName: string, fetchJson: FetchJson): Promise<SourcedJob[]> {
  if (!SLUG.test(identifier)) throw new Error('Invalid board identifier');
  if (kind === 'greenhouse') {
    const url = assertHost(kind, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identifier)}/jobs?content=true`);
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
