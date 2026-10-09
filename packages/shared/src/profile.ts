import type { AutofillProfile, FullCandidateProfile } from './schemas';

export interface ProfileIssue {
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ProfileAssessment {
  completeness: number;
  missing: Array<{ field: string; label: string; requiredForAutomation: boolean }>;
  issues: ProfileIssue[];
  unverified: string[];
  readyForAutomation: boolean;
}

const CHECKS: Array<{ field: string; label: string; weight: number; automation: boolean; has: (p: FullCandidateProfile) => boolean }> = [
  { field: 'firstName', label: 'First name', weight: 8, automation: true, has: (p) => !!p.profile.firstName },
  { field: 'lastName', label: 'Last name', weight: 8, automation: true, has: (p) => !!p.profile.lastName },
  { field: 'email', label: 'Email', weight: 8, automation: true, has: (p) => !!p.profile.email },
  { field: 'phone', label: 'Phone', weight: 6, automation: true, has: (p) => !!p.profile.phone },
  { field: 'location', label: 'City and country', weight: 6, automation: true, has: (p) => !!p.profile.city && !!p.profile.country },
  { field: 'workAuthorizations', label: 'Work authorization', weight: 8, automation: true, has: (p) => p.profile.workAuthorizations.length > 0 },
  { field: 'experiences', label: 'Work history', weight: 12, automation: false, has: (p) => p.experiences.length > 0 },
  { field: 'educations', label: 'Education', weight: 6, automation: false, has: (p) => p.educations.length > 0 },
  { field: 'skills', label: 'Skills', weight: 10, automation: false, has: (p) => p.profile.skills.length >= 3 },
  { field: 'summary', label: 'Professional summary', weight: 4, automation: false, has: (p) => !!p.profile.summary },
  { field: 'linkedinUrl', label: 'LinkedIn URL', weight: 3, automation: false, has: (p) => !!p.profile.linkedinUrl },
  { field: 'desiredTitles', label: 'Desired job titles', weight: 8, automation: true, has: (p) => p.profile.desiredTitles.length > 0 },
  { field: 'workplaceTypes', label: 'Remote / hybrid / onsite preference', weight: 4, automation: false, has: (p) => p.profile.workplaceTypes.length > 0 },
  { field: 'yearsExperience', label: 'Years of experience', weight: 4, automation: false, has: (p) => p.profile.yearsExperience != null },
  { field: 'availability', label: 'Availability / notice period', weight: 3, automation: false, has: (p) => !!p.profile.noticePeriod || !!p.profile.availableFrom },
  { field: 'salary', label: 'Salary expectation', weight: 2, automation: false, has: (p) => p.profile.desiredSalaryMin != null },
];

/** Fields that must be user-verified before Auto Mode may type them into a form. */
export const AUTOMATION_VERIFIED_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'workAuthorizations'];

export function dateValue(d: string | null | undefined): number | null {
  if (!d) return null;
  const [y, m = '01', day = '01'] = d.split('-');
  const t = Date.UTC(Number(y), Number(m) - 1, Number(day));
  return Number.isNaN(t) ? null : t;
}

export function assessProfile(p: FullCandidateProfile, now = new Date()): ProfileAssessment {
  const total = CHECKS.reduce((a, c) => a + c.weight, 0);
  const got = CHECKS.filter((c) => c.has(p)).reduce((a, c) => a + c.weight, 0);
  const missing = CHECKS.filter((c) => !c.has(p)).map((c) => ({ field: c.field, label: c.label, requiredForAutomation: c.automation }));
  const issues: ProfileIssue[] = [];
  const nowT = now.getTime();

  p.experiences.forEach((e, i) => {
    const s = dateValue(e.startDate);
    const en = dateValue(e.endDate);
    const f = `experiences.${i}`;
    if (!e.startDate) issues.push({ field: f, severity: 'warning', message: `${e.title} at ${e.company}: start date missing` });
    if (s && en && en < s) issues.push({ field: f, severity: 'error', message: `${e.title} at ${e.company}: end date is before start date` });
    if (s && s > nowT) issues.push({ field: f, severity: 'error', message: `${e.title} at ${e.company}: start date is in the future` });
    if (e.isCurrent && e.endDate) issues.push({ field: f, severity: 'error', message: `${e.title} at ${e.company}: marked current but has an end date` });
    if (!e.isCurrent && !e.endDate && e.startDate) issues.push({ field: f, severity: 'warning', message: `${e.title} at ${e.company}: end date missing (or mark as current)` });
  });
  const current = p.experiences.filter((e) => e.isCurrent);
  if (current.length > 2) issues.push({ field: 'experiences', severity: 'warning', message: `${current.length} roles are marked as current` });

  p.educations.forEach((e, i) => {
    const s = dateValue(e.startDate);
    const en = dateValue(e.endDate);
    if (s && en && en < s) issues.push({ field: `educations.${i}`, severity: 'error', message: `${e.institution}: end date is before start date` });
  });
  p.certifications.forEach((c, i) => {
    const s = dateValue(c.issuedOn);
    const x = dateValue(c.expiresOn);
    if (s && x && x < s) issues.push({ field: `certifications.${i}`, severity: 'error', message: `${c.name}: expiry is before issue date` });
    if (x && x < nowT) issues.push({ field: `certifications.${i}`, severity: 'warning', message: `${c.name}: certification has expired` });
  });

  const pr = p.profile;
  if (pr.desiredSalaryMin != null && pr.desiredSalaryMax != null && pr.desiredSalaryMax < pr.desiredSalaryMin)
    issues.push({ field: 'salary', severity: 'error', message: 'Maximum salary is below minimum salary' });
  if ((pr.desiredSalaryMin != null || pr.desiredSalaryMax != null) && !pr.salaryCurrency)
    issues.push({ field: 'salaryCurrency', severity: 'warning', message: 'Salary currency not set' });

  // Stated years vs. work history span.
  const starts = p.experiences.map((e) => dateValue(e.startDate)).filter((x): x is number => x != null);
  if (pr.yearsExperience != null && starts.length) {
    const spanYears = (nowT - Math.min(...starts)) / (365.25 * 24 * 3600 * 1000);
    if (pr.yearsExperience > spanYears + 2)
      issues.push({ field: 'yearsExperience', severity: 'warning', message: `Years of experience (${pr.yearsExperience}) exceeds your work history span (~${Math.floor(spanYears)} years)` });
  }
  for (const wa of pr.workAuthorizations) {
    if (wa.authorized === false && wa.requiresSponsorship === false)
      issues.push({ field: 'workAuthorizations', severity: 'warning', message: `${wa.country}: not authorized but sponsorship marked as not required — please confirm` });
  }

  const unverified: string[] = [];
  for (const f of AUTOMATION_VERIFIED_FIELDS) if (!pr.fieldMeta[f]?.verified) unverified.push(f);
  p.experiences.forEach((e, i) => !e.verified && unverified.push(`experiences.${i}`));
  p.educations.forEach((e, i) => !e.verified && unverified.push(`educations.${i}`));

  const automationMissing = missing.filter((m) => m.requiredForAutomation);
  const readyForAutomation =
    automationMissing.length === 0 &&
    !issues.some((i) => i.severity === 'error') &&
    AUTOMATION_VERIFIED_FIELDS.every((f) => pr.fieldMeta[f]?.verified);

  return { completeness: Math.round((got / total) * 100), missing, issues, unverified, readyForAutomation };
}

/** Builds the data an executor may type into forms. Unverified facts are excluded from verifiedKeys. */
export function buildAutofillProfile(p: FullCandidateProfile): AutofillProfile {
  const pr = p.profile;
  const meta = pr.fieldMeta;
  const isV = (k: string) => !!meta[k]?.verified;
  const sorted = [...p.experiences].sort((a, b) => (dateValue(b.startDate) ?? 0) - (dateValue(a.startDate) ?? 0));
  const current = sorted.find((e) => e.isCurrent) ?? sorted[0];
  const edu = [...p.educations].sort((a, b) => (dateValue(b.endDate) ?? 0) - (dateValue(a.endDate) ?? 0))[0];
  const verifiedKeys = [
    'firstName', 'lastName', 'email', 'phone', 'city', 'region', 'country', 'postalCode', 'addressLine1',
    'linkedinUrl', 'githubUrl', 'portfolioUrl', 'yearsExperience', 'workAuthorizations', 'noticePeriod',
    'availableFrom', 'desiredSalaryMin', 'willingToRelocate',
  ].filter(isV);
  if (isV('firstName') && isV('lastName')) verifiedKeys.push('fullName');
  if (isV('city')) verifiedKeys.push('location');
  if (current?.verified) verifiedKeys.push('currentCompany', 'currentTitle');
  if (edu?.verified) verifiedKeys.push('school', 'highestDegree');

  return {
    firstName: pr.firstName,
    lastName: pr.lastName,
    fullName: [pr.firstName, pr.lastName].filter(Boolean).join(' ') || null,
    email: pr.email,
    phone: pr.phone,
    city: pr.city,
    region: pr.region,
    country: pr.country,
    postalCode: pr.postalCode,
    addressLine1: pr.addressLine1,
    location: [pr.city, pr.region, pr.country].filter(Boolean).join(', ') || null,
    linkedinUrl: pr.linkedinUrl,
    githubUrl: pr.githubUrl,
    portfolioUrl: pr.portfolioUrl,
    currentCompany: current?.company ?? null,
    currentTitle: current?.title ?? null,
    yearsExperience: pr.yearsExperience,
    highestDegree: edu?.degree ?? null,
    school: edu?.institution ?? null,
    workAuthorizations: pr.workAuthorizations,
    noticePeriod: pr.noticePeriod,
    availableFrom: pr.availableFrom,
    desiredSalaryMin: pr.desiredSalaryMin,
    desiredSalaryMax: pr.desiredSalaryMax,
    salaryCurrency: pr.salaryCurrency,
    willingToRelocate: pr.willingToRelocate,
    experiences: sorted.map((e) => ({
      company: e.company, title: e.title, location: e.location, startDate: e.startDate, endDate: e.endDate,
      isCurrent: e.isCurrent, description: e.description, verified: e.verified,
    })),
    educations: [...p.educations]
      .sort((a, b) => (dateValue(b.endDate) ?? 0) - (dateValue(a.endDate) ?? 0))
      .map((e) => ({ institution: e.institution, degree: e.degree, fieldOfStudy: e.fieldOfStudy, startDate: e.startDate, endDate: e.endDate, verified: e.verified })),
    verifiedKeys,
  };
}
