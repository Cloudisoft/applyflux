import type { AutofillProfile } from '@applyflux/shared';
import { formatDateForField, inferDateFormat } from '@applyflux/shared';
import type { DetectedField, MappedKey } from './types';

export interface ValueResult {
  value: string | null;
  verified: boolean;
  reason?: string;
}

const PROFILE_KEY: Partial<Record<MappedKey, keyof AutofillProfile>> = {
  firstName: 'firstName',
  lastName: 'lastName',
  fullName: 'fullName',
  preferredName: 'firstName',
  email: 'email',
  phone: 'phone',
  city: 'city',
  region: 'region',
  country: 'country',
  postalCode: 'postalCode',
  addressLine1: 'addressLine1',
  location: 'location',
  linkedinUrl: 'linkedinUrl',
  githubUrl: 'githubUrl',
  portfolioUrl: 'portfolioUrl',
  websiteUrl: 'portfolioUrl',
  currentCompany: 'currentCompany',
  currentTitle: 'currentTitle',
  school: 'school',
  highestDegree: 'highestDegree',
  noticePeriod: 'noticePeriod',
  availableFrom: 'availableFrom',
  yearsExperience: 'yearsExperience',
};

function dateFor(field: DetectedField, v: string | null): string | null {
  if (!v) return null;
  return formatDateForField(v, inferDateFormat(field.inputType ?? '', field.placeholder ?? ''));
}

/** Value for a mapped profile slot. Never invents: missing data returns null with a reason. */
export function valueFor(key: MappedKey, field: DetectedField, p: AutofillProfile): ValueResult {
  const verified = new Set(p.verifiedKeys);

  if (key.startsWith('experience.')) {
    const e = p.experiences[field.groupIndex ?? 0];
    if (!e) return { value: null, verified: false, reason: 'No work history entry for this section' };
    const prop = key.split('.')[1];
    const v =
      prop === 'company' ? e.company
      : prop === 'title' ? e.title
      : prop === 'location' ? e.location
      : prop === 'startDate' ? dateFor(field, e.startDate)
      : prop === 'endDate' ? (e.isCurrent ? null : dateFor(field, e.endDate))
      : prop === 'current' ? String(e.isCurrent)
      : prop === 'description' ? e.description
      : null;
    if (prop === 'endDate' && e.isCurrent) return { value: null, verified: e.verified, reason: 'Current role has no end date' };
    return { value: v ?? null, verified: e.verified, reason: v ? undefined : `Work history is missing ${prop}` };
  }
  if (key.startsWith('education.')) {
    const e = p.educations[field.groupIndex ?? 0];
    if (!e) return { value: null, verified: false, reason: 'No education entry for this section' };
    const prop = key.split('.')[1];
    const v =
      prop === 'school' ? e.institution
      : prop === 'degree' ? e.degree
      : prop === 'field' ? e.fieldOfStudy
      : prop === 'startDate' ? dateFor(field, e.startDate)
      : prop === 'endDate' ? dateFor(field, e.endDate)
      : null;
    return { value: v ?? null, verified: e.verified, reason: v ? undefined : `Education is missing ${prop}` };
  }
  if (key === 'salary') {
    if (p.desiredSalaryMin == null) return { value: null, verified: false, reason: 'No salary expectation in profile' };
    const numeric = field.kind === 'number' || /^\[?\\?d/.test(field.pattern ?? '');
    const v = numeric
      ? String(p.desiredSalaryMin)
      : p.desiredSalaryMax && p.desiredSalaryMax > p.desiredSalaryMin
        ? `${p.desiredSalaryMin}-${p.desiredSalaryMax}${p.salaryCurrency ? ' ' + p.salaryCurrency : ''}`
        : `${p.desiredSalaryMin}${p.salaryCurrency ? ' ' + p.salaryCurrency : ''}`;
    return { value: v, verified: verified.has('desiredSalaryMin') };
  }
  const pk = PROFILE_KEY[key];
  if (!pk) return { value: null, verified: false, reason: 'Not a profile field' };
  let raw = p[pk] as unknown;
  if (key === 'availableFrom') raw = dateFor(field, (raw as string) ?? null);
  if (key === 'yearsExperience' && typeof raw === 'number') raw = String(Math.floor(raw));
  const value = raw == null || raw === '' ? null : String(raw);
  const vKey = key === 'websiteUrl' ? 'portfolioUrl' : key === 'preferredName' ? 'firstName' : pk;
  return { value, verified: verified.has(vKey as string), reason: value ? undefined : `Your profile has no ${String(pk)}` };
}
