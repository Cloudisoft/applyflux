import type { DetectedField, FieldMapping, MappedKey } from './types';

/**
 * Deterministic field mapping. Signals, strongest first:
 *   1. HTML autocomplete tokens (explicit author intent)
 *   2. Adapter-specific name/id rules (known ATS markup)
 *   3. Label / name / placeholder vocabulary
 * Anything that does not clear the confidence floor is treated as a screening
 * question, never guessed into a profile slot. Position on the page is never
 * used as a signal.
 */

const AUTOCOMPLETE: Record<string, MappedKey> = {
  'given-name': 'firstName',
  'family-name': 'lastName',
  name: 'fullName',
  nickname: 'preferredName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'address-line1': 'addressLine1',
  'street-address': 'addressLine1',
  'address-level2': 'city',
  'address-level1': 'region',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country',
  organization: 'currentCompany',
  'organization-title': 'currentTitle',
  url: 'websiteUrl',
};

/** Labels that look like identity fields but are about someone else. */
const NOT_ME = /\b(referr\w*|recruiter|manager'?s?|supervisor|reference|emergency|hiring|spouse|parent|guardian|who referred)\b/i;

type Rule = { key: MappedKey; re: RegExp; confidence: number; kinds?: string[] };

const RULES: Rule[] = [
  { key: 'resume', re: /\b(resume|résumé|cv|curriculum vitae)\b/i, confidence: 0.95, kinds: ['file'] },
  { key: 'coverLetter', re: /cover\s*letter|motivation letter/i, confidence: 0.95, kinds: ['file'] },
  { key: 'coverLetterText', re: /^cover\s*letter$|cover letter \(text\)|paste.*cover letter/i, confidence: 0.85, kinds: ['textarea'] },

  { key: 'firstName', re: /^(legal )?first[\s_-]?name|^given[\s_-]?name|^forename|^fname$/i, confidence: 0.95 },
  { key: 'lastName', re: /^(legal )?last[\s_-]?name|^family[\s_-]?name|^surname|^lname$/i, confidence: 0.95 },
  { key: 'preferredName', re: /preferred (first )?name|nickname/i, confidence: 0.9 },
  { key: 'fullName', re: /^(your |legal |full )?name$|^full[\s_-]?name|^candidate name/i, confidence: 0.9 },
  { key: 'email', re: /e-?mail/i, confidence: 0.95 },
  { key: 'phone', re: /phone|mobile|telephone|cell/i, confidence: 0.92 },

  { key: 'linkedinUrl', re: /linked\s*in/i, confidence: 0.95 },
  { key: 'githubUrl', re: /git\s*hub/i, confidence: 0.95 },
  { key: 'portfolioUrl', re: /portfolio/i, confidence: 0.9 },
  { key: 'websiteUrl', re: /^(personal )?(web\s*site|homepage|blog)( url)?$|^website$|other website/i, confidence: 0.85 },

  { key: 'addressLine1', re: /address( line)? ?1|street address|^address$/i, confidence: 0.85 },
  { key: 'city', re: /^city$|^town\b|\bcity\b(?! of)/i, confidence: 0.85 },
  { key: 'region', re: /^state|province|region|county/i, confidence: 0.8 },
  { key: 'postalCode', re: /postal|zip/i, confidence: 0.9 },
  { key: 'country', re: /^country|country of residence/i, confidence: 0.85 },
  { key: 'location', re: /^(current )?location( \(city\))?$|where are you (currently )?(located|based)|^location/i, confidence: 0.85 },

  { key: 'currentCompany', re: /current (company|employer)|^company$|^employer$|most recent (company|employer)/i, confidence: 0.85 },
  { key: 'currentTitle', re: /current (job )?title|current (role|position)|^job title$|^title$/i, confidence: 0.8 },
  { key: 'school', re: /^school|university|college|institution/i, confidence: 0.8 },
  { key: 'highestDegree', re: /highest (level of )?(degree|education)|^degree$/i, confidence: 0.8 },

  { key: 'salary', re: /salary|compensation expectation|expected (pay|compensation)|desired pay/i, confidence: 0.8 },
  { key: 'noticePeriod', re: /notice period/i, confidence: 0.85 },
  { key: 'availableFrom', re: /start date|available (from|to start)|earliest start/i, confidence: 0.8 },
  { key: 'yearsExperience', re: /^(total )?years of (professional |relevant )?experience$/i, confidence: 0.8 },
];

const EXPERIENCE_RULES: Rule[] = [
  { key: 'experience.company', re: /company|employer|organi[sz]ation/i, confidence: 0.9 },
  { key: 'experience.title', re: /title|position|role/i, confidence: 0.9 },
  { key: 'experience.location', re: /location|city/i, confidence: 0.8 },
  { key: 'experience.startDate', re: /^from|start/i, confidence: 0.9 },
  { key: 'experience.endDate', re: /^to$|^to |end/i, confidence: 0.9 },
  { key: 'experience.current', re: /current(ly)? (work|role|position)|i (currently )?work here|present/i, confidence: 0.9, kinds: ['checkbox'] },
  { key: 'experience.description', re: /description|responsibilit|summary|role description/i, confidence: 0.85 },
];

const EDUCATION_RULES: Rule[] = [
  { key: 'education.school', re: /school|university|college|institution/i, confidence: 0.9 },
  { key: 'education.degree', re: /degree|qualification/i, confidence: 0.9 },
  { key: 'education.field', re: /field|major|discipline|subject/i, confidence: 0.85 },
  { key: 'education.startDate', re: /^from|start/i, confidence: 0.85 },
  { key: 'education.endDate', re: /^to$|^to |end|graduat/i, confidence: 0.85 },
];

export const CONFIDENCE_FLOOR = 0.75;

export type AdapterRule = { match: (f: DetectedField) => boolean; key: MappedKey };

function kindOk(rule: Rule, field: DetectedField) {
  if (rule.kinds) return rule.kinds.includes(field.kind);
  // Profile slots are typed into text-like inputs or chosen in selects.
  // Radio groups are yes/no style questions, never a profile slot.
  return !['file', 'checkbox', 'checkbox_group', 'radio'].includes(field.kind);
}

export function mapField(field: DetectedField, adapterRules: AdapterRule[] = []): FieldMapping {
  for (const r of adapterRules) if (r.match(field)) return { mappedTo: r.key, confidence: 0.97, via: 'adapter' };

  const label = field.label ?? '';
  const nameish = `${field.name ?? ''} ${field.element.id ?? ''}`.replace(/[\[\]_.-]+/g, ' ').trim();

  if (field.kind === 'file') {
    const text = `${label} ${nameish} ${field.placeholder ?? ''}`;
    if (/cover/i.test(text)) return { mappedTo: 'coverLetter', confidence: 0.95, via: 'label' };
    if (/resume|résumé|\bcv\b|curriculum/i.test(text)) return { mappedTo: 'resume', confidence: 0.95, via: 'label' };
    return { mappedTo: null, confidence: 0, via: 'none' };
  }

  if (field.section === 'experience' || field.section === 'education') {
    const rules = field.section === 'experience' ? EXPERIENCE_RULES : EDUCATION_RULES;
    for (const r of rules) {
      if ((r.kinds ? r.kinds.includes(field.kind) : field.kind !== 'checkbox') && (r.re.test(label) || r.re.test(nameish))) {
        return { mappedTo: r.key, confidence: r.confidence, via: 'label' };
      }
    }
  }

  const ac = field.autocomplete?.toLowerCase().split(/\s+/).find((t) => AUTOCOMPLETE[t]);
  if (ac && !NOT_ME.test(label)) return { mappedTo: AUTOCOMPLETE[ac], confidence: 0.98, via: 'autocomplete' };

  if (NOT_ME.test(label)) return { mappedTo: 'question', confidence: 0.5, via: 'none' };
  // Long labels are questions ("What is your LinkedIn profile and why...?") unless the vocabulary is unambiguous.
  const isLong = label.length > 80 || (label.includes('?') && label.length > 40);

  for (const r of RULES) {
    if (!kindOk(r, field)) continue;
    if (!isLong && r.re.test(label)) return { mappedTo: r.key, confidence: r.confidence, via: 'label' };
  }
  for (const r of RULES) {
    if (!kindOk(r, field)) continue;
    if (nameish && r.re.test(nameish)) return { mappedTo: r.key, confidence: r.confidence - 0.1, via: 'name' };
  }
  if (field.kind === 'email' && !isLong) return { mappedTo: 'email', confidence: 0.85, via: 'name' };
  if (field.kind === 'tel' && !isLong) return { mappedTo: 'phone', confidence: 0.85, via: 'name' };
  return { mappedTo: 'question', confidence: 0.5, via: 'none' };
}
