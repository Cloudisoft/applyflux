import type { AutofillProfile } from './schemas';
import type { QuestionCategory } from './schemas';
import { normalizeText, similarity } from './text';

/** Normalised key used to reuse an approved answer for the same question across forms. */
export function questionKey(question: string): string {
  return normalizeText(question)
    .replace(/\*/g, '')
    .replace(/\(required\)|\(optional\)/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

const RULES: Array<{ category: QuestionCategory; re: RegExp }> = [
  { category: 'sponsorship', re: /sponsor|h-?1b|visa status|immigration (support|status)/i },
  { category: 'work_authorization', re: /(legally )?(authori[sz]ed|eligible|permitted|right) to work|work (permit|authori[sz]ation)|employment eligibility|citizen|permanent resident|nationality|green card|security clearance/i },
  { category: 'criminal_history', re: /convicted|criminal|felony|background check/i },
  { category: 'veteran', re: /veteran|military service|armed forces/i },
  { category: 'disability', re: /disabilit/i },
  { category: 'demographic', re: /gender|race|ethnic|hispanic|latino|sexual orientation|pronoun|transgender|age range|date of birth|religio/i },
  { category: 'salary', re: /salary|compensation|pay (expectation|range)|desired pay|expected (pay|ctc)|\bctc\b/i },
  { category: 'availability', re: /start date|notice period|when can you start|availab(le|ility)|earliest/i },
  { category: 'relocation', re: /relocat|commut|on-?site|in[- ]office|hybrid/i },
  { category: 'experience_years', re: /how many years|years of (professional )?experience|years experience/i },
  { category: 'education', re: /degree|university|school|education|gpa/i },
  { category: 'referral', re: /how did you (hear|find)|referr|source/i },
  { category: 'links', re: /linkedin|github|portfolio|website|url/i },
  { category: 'contact', re: /phone|e-?mail|address|city|postal|zip/i },
  { category: 'legal_consent', re: /consent|privacy (policy|notice)|acknowledg|certify|agree|terms/i },
  { category: 'motivation', re: /why (do you|are you|this|us)|interest(ed)? in|tell us about|cover letter|what (excites|attracts)|additional information/i },
];

export function classifyQuestion(question: string): QuestionCategory {
  for (const r of RULES) if (r.re.test(question)) return r.category;
  return 'other';
}

/** Categories where ApplyFlux must never generate an answer; only a user-approved answer may be used. */
export const SENSITIVE_CATEGORIES: readonly QuestionCategory[] = [
  'work_authorization',
  'sponsorship',
  'demographic',
  'disability',
  'veteran',
  'criminal_history',
  'legal_consent',
];

export function isSensitive(category: QuestionCategory): boolean {
  return SENSITIVE_CATEGORIES.includes(category);
}

const YES = ['yes', 'y', 'true', 'i am', 'i do', 'i will', 'authorized', 'authorised'];
const NO = ['no', 'n', 'false', 'i am not', 'i do not', 'i will not', 'not authorized'];

/** Choose the option that best represents a boolean. Returns null if no option clearly does. */
export function pickBooleanOption(options: string[], value: boolean): string | null {
  const wanted = value ? YES : NO;
  const other = value ? NO : YES;
  for (const o of options) {
    const n = normalizeText(o).replace(/[^a-z ]/g, '').trim();
    if (wanted.includes(n)) return o;
  }
  for (const o of options) {
    const n = normalizeText(o).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    const startsWanted = wanted.some((w) => n.startsWith(w + ' ') || n === w);
    const startsOther = other.some((w) => n.startsWith(w + ' ') || n === w);
    if (startsWanted && !startsOther) return o;
  }
  return null;
}

/** Best fuzzy match of `value` among `options`; null when nothing is a confident match. */
export function matchOption(options: string[], value: string, threshold = 0.82): { option: string; confidence: number } | null {
  const v = normalizeText(value);
  if (!v) return null;
  let best: { option: string; confidence: number } | null = null;
  for (const o of options) {
    const n = normalizeText(o);
    if (!n || /^(select|choose|please select|--)/.test(n)) continue;
    let c = similarity(n, v);
    if (n === v) c = 1;
    else if (n.replace(/[^a-z0-9]/g, '') === v.replace(/[^a-z0-9]/g, '')) c = 0.98;
    else if (v.length >= 4 && (n.startsWith(v) || v.startsWith(n))) c = Math.max(c, 0.88);
    if (!best || c > best.confidence) best = { option: o, confidence: c };
  }
  return best && best.confidence >= threshold ? best : null;
}

export interface ProfileAnswer {
  answer: string | null;
  confidence: number;
  needsUser: boolean;
  reason?: string;
}

function mentionedCountry(question: string, profile: AutofillProfile): string | null {
  const q = ` ${normalizeText(question).replace(/[^a-z0-9.]+/g, ' ')} `;
  const aliases: Record<string, string[]> = {
    'united states': ['united states', 'u.s.', 'u.s', 'us', 'usa', 'america'],
    'united kingdom': ['united kingdom', 'uk', 'u.k.', 'britain', 'england'],
    canada: ['canada'],
    'european union': ['european union', 'eu'],
  };
  for (const [country, list] of Object.entries(aliases)) {
    if (list.some((a) => q.includes(` ${a} `))) return country;
  }
  for (const wa of profile.workAuthorizations) {
    if (wa.country && q.includes(normalizeText(wa.country))) return normalizeText(wa.country);
  }
  return null;
}

function authFor(profile: AutofillProfile, country: string | null) {
  if (!country) return profile.workAuthorizations.length === 1 ? profile.workAuthorizations[0] : null;
  return profile.workAuthorizations.find((w) => {
    const c = normalizeText(w.country);
    return c === country || (country === 'united states' && ['us', 'usa', 'u.s.', 'united states of america'].includes(c)) || (country === 'united kingdom' && ['uk', 'great britain'].includes(c));
  }) ?? null;
}

/**
 * Deterministic answers that come straight from verified profile facts.
 * Work authorization and sponsorship are answered ONLY from verified profile
 * data — never generated — and only when the question names a country the user
 * has recorded (or the user has exactly one).
 */
export function answerFromProfile(
  question: string,
  options: string[] | undefined,
  profile: AutofillProfile,
): ProfileAnswer {
  const category = classifyQuestion(question);
  const verified = new Set(profile.verifiedKeys);
  const none = (reason: string): ProfileAnswer => ({ answer: null, confidence: 0, needsUser: true, reason });

  const screening = screeningAnswer(question, options, profile);
  if (screening) return screening;

  if (/country of residence|current country|where do you (currently )?(live|reside)|country (are you )?(currently )?(based|located) in/i.test(question)) {
    if (!profile.country || !verified.has('country')) return none('Country not verified in your profile');
    if (!options?.length) return { answer: profile.country, confidence: 0.9, needsUser: false };
    const m = matchOption(options, profile.country);
    return m ? { answer: m.option, confidence: m.confidence, needsUser: false } : none('No option matches your country');
  }

  if (category === 'work_authorization' || category === 'sponsorship') {
    if (!verified.has('workAuthorizations')) return none('Work authorization is not verified in your profile');
    const wa = authFor(profile, mentionedCountry(question, profile));
    if (!wa) return none('No recorded work authorization for the country in this question');
    const value = category === 'sponsorship' ? wa.requiresSponsorship : wa.authorized;
    if (value == null) return none('Your profile does not state this');
    if (options?.length) {
      const opt = pickBooleanOption(options, value);
      return opt ? { answer: opt, confidence: 0.95, needsUser: false } : none('Options do not map cleanly to yes/no');
    }
    return { answer: value ? 'Yes' : 'No', confidence: 0.95, needsUser: false };
  }

  if (category === 'relocation' && /relocat/i.test(question)) {
    if (profile.willingToRelocate == null || !verified.has('willingToRelocate')) return none('Relocation preference not verified');
    const opt = options?.length ? pickBooleanOption(options, profile.willingToRelocate) : profile.willingToRelocate ? 'Yes' : 'No';
    return opt ? { answer: opt, confidence: 0.9, needsUser: false } : none('Options do not map cleanly to yes/no');
  }

  if (category === 'salary') {
    if (profile.desiredSalaryMin == null || !verified.has('desiredSalaryMin')) return none('Salary expectation not verified');
    const cur = profile.salaryCurrency ?? '';
    const text =
      profile.desiredSalaryMax && profile.desiredSalaryMax > profile.desiredSalaryMin
        ? `${profile.desiredSalaryMin}-${profile.desiredSalaryMax}${cur ? ' ' + cur : ''}`
        : `${profile.desiredSalaryMin}${cur ? ' ' + cur : ''}`;
    if (options?.length) {
      const opt = options.find((o) => salaryRangeContains(o, profile.desiredSalaryMin!));
      return opt ? { answer: opt, confidence: 0.85, needsUser: false } : none('No salary option contains your expectation');
    }
    return { answer: /number|numeric/i.test(question) ? String(profile.desiredSalaryMin) : text, confidence: 0.85, needsUser: false };
  }

  if (category === 'availability') {
    const v = /notice/i.test(question) ? profile.noticePeriod : profile.availableFrom ?? profile.noticePeriod;
    const key = /notice/i.test(question) ? 'noticePeriod' : profile.availableFrom ? 'availableFrom' : 'noticePeriod';
    if (!v || !verified.has(key)) return none('Availability not verified');
    if (options?.length) {
      const m = matchOption(options, v);
      return m ? { answer: m.option, confidence: m.confidence, needsUser: false } : none('No option matches your availability');
    }
    return { answer: v, confidence: 0.85, needsUser: false };
  }

  if (category === 'experience_years' && !/\bwith\b|\bin\b/i.test(question.replace(/years of (professional )?experience/i, ''))) {
    if (profile.yearsExperience == null || !verified.has('yearsExperience')) return none('Years of experience not verified');
    const yrs = String(Math.floor(profile.yearsExperience));
    if (options?.length) {
      const opt = options.find((o) => rangeContains(o, profile.yearsExperience!));
      return opt ? { answer: opt, confidence: 0.85, needsUser: false } : none('No option matches your experience');
    }
    return { answer: yrs, confidence: 0.85, needsUser: false };
  }

  return { answer: null, confidence: 0, needsUser: true, reason: 'Not answerable from profile facts alone' };
}

/** "$80,000 - $100,000", "80k-100k", "100k+", "Under $50k": does the option contain the amount? */
function salaryRangeContains(option: string, n: number): boolean {
  const vals = [...option.toLowerCase().replace(/,/g, '').matchAll(/(\d+(?:\.\d+)?)\s*(k|m)?/g)].map((m) => Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1_000_000 : 1));
  if (!vals.length) return false;
  const o = option.toLowerCase();
  if (vals.length >= 2) return n >= vals[0] && n <= vals[1];
  if (/\+|or more|above|over|more than/.test(o)) return n >= vals[0];
  if (/under|less than|below|up to/.test(o)) return n < vals[0];
  return false;
}

const DECLINE_OPTION = /decline|prefer not|don.?t wish|do not wish|choose not|rather not|not (to )?(answer|disclose|say|specify|self.?identify)|i don.?t want/i;

/** Pick the option meaning yes/no, or the given text, from a question's options (or answer free text). */
function choose(options: string[] | undefined, value: boolean | string): string | null {
  if (typeof value === 'boolean') return options?.length ? pickBooleanOption(options, value) : value ? 'Yes' : 'No';
  if (!options?.length) return value;
  return matchOption(options, value, 0.75)?.option ?? options.find((o) => normalizeText(o).includes(normalizeText(value))) ?? null;
}

/**
 * Answers the person gave once in their profile ("Application questions"), used on every form.
 * They are the person's own statements, so they may answer sensitive questions (EEO, consent).
 */
function screeningAnswer(question: string, options: string[] | undefined, profile: AutofillProfile): ProfileAnswer | null {
  const s = profile.screening;
  if (!s) return null;
  const q = question.toLowerCase();
  const ok = (answer: string | null, reason: string): ProfileAnswer =>
    answer ? { answer, confidence: 0.95, needsUser: false } : { answer: null, confidence: 0, needsUser: true, reason };
  const bool = (v: boolean | null, what: string): ProfileAnswer | null => (v == null ? null : ok(choose(options, v), `Options do not map cleanly to yes/no for ${what}`));

  if (/(at least|over|older than) (the age of )?18|18 years( of age)?( or older)?|legal (working )?age|of legal age/.test(q)) return bool(s.over18, 'age');
  if (/background (check|screening)|consumer report/.test(q) && /willing|consent|agree|submit|undergo|authori[sz]e|able to pass/.test(q)) return bool(s.backgroundCheck, 'background check');
  if (/drug (test|screen)/.test(q)) return bool(s.drugTest, 'drug test');
  if (/convicted|felony|criminal (record|conviction|offen[cs]e)/.test(q)) return bool(s.felonyConviction, 'criminal history');
  if (/driver'?s? licen[cs]e|driving licen[cs]e/.test(q)) return bool(s.driversLicense, "driver's licence");
  if (/commut|on-?site|in[- ]office|in the office|hybrid|come (in)?to (the|our) office/.test(q) && !/relocat/.test(q)) return bool(s.willingOnsite, 'on-site work');

  if (/how did you (hear|find|learn)|where did you (hear|find|see)|referr(al|ed) source|source of (application|referral)|how were you referred/.test(q)) {
    const src = s.referralSource ?? 'Online job board';
    if (!options?.length) return ok(src, '');
    const pick =
      choose(options, src) ??
      options.find((o) => /job board|online|internet|website|careers? (site|page)|linkedin|indeed|other/i.test(o)) ??
      null;
    return ok(pick, 'No option fits your referral source');
  }

  // Privacy notices and "I certify this application is accurate" acknowledgements.
  if (classifyQuestion(question) === 'legal_consent' && /acknowledg|agree|consent|certify|confirm|read and understand|accept|privacy/.test(q)) {
    if (!s.acceptConsents) return null;
    if (!options?.length) return ok('Yes', '');
    return ok(options.find((o) => /^(yes|i (agree|acknowledge|accept|consent|confirm|certify|understand))|agree|acknowledge|accept/i.test(o)) ?? pickBooleanOption(options, true), 'No option clearly means "I agree"');
  }

  // Voluntary self-identification (EEO): decline unless the person chose to answer.
  const eeo =
    /\bgender\b|\bsex\b/.test(q) ? s.gender
    : /hispanic|latin[oa]/.test(q) ? (s.hispanicLatino == null ? null : s.hispanicLatino)
    : /\brace\b|ethnic/.test(q) ? s.raceEthnicity
    : /veteran|military|armed forces/.test(q) ? s.veteranStatus
    : /disabilit/.test(q) ? s.disabilityStatus
    : /sexual orientation/.test(q) ? s.sexualOrientation
    : /pronoun/.test(q) ? s.pronouns
    : undefined;
  if (eeo !== undefined && !/date of birth|age range|how old/.test(q)) {
    if (s.eeo === 'answer' && eeo != null && eeo !== '') {
      const picked = choose(options, eeo);
      if (picked) return ok(picked, '');
    }
    const decline = options?.find((o) => DECLINE_OPTION.test(o));
    if (decline) return ok(decline, '');
    if (!options?.length) return ok('Prefer not to say', '');
    return { answer: null, confidence: 0, needsUser: true, reason: 'This form has no "prefer not to say" option; please choose an answer' };
  }
  return null;
}

function rangeContains(option: string, n: number): boolean {
  const o = option.toLowerCase();
  const plus = o.match(/(\d+)\s*\+/);
  if (plus) return n >= Number(plus[1]);
  const range = o.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
  if (range) return n >= Number(range[1]) && n <= Number(range[2]);
  const less = o.match(/(?:less than|under|<)\s*(\d+)/);
  if (less) return n < Number(less[1]);
  const more = o.match(/(?:more than|over|>)\s*(\d+)/);
  if (more) return n > Number(more[1]);
  const exact = o.match(/^\s*(\d+)\s*(years?)?\s*$/);
  if (exact) return Math.floor(n) === Number(exact[1]);
  return false;
}
