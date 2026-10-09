import { extractSkills, matchesAnyVariant, normalizeText, similarity } from './text';

export interface MatchProfile {
  skills: string[];
  desiredTitles: string[];
  yearsExperience: number | null;
  experienceLevel: string | null;
  desiredLocations: string[];
  workplaceTypes: string[];
  employmentTypes: string[];
  desiredSalaryMin: number | null;
  requiresSponsorship: boolean | null;
  pastTitles: string[];
}

export interface MatchJob {
  title: string;
  company: string;
  description: string | null;
  location: string | null;
  workplaceType: string | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
}

export interface MatchBreakdown {
  score: number;
  components: Array<{ key: string; label: string; score: number; weight: number; detail: string }>;
  matchedSkills: string[];
  missingSkills: string[];
  concerns: string[];
  highlights: string[];
}

const SENIORITY: Array<{ level: string; re: RegExp; rank: number }> = [
  { level: 'entry', re: /\b(intern|junior|jr\.?|entry[- ]level|graduate|associate)\b/i, rank: 0 },
  { level: 'mid', re: /\b(mid[- ]level|intermediate|ii)\b/i, rank: 1 },
  { level: 'senior', re: /\b(senior|sr\.?|iii)\b/i, rank: 2 },
  { level: 'lead', re: /\b(lead|staff|principal|manager|head)\b/i, rank: 3 },
  { level: 'executive', re: /\b(director|vp|vice president|chief|cto|ceo|cfo)\b/i, rank: 4 },
];
const LEVEL_RANK: Record<string, number> = { entry: 0, mid: 1, senior: 2, lead: 3, executive: 4 };

export function seniorityOf(title: string): string | null {
  // Highest matching rank wins: "Senior Engineering Manager" is lead, not senior.
  let best: { level: string; rank: number } | null = null;
  for (const s of SENIORITY) if (s.re.test(title) && (!best || s.rank > best.rank)) best = s;
  return best?.level ?? null;
}

const NO_SPONSORSHIP = [
  /(unable|not able|cannot|can't|will not|won't|do not|don't|does not)\s+(to\s+)?(provide|offer|support)?\s*(visa\s+)?sponsor/i,
  /no\s+(visa\s+)?sponsorship/i,
  /without (the )?need (for|of) (visa )?sponsorship/i,
  /must be (legally )?authori[sz]ed to work .{0,40}without sponsorship/i,
];
const CLEARANCE = /\b(security clearance|ts\/sci|top secret|active clearance)\b/i;

export function sponsorshipUnavailable(description: string | null | undefined): boolean {
  if (!description) return false;
  return NO_SPONSORSHIP.some((re) => re.test(description));
}

export function computeMatch(profile: MatchProfile, job: MatchJob): MatchBreakdown {
  const text = `${job.title}\n${job.description ?? ''}`;
  const concerns: string[] = [];
  const highlights: string[] = [];
  const components: MatchBreakdown['components'] = [];

  // Skills (40)
  const required = extractSkills(text);
  const profileSkills = profile.skills.map(normalizeText);
  const matchedSkills = required.filter((s) => profileSkills.some((p) => matchesAnyVariant(p, s) || matchesAnyVariant(s, p)));
  const missingSkills = required.filter((s) => !matchedSkills.includes(s));
  let skillScore: number;
  let skillDetail: string;
  if (required.length === 0) {
    skillScore = profileSkills.length ? 0.5 : 0.3;
    skillDetail = 'No recognisable skill requirements in the description';
  } else {
    skillScore = matchedSkills.length / required.length;
    skillDetail = `${matchedSkills.length} of ${required.length} recognised skills match your profile`;
  }
  components.push({ key: 'skills', label: 'Skills', score: skillScore, weight: 40, detail: skillDetail });
  if (matchedSkills.length >= 3) highlights.push(`Strong skill overlap: ${matchedSkills.slice(0, 5).join(', ')}`);

  // Title (25)
  const titles = [...profile.desiredTitles, ...profile.pastTitles];
  const titleSim = titles.length ? Math.max(...titles.map((t) => similarity(t, job.title))) : 0;
  const titleWordHit = titles.some((t) =>
    normalizeText(t)
      .split(' ')
      .filter((w) => w.length > 3)
      .some((w) => normalizeText(job.title).includes(w)),
  );
  const titleScore = Math.min(1, Math.max(titleSim, titleWordHit ? 0.6 : 0));
  components.push({
    key: 'title',
    label: 'Role fit',
    score: titleScore,
    weight: 25,
    detail: titles.length ? `Closest to "${bestTitle(titles, job.title)}"` : 'Add desired titles to improve role matching',
  });

  // Seniority (10)
  const jobLevel = seniorityOf(job.title);
  let seniorityScore = 0.6;
  let seniorityDetail = 'Seniority not stated in title';
  if (jobLevel && profile.experienceLevel) {
    const diff = LEVEL_RANK[jobLevel] - LEVEL_RANK[profile.experienceLevel];
    seniorityScore = diff === 0 ? 1 : Math.abs(diff) === 1 ? 0.6 : 0.15;
    seniorityDetail = `Role is ${jobLevel}, you are ${profile.experienceLevel}`;
    if (diff >= 2) concerns.push(`Role seniority (${jobLevel}) is well above your stated level`);
  }
  const yrs = (job.description ?? '').match(/(\d{1,2})\+?\s*(?:-\s*\d{1,2}\s*)?years?/i);
  if (yrs && profile.yearsExperience != null && Number(yrs[1]) > profile.yearsExperience + 1) {
    concerns.push(`Asks for ${yrs[1]}+ years; your profile lists ${profile.yearsExperience}`);
    seniorityScore = Math.min(seniorityScore, 0.4);
  }
  components.push({ key: 'seniority', label: 'Seniority', score: seniorityScore, weight: 10, detail: seniorityDetail });

  // Location / workplace (15)
  const loc = normalizeText(`${job.location ?? ''} ${job.workplaceType ?? ''}`);
  const isRemote = /remote|anywhere|distributed/.test(loc) || job.workplaceType === 'remote';
  let locScore = 0.5;
  let locDetail = 'No location preference set';
  if (profile.workplaceTypes.length || profile.desiredLocations.length) {
    const wantsRemote = profile.workplaceTypes.includes('remote');
    const locHit = profile.desiredLocations.some((l) => l && loc.includes(normalizeText(l)));
    if (isRemote && wantsRemote) {
      locScore = 1;
      locDetail = 'Remote role matches your preference';
    } else if (locHit) {
      locScore = 1;
      locDetail = 'Location matches your preferences';
    } else if (isRemote) {
      locScore = 0.7;
      locDetail = 'Remote role';
    } else {
      locScore = profile.workplaceTypes.length === 1 && wantsRemote ? 0.1 : 0.3;
      locDetail = `Location "${job.location ?? 'unspecified'}" is outside your preferences`;
      concerns.push(locDetail);
    }
  }
  components.push({ key: 'location', label: 'Location', score: locScore, weight: 15, detail: locDetail });

  // Salary (10)
  let salScore = 0.6;
  let salDetail = 'Salary not disclosed';
  if (profile.desiredSalaryMin && (job.salaryMax || job.salaryMin)) {
    const top = job.salaryMax ?? job.salaryMin!;
    salScore = top >= profile.desiredSalaryMin ? 1 : top >= profile.desiredSalaryMin * 0.9 ? 0.5 : 0.1;
    salDetail = top >= profile.desiredSalaryMin ? 'Salary range meets your minimum' : 'Salary range is below your minimum';
    if (salScore < 0.5) concerns.push(salDetail);
  }
  components.push({ key: 'salary', label: 'Compensation', score: salScore, weight: 10, detail: salDetail });

  if (profile.requiresSponsorship && sponsorshipUnavailable(job.description)) {
    concerns.push('Posting states visa sponsorship is not available');
  }
  if (CLEARANCE.test(job.description ?? '')) concerns.push('Posting mentions a security clearance requirement');
  if (job.employmentType && profile.employmentTypes.length && !profile.employmentTypes.includes(job.employmentType)) {
    concerns.push(`Employment type (${job.employmentType.replace('_', ' ')}) is not one you selected`);
  }

  let score = components.reduce((acc, c) => acc + c.score * c.weight, 0);
  if (concerns.some((c) => c.includes('sponsorship'))) score = Math.min(score, 25);
  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    components,
    matchedSkills,
    missingSkills,
    concerns,
    highlights,
  };
}

function bestTitle(titles: string[], target: string) {
  return titles.reduce((best, t) => (similarity(t, target) > similarity(best, target) ? t : best), titles[0]);
}
