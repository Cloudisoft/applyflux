import { normalizeText } from './text';

/**
 * Pure filters for automatic job discovery: does a posting fit the titles the person wants,
 * where they want to work, and is it recent? Title filtering follows career-ops' title_filter
 * idea (core keywords must appear), made automatic from the person's own target titles.
 */

const SENIORITY_WORDS = new Set([
  'senior', 'sr', 'junior', 'jr', 'lead', 'staff', 'principal', 'head', 'chief', 'associate', 'assistant', 'intern', 'internship',
  'entry', 'level', 'mid', 'i', 'ii', 'iii', 'iv', 'v', '1', '2', '3', 'trainee', 'graduate', 'apprentice', 'executive', 'vp', 'svp', 'avp',
]);
const STOP_WORDS = new Set(['of', 'and', 'the', 'a', 'an', 'for', 'to', 'in', 'at', 'with', 'on', 'or', 'remote', 'hybrid', 'onsite', 'full', 'time', 'part', 'contract', 'm', 'f', 'd', 'w', 'x']);

/** Common equivalents so "Software Engineer" also finds "Software Developer", "SWE", etc. */
const SYNONYMS: Record<string, string[]> = {
  engineer: ['engineer', 'developer', 'engineering', 'programmer', 'swe', 'sde'],
  developer: ['developer', 'engineer', 'programmer', 'dev'],
  frontend: ['frontend', 'front', 'ui', 'react', 'web'],
  backend: ['backend', 'back', 'server', 'api', 'platform'],
  fullstack: ['fullstack', 'full', 'stack'],
  manager: ['manager', 'management', 'lead', 'head', 'director'],
  designer: ['designer', 'design'],
  analyst: ['analyst', 'analytics', 'analysis'],
  scientist: ['scientist', 'science'],
  ml: ['ml', 'machine', 'learning', 'ai'],
  ai: ['ai', 'ml', 'machine', 'learning', 'artificial', 'intelligence', 'llm'],
  devops: ['devops', 'sre', 'reliability', 'infrastructure', 'platform', 'cloud'],
  sre: ['sre', 'reliability', 'devops', 'infrastructure'],
  sales: ['sales', 'account', 'business', 'development', 'bdr', 'sdr', 'ae'],
  marketing: ['marketing', 'growth', 'brand', 'content', 'demand'],
  recruiter: ['recruiter', 'recruiting', 'talent', 'acquisition', 'sourcer'],
  support: ['support', 'success', 'service', 'customer'],
  product: ['product'],
  qa: ['qa', 'quality', 'test', 'testing', 'sdet', 'automation'],
  nurse: ['nurse', 'rn', 'nursing', 'lpn'],
  accountant: ['accountant', 'accounting', 'finance', 'cpa'],
  writer: ['writer', 'copywriter', 'content', 'editor'],
};

function words(s: string): string[] {
  return normalizeText(s)
    .replace(/front[\s-]?end/g, 'frontend')
    .replace(/back[\s-]?end/g, 'backend')
    .replace(/full[\s-]?stack/g, 'fullstack')
    .replace(/dev[\s-]?ops/g, 'devops')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

const stem = (w: string) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);

/** Core keywords of a target title: seniority and filler words removed. */
export function titleKeywords(title: string): string[] {
  return [...new Set(words(title).filter((w) => !SENIORITY_WORDS.has(w) && !STOP_WORDS.has(w)).map(stem))];
}

/**
 * 0..1: how well a posting title fits one of the person's target titles. Every core keyword of
 * some target must appear in the posting title (directly or as a common synonym) to count.
 */
export function titleFit(jobTitle: string, targets: string[]): number {
  const jw = new Set(words(jobTitle).map(stem));
  let best = 0;
  for (const t of targets) {
    const kws = titleKeywords(t);
    if (!kws.length) continue;
    let hits = 0;
    let exact = 0;
    for (const k of kws) {
      if (jw.has(k)) {
        hits++;
        exact++;
      } else if ((SYNONYMS[k] ?? []).some((s) => jw.has(stem(s)))) hits++;
    }
    if (hits < kws.length) continue;
    best = Math.max(best, 0.6 + 0.4 * (exact / kws.length));
  }
  return best;
}

const REMOTE_RE = /\b(remote|anywhere|worldwide|work from home|wfh|distributed|global)\b/i;
const COUNTRY_ALIASES: Record<string, string[]> = {
  'united states': ['united states', 'usa', 'us', 'u.s.', 'america', 'north america'],
  'united kingdom': ['united kingdom', 'uk', 'u.k.', 'england', 'scotland', 'wales', 'britain', 'london'],
  canada: ['canada', 'north america'],
  germany: ['germany', 'deutschland', 'europe', 'eu', 'emea', 'dach'],
  france: ['france', 'europe', 'eu', 'emea'],
  netherlands: ['netherlands', 'europe', 'eu', 'emea'],
  spain: ['spain', 'europe', 'eu', 'emea'],
  ireland: ['ireland', 'europe', 'eu', 'emea'],
  poland: ['poland', 'europe', 'eu', 'emea'],
  portugal: ['portugal', 'europe', 'eu', 'emea'],
  india: ['india', 'apac', 'asia'],
  australia: ['australia', 'apac', 'anz'],
  singapore: ['singapore', 'apac', 'asia'],
  brazil: ['brazil', 'latam', 'latin america', 'south america'],
  mexico: ['mexico', 'latam', 'latin america', 'north america'],
};
const ALL_PLACE_WORDS = [...new Set(Object.values(COUNTRY_ALIASES).flat())];

function countryKey(country: string | null | undefined): string | null {
  if (!country) return null;
  const c = normalizeText(country).replace(/[^a-z. ]/g, '').trim();
  for (const [k, aliases] of Object.entries(COUNTRY_ALIASES)) if (k === c || aliases.includes(c)) return k;
  return c || null;
}

function mentions(text: string, place: string): boolean {
  const t = ` ${normalizeText(text).replace(/[^a-z0-9.]+/g, ' ')} `;
  return t.includes(` ${place} `);
}

export interface LocationPrefs {
  workplaceTypes: string[];
  desiredLocations: string[];
  city: string | null;
  country: string | null;
}

/** Whether a posting's location suits the person. Unknown locations pass; we only drop clear mismatches. */
export function locationFits(job: { location: string | null; workplaceType: string | null }, prefs: LocationPrefs): boolean {
  const loc = job.location ?? '';
  const remote = job.workplaceType === 'remote' || REMOTE_RE.test(loc);
  const wantsRemote = !prefs.workplaceTypes.length || prefs.workplaceTypes.includes('remote');
  const wantsOffice = !prefs.workplaceTypes.length || prefs.workplaceTypes.some((w) => w === 'hybrid' || w === 'onsite');
  const home = countryKey(prefs.country);

  if (remote) {
    if (!wantsRemote) return false;
    // "Remote (US only)", "Remote - Europe": respect explicit regions when we know the person's country.
    if (!home || /\b(anywhere|worldwide|global)\b/i.test(loc)) return true;
    const named = ALL_PLACE_WORDS.filter((p) => mentions(loc, p));
    if (!named.length) return true;
    return (COUNTRY_ALIASES[home] ?? [home]).some((a) => named.includes(a));
  }
  if (!wantsOffice) return false;
  if (!loc.trim()) return true;
  const places = [...prefs.desiredLocations, prefs.city ?? ''].map((p) => normalizeText(p).split(',')[0].trim()).filter(Boolean);
  if (places.some((p) => normalizeText(loc).includes(p))) return true;
  if (prefs.desiredLocations.length || prefs.city) {
    // Same country is acceptable when the person is willing to work anywhere in it.
    return !!home && (COUNTRY_ALIASES[home] ?? [home]).some((a) => a.length > 2 && mentions(loc, a));
  }
  return !home || (COUNTRY_ALIASES[home] ?? [home]).some((a) => mentions(loc, a));
}

/** Posted within the last `days` days. Postings without a date are kept (boards list only open roles). */
export function isRecent(postedAt: string | null | undefined, days: number, now = Date.now()): boolean {
  if (!postedAt) return true;
  const t = Date.parse(postedAt);
  if (Number.isNaN(t)) return true;
  return now - t <= days * 86_400_000 && t <= now + 86_400_000;
}

/** Titles to search for: the person's targets, else their current title. */
export function discoveryTitles(p: { desiredTitles: string[]; currentTitle?: string | null; headline?: string | null }): string[] {
  const t = p.desiredTitles.filter(Boolean);
  if (t.length) return t.slice(0, 8);
  if (p.currentTitle) return [p.currentTitle];
  return [];
}
