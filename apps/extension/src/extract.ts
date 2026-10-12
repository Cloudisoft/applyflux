/**
 * Read job listings from the page the person has open, only when they click "Save to ApplyFlux".
 * Nothing here navigates, scrolls, paginates or clicks: it reads what is already on screen.
 */

export interface ClippedJob {
  url: string;
  title: string;
  company: string;
  location?: string | null;
  description?: string | null;
  /** The employer's own application link, when the job page shows it. */
  applyUrl?: string | null;
}

const JOB_BOARD_HOSTS = /(^|\.)(linkedin|indeed|monster|glassdoor|ziprecruiter)\.[a-z.]+$/;

/** Accept only a real off-board http(s) link (the employer's site), unwrapping job-board redirect links. */
export function employerLink(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    let u = new URL(raw, base);
    const inner = u.searchParams.get('url') || u.searchParams.get('dest') || u.searchParams.get('redirect');
    if (JOB_BOARD_HOSTS.test(u.hostname) && inner) u = new URL(inner);
    if (!/^https?:$/.test(u.protocol) || JOB_BOARD_HOSTS.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

export type Site = 'linkedin' | 'indeed' | 'monster' | 'mygreenhouse' | 'other';

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const text = (root: ParentNode, ...selectors: string[]) => {
  for (const sel of selectors) {
    const t = clean(root.querySelector(sel)?.textContent);
    if (t) return t;
  }
  return '';
};
const abs = (href: string | null | undefined, base: string) => {
  try {
    return href ? new URL(href, base).href : '';
  } catch {
    return '';
  }
};

export function siteOf(href: string): Site {
  const h = new URL(href).hostname;
  if (/(^|\.)linkedin\.com$/.test(h)) return 'linkedin';
  if (/(^|\.)indeed\.[a-z.]+$/.test(h)) return 'indeed';
  if (/(^|\.)monster\.[a-z.]+$/.test(h)) return 'monster';
  if (h === 'my.greenhouse.io') return 'mygreenhouse';
  return 'other';
}

/** schema.org JobPosting markup, which most job pages include for search engines. */
export function jsonLdJobs(doc: Document, href: string): ClippedJob[] {
  const out: ClippedJob[] = [];
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? '');
    } catch {
      continue;
    }
    const items = (Array.isArray(data) ? data : [data]).flatMap((d) => (d && typeof d === 'object' && Array.isArray((d as { '@graph'?: unknown[] })['@graph']) ? (d as { '@graph': unknown[] })['@graph'] : [d]));
    for (const it of items as Array<Record<string, any>>) {
      const type = it?.['@type'];
      if (!(type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting')))) continue;
      const org = typeof it.hiringOrganization === 'string' ? it.hiringOrganization : it.hiringOrganization?.name;
      const locs = (Array.isArray(it.jobLocation) ? it.jobLocation : it.jobLocation ? [it.jobLocation] : [])
        .map((l: any) => [l?.address?.addressLocality, l?.address?.addressRegion, l?.address?.addressCountry?.name ?? l?.address?.addressCountry].filter(Boolean).join(', '))
        .filter(Boolean);
      const remote = it.jobLocationType === 'TELECOMMUTE' ? 'Remote' : '';
      const desc = typeof it.description === 'string' ? clean(it.description.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')) : '';
      const title = clean(it.title);
      if (!title || !org) continue;
      out.push({ url: abs(it.url, href) || href, title, company: clean(org), location: [remote, ...locs].filter(Boolean).join('; ') || null, description: desc.slice(0, 20000) || null });
    }
  }
  return out;
}

function linkedin(doc: Document, href: string): { detail: ClippedJob | null; list: ClippedJob[] } {
  const u = new URL(href);
  const id = u.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] ?? u.searchParams.get('currentJobId');
  let detail: ClippedJob | null = null;
  if (id) {
    const title = text(doc, '.job-details-jobs-unified-top-card__job-title', '.jobs-unified-top-card__job-title', '.top-card-layout__title', 'h1');
    const company = text(doc, '.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name', '.topcard__org-name-link', '.top-card-layout__second-subline a');
    const location = text(doc, '.job-details-jobs-unified-top-card__primary-description-container .tvm__text', '.job-details-jobs-unified-top-card__bullet', '.jobs-unified-top-card__bullet', '.topcard__flavor--bullet');
    const description = text(doc, '#job-details', '.jobs-description__content', '.description__text');
    // External-apply jobs carry the employer link in the page (hidden applyUrl, or the apply anchor).
    const coded = doc.querySelector('code#applyUrl')?.innerHTML.match(/"(https?:[^"]+)"/)?.[1];
    const anchor = doc.querySelector<HTMLAnchorElement>('a[href*="externalApply"], a.jobs-apply-button[href], a[data-tracking-control-name*="apply"][href]')?.getAttribute('href');
    const applyUrl = employerLink(coded, href) ?? employerLink(anchor, href);
    if (title && company) detail = { url: `https://www.linkedin.com/jobs/view/${id}/`, title, company, location: location || null, description: description.slice(0, 20000) || null, applyUrl };
  }
  const list: ClippedJob[] = [];
  for (const card of Array.from(doc.querySelectorAll<HTMLElement>('[data-occludable-job-id], [data-job-id], .job-search-card, .base-card'))) {
    const cid = card.getAttribute('data-occludable-job-id') || card.getAttribute('data-job-id') || card.querySelector('a[href*="/jobs/view/"]')?.getAttribute('href')?.match(/\/jobs\/view\/(?:[^/?]*-)?(\d+)/)?.[1];
    if (!cid) continue;
    const title = text(card, '.job-card-list__title--link strong', '.job-card-list__title', '.job-card-container__link strong', '.base-search-card__title', 'a[href*="/jobs/view/"]');
    const company = text(card, '.artdeco-entity-lockup__subtitle', '.job-card-container__primary-description', '.base-search-card__subtitle', '.job-card-container__company-name');
    const location = text(card, '.job-card-container__metadata-wrapper li', '.job-card-container__metadata-item', '.artdeco-entity-lockup__caption', '.job-search-card__location');
    if (title && company) list.push({ url: `https://www.linkedin.com/jobs/view/${cid}/`, title, company, location: location || null });
  }
  return { detail, list };
}

function indeed(doc: Document, href: string): { detail: ClippedJob | null; list: ClippedJob[] } {
  const u = new URL(href);
  const origin = `${u.protocol}//${u.host}`;
  const jk = u.searchParams.get('jk') || u.searchParams.get('vjk');
  let detail: ClippedJob | null = null;
  const title = text(doc, '[data-testid="jobsearch-JobInfoHeader-title"]', 'h1.jobsearch-JobInfoHeader-title', '.jobsearch-JobInfoHeader-title');
  const company = text(doc, '[data-testid="inlineHeader-companyName"]', '[data-company-name="true"]', '.jobsearch-CompanyInfoContainer a');
  if (jk && title && company) {
    detail = {
      url: `${origin}/viewjob?jk=${encodeURIComponent(jk)}`,
      title: title.replace(/\s*-\s*job post$/i, ''),
      company,
      location: text(doc, '[data-testid="inlineHeader-companyLocation"]', '[data-testid="job-location"]', '#jobLocationText') || null,
      description: text(doc, '#jobDescriptionText').slice(0, 20000) || null,
      applyUrl: employerLink(doc.querySelector<HTMLAnchorElement>('#applyButtonLinkContainer a[href], a[href*="applystart"], a[aria-label*="company site" i]')?.getAttribute('href'), href),
    };
  }
  const list: ClippedJob[] = [];
  for (const card of Array.from(doc.querySelectorAll<HTMLElement>('.job_seen_beacon, [data-testid="slider_item"], .result'))) {
    const a = card.querySelector<HTMLAnchorElement>('a[data-jk], h2.jobTitle a, a.jcs-JobTitle');
    const id = a?.getAttribute('data-jk') || abs(a?.getAttribute('href'), href).match(/[?&](?:jk|vjk)=([a-z0-9]+)/i)?.[1];
    if (!id) continue;
    const t = clean(card.querySelector('h2.jobTitle span[title]')?.getAttribute('title')) || text(card, 'h2.jobTitle', '.jobTitle', 'a[data-jk]');
    const c = text(card, '[data-testid="company-name"]', '.companyName', '.company_location [data-testid="company-name"]');
    if (t && c) list.push({ url: `${origin}/viewjob?jk=${encodeURIComponent(id)}`, title: t, company: c, location: text(card, '[data-testid="text-location"]', '.companyLocation') || null });
  }
  return { detail, list };
}

function monster(doc: Document, href: string): { detail: ClippedJob | null; list: ClippedJob[] } {
  const list: ClippedJob[] = [];
  for (const card of Array.from(doc.querySelectorAll<HTMLElement>('[data-testid="svx-job-card"], [data-testid*="JobCard"], article'))) {
    const a = card.querySelector<HTMLAnchorElement>('a[href*="/job-openings/"], a[href*="job-openings"], a[data-testid="jobTitle"]');
    const url = abs(a?.getAttribute('href'), href);
    const t = text(card, '[data-testid="jobTitle"]', 'h2', 'h3') || clean(a?.textContent);
    const c = text(card, '[data-testid="company"]', '[data-testid="companyName"]', '[class*="company" i]');
    if (url && t && c) list.push({ url, title: t, company: c, location: text(card, '[data-testid="jobDetailLocation"]', '[data-testid="location"]', '[class*="location" i]') || null });
  }
  const detail = jsonLdJobs(doc, href)[0] ?? null;
  return { detail, list };
}

function mygreenhouse(doc: Document, href: string): { detail: ClippedJob | null; list: ClippedJob[] } {
  const list: ClippedJob[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="greenhouse.io/"][href*="/jobs/"], a[href*="gh_jid="]'))) {
    const url = abs(a.getAttribute('href'), href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const card = a.closest('li, article, [class*="card" i], [class*="job" i]') ?? a.parentElement ?? a;
    const title = clean(a.textContent) || text(card, 'h2', 'h3', 'h4');
    const company = text(card, '[class*="company" i]', '[class*="organization" i]', 'p', 'span:not(:empty)');
    const slug = url.match(/greenhouse\.io\/([^/]+)\/jobs\//)?.[1];
    if (title) list.push({ url, title, company: company && company !== title ? company : slug ?? 'Unknown company', location: text(card, '[class*="location" i]') || null });
  }
  return { detail: null, list };
}

/**
 * The jobs on this page: the one being viewed (detail) and/or the visible search results (list).
 * "Save all" uses the list; "Save this job" uses the detail.
 */
export function extractJobs(doc: Document, href: string): { site: Site; detail: ClippedJob | null; list: ClippedJob[] } {
  const site = siteOf(href);
  const r =
    site === 'linkedin' ? linkedin(doc, href)
    : site === 'indeed' ? indeed(doc, href)
    : site === 'monster' ? monster(doc, href)
    : site === 'mygreenhouse' ? mygreenhouse(doc, href)
    : { detail: jsonLdJobs(doc, href)[0] ?? null, list: [] as ClippedJob[] };
  // Structured data fills any gaps in the page-specific reading.
  const detail = r.detail ?? (site !== 'mygreenhouse' ? jsonLdJobs(doc, href)[0] ?? null : null);
  const seen = new Set<string>();
  const list = r.list.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true))).slice(0, 50);
  return { site, detail, list };
}
