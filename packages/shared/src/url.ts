/**
 * Posting URL canonicalisation and ATS vendor detection.
 *
 * Adapted from career-ops url-key.mjs and ats-vendor.mjs (MIT License,
 * Copyright (c) 2026 Santiago Fernández de Valderrama). The key strips only a
 * narrow denylist of tracking parameters on purpose: over-normalising merges
 * two distinct postings silently, under-normalising leaves a visible duplicate.
 */

const TRACKING_PARAMS = [
  /^utm_/i,
  /^gh_src$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^igshid$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^trk$/i,
  /^trackingid$/i,
  /^lever-source/i,
];

/** Returns '' for anything that is not a usable http(s) URL. Never a stand-in key. */
export function urlKey(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return '';
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.some((re) => re.test(k)))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  let path = u.pathname.replace(/\/+$/, '') || '/';
  // Greenhouse/Lever "/apply" suffix points at the same posting.
  path = path.replace(/\/apply$/i, '') || '/';
  return `https://${host}${path}${query}`;
}

const hostIs = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

export const ATS_HOST_PATTERNS: Array<{ id: string; test: (host: string) => boolean }> = [
  { id: 'greenhouse', test: (h) => hostIs(h, 'greenhouse.io') },
  { id: 'lever', test: (h) => hostIs(h, 'lever.co') },
  { id: 'ashby', test: (h) => hostIs(h, 'ashbyhq.com') },
  { id: 'workday', test: (h) => hostIs(h, 'myworkdayjobs.com') || hostIs(h, 'myworkdaysite.com') },
  { id: 'icims', test: (h) => hostIs(h, 'icims.com') },
  { id: 'linkedin', test: (h) => hostIs(h, 'linkedin.com') },
  { id: 'smartrecruiters', test: (h) => hostIs(h, 'smartrecruiters.com') },
  { id: 'successfactors', test: (h) => hostIs(h, 'successfactors.com') || hostIs(h, 'successfactors.eu') },
  { id: 'taleo', test: (h) => hostIs(h, 'taleo.net') },
  { id: 'bamboohr', test: (h) => hostIs(h, 'bamboohr.com') },
  { id: 'workable', test: (h) => hostIs(h, 'workable.com') },
];

/** Provider id for a known ATS, otherwise null. */
export function atsVendorOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase();
    return ATS_HOST_PATTERNS.find(({ test }) => test(host))?.id ?? null;
  } catch {
    return null;
  }
}

/** Stable fingerprint for cross-source duplicate detection (same role, different URL). */
export function jobFingerprint(company: string, title: string, location?: string | null): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\b(inc|llc|ltd|gmbh|corp|co|the)\b\.?/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return [norm(company), norm(title), norm(location ?? '')].join('|');
}
