import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STATES,
  TRANSITIONS,
  canTransition,
  urlKey,
  atsVendorOf,
  computeMatch,
  classifyQuestion,
  answerFromProfile,
  questionKey,
  matchOption,
  pickBooleanOption,
  assessProfile,
  buildAutofillProfile,
  normalizePhone,
  parseLooseDate,
  formatDateForField,
  classifyLiveness,
  containsTerm,
  extractSkills,
  sponsorshipUnavailable,
  CandidateProfileInput,
  type FullCandidateProfile,
  type AutofillProfile,
  ScreeningAnswers,
  titleFit,
  titleKeywords,
  locationFits,
  isRecent,
} from '../src';

describe('state machine', () => {
  it('every transition target is a valid state', () => {
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      expect(APPLICATION_STATES).toContain(from);
      for (const t of tos) expect(APPLICATION_STATES).toContain(t);
    }
  });
  it('never allows leaving terminal outcomes', () => {
    expect(TRANSITIONS.REJECTED).toHaveLength(0);
    expect(TRANSITIONS.WITHDRAWN).toHaveLength(0);
  });
  it('cannot jump from queued straight to submitted', () => {
    expect(canTransition('QUEUED', 'SUBMITTED')).toBe(false);
    expect(canTransition('IN_PROGRESS', 'SUBMITTED')).toBe(true);
  });
  it('submitted can never return to in-progress (no duplicate submissions)', () => {
    expect(canTransition('SUBMITTED', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('SUBMITTED', 'QUEUED')).toBe(false);
    expect(canTransition('SUBMISSION_UNVERIFIED', 'QUEUED')).toBe(false);
  });
});

describe('urlKey / atsVendorOf', () => {
  it('strips tracking params but keeps functional ones', () => {
    expect(urlKey('https://Boards.Greenhouse.io/acme/jobs/123/?utm_source=x&gh_jid=9&gh_src=abc')).toBe(
      'https://boards.greenhouse.io/acme/jobs/123?gh_jid=9',
    );
  });
  it('treats /apply as the same posting', () => {
    expect(urlKey('https://jobs.lever.co/acme/uuid/apply')).toBe(urlKey('https://jobs.lever.co/acme/uuid'));
  });
  it('returns empty for non-urls', () => {
    expect(urlKey('N/A')).toBe('');
    expect(urlKey('javascript:alert(1)')).toBe('');
  });
  it('detects vendors', () => {
    expect(atsVendorOf('https://job-boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
    expect(atsVendorOf('https://acme.wd5.myworkdayjobs.com/en-US/x')).toBe('workday');
    expect(atsVendorOf('https://www.linkedin.com/jobs/view/1')).toBe('linkedin');
    expect(atsVendorOf('https://notgreenhouse.io.evil.com/')).toBe(null);
  });
});

describe('keyword matching', () => {
  it('respects word boundaries', () => {
    expect(containsTerm('We use JavaScript daily', 'java')).toBe(false);
    expect(containsTerm('Strong C++ and CI/CD', 'c++')).toBe(true);
    expect(extractSkills('Experience with k8s and Postgres')).toEqual(expect.arrayContaining(['kubernetes', 'postgresql']));
  });
});

describe('computeMatch', () => {
  const profile = {
    skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL'],
    desiredTitles: ['Senior Frontend Engineer'],
    yearsExperience: 6,
    experienceLevel: 'senior',
    desiredLocations: ['Berlin'],
    workplaceTypes: ['remote'],
    employmentTypes: ['full_time'],
    desiredSalaryMin: 80000,
    requiresSponsorship: false,
    pastTitles: ['Frontend Engineer'],
  };
  it('scores a strong fit highly and explains it', () => {
    const m = computeMatch(profile, {
      title: 'Senior Frontend Engineer',
      company: 'Acme',
      description: 'We need React, TypeScript and Node.js experience. Fully remote.',
      location: 'Remote',
      workplaceType: 'remote',
      employmentType: 'full_time',
      salaryMin: 90000,
      salaryMax: 110000,
    });
    expect(m.score).toBeGreaterThanOrEqual(80);
    expect(m.matchedSkills).toEqual(expect.arrayContaining(['react', 'typescript']));
    expect(m.concerns).toHaveLength(0);
  });
  it('flags sponsorship conflicts and caps the score', () => {
    const m = computeMatch(
      { ...profile, requiresSponsorship: true },
      {
        title: 'Senior Frontend Engineer',
        company: 'Acme',
        description: 'React, TypeScript. We are unable to sponsor visas for this role.',
        location: 'Remote',
        workplaceType: 'remote',
        employmentType: 'full_time',
        salaryMin: null,
        salaryMax: null,
      },
    );
    expect(m.score).toBeLessThanOrEqual(25);
    expect(m.concerns.join(' ')).toMatch(/sponsorship/);
  });
  it('detects no-sponsorship language', () => {
    expect(sponsorshipUnavailable('No visa sponsorship is available')).toBe(true);
    expect(sponsorshipUnavailable('We sponsor visas')).toBe(false);
  });
});

const autofill = (over: Partial<AutofillProfile> = {}): AutofillProfile => ({
  firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 20 7946 0000',
  city: 'London', region: null, country: 'United Kingdom', postalCode: null, addressLine1: null, location: 'London, United Kingdom',
  linkedinUrl: null, githubUrl: null, portfolioUrl: null, currentCompany: 'Analytical Engines', currentTitle: 'Engineer',
  yearsExperience: 7.5, highestDegree: null, school: null,
  workAuthorizations: [
    { country: 'United Kingdom', authorized: true, requiresSponsorship: false },
    { country: 'United States', authorized: false, requiresSponsorship: true },
  ],
  noticePeriod: '4 weeks', availableFrom: null, desiredSalaryMin: 90000, desiredSalaryMax: null, salaryCurrency: 'GBP',
  willingToRelocate: null, experiences: [], educations: [],
  screening: ScreeningAnswers.parse({}),
  verifiedKeys: ['firstName', 'lastName', 'workAuthorizations', 'yearsExperience', 'noticePeriod', 'desiredSalaryMin'],
  ...over,
});

describe('question answering from verified facts', () => {
  it('classifies questions', () => {
    expect(classifyQuestion('Will you now or in the future require visa sponsorship?')).toBe('sponsorship');
    expect(classifyQuestion('Are you legally authorized to work in the United States?')).toBe('work_authorization');
    expect(classifyQuestion('What is your gender?')).toBe('demographic');
    expect(classifyQuestion('Why do you want to work here?')).toBe('motivation');
    // Citizenship / residency are eligibility facts: never AI-answered.
    expect(classifyQuestion('Are you a Singapore citizen?')).toBe('work_authorization');
    expect(classifyQuestion('Are you a Singapore permanent resident?')).toBe('work_authorization');
  });
  it('answers authorization for the named country only', () => {
    const a = answerFromProfile('Are you legally authorized to work in the US?', ['Yes', 'No'], autofill());
    expect(a).toMatchObject({ answer: 'No', needsUser: false });
    const b = answerFromProfile('Will you require sponsorship to work in the UK?', ['Yes', 'No'], autofill());
    expect(b).toMatchObject({ answer: 'No', needsUser: false });
    const c = answerFromProfile('Are you authorized to work in Canada?', ['Yes', 'No'], autofill());
    expect(c.needsUser).toBe(true);
  });
  it('refuses when authorization is not verified', () => {
    const a = answerFromProfile('Are you authorized to work in the US?', ['Yes', 'No'], autofill({ verifiedKeys: [] }));
    expect(a.needsUser).toBe(true);
    expect(a.answer).toBeNull();
  });
  it('answers country of residence from the verified profile', () => {
    const p = autofill({ verifiedKeys: ['country'] });
    expect(answerFromProfile('What is your current country of residence?', ['Select...', 'United Kingdom', 'United States'], p)).toMatchObject({ answer: 'United Kingdom', needsUser: false });
    expect(answerFromProfile('What is your current country of residence?', ['United Kingdom'], autofill({ verifiedKeys: [] })).needsUser).toBe(true);
  });
  it('picks experience ranges', () => {
    expect(answerFromProfile('How many years of experience do you have?', ['0-2', '3-5', '6-8', '9+'], autofill()).answer).toBe('6-8');
  });
  it('normalises question keys', () => {
    expect(questionKey('Why do you want to work here? *')).toBe(questionKey('why do you want to work here'));
  });
  it('matches options conservatively', () => {
    expect(matchOption(['Select...', 'United Kingdom', 'United States'], 'united kingdom')?.option).toBe('United Kingdom');
    expect(matchOption(['Red', 'Blue'], 'United Kingdom')).toBeNull();
    expect(pickBooleanOption(['Yes, I am', 'No, I am not'], false)).toBe('No, I am not');
  });
});

describe('profile assessment', () => {
  const base = (): FullCandidateProfile => ({
    profile: { ...CandidateProfileInput.parse({}), verifiedAt: null, updatedAt: null },
    experiences: [],
    educations: [],
    certifications: [],
    projects: [],
  });
  it('reports missing fields and blocks automation', () => {
    const a = assessProfile(base());
    expect(a.completeness).toBe(0);
    expect(a.readyForAutomation).toBe(false);
    expect(a.missing.map((m) => m.field)).toContain('email');
  });
  it('detects date contradictions', () => {
    const p = base();
    p.experiences.push({
      id: '1', company: 'X', title: 'Y', location: null, startDate: '2022-05', endDate: '2021-01', isCurrent: true,
      description: null, achievements: [], source: 'resume', verified: false, sortOrder: 0,
    });
    const a = assessProfile(p);
    expect(a.issues.filter((i) => i.severity === 'error')).toHaveLength(2);
  });
  it('excludes unverified facts from autofill verifiedKeys', () => {
    const p = base();
    p.profile.firstName = 'Ada';
    p.profile.fieldMeta = { firstName: { source: 'resume', verified: false } };
    expect(buildAutofillProfile(p).verifiedKeys).not.toContain('firstName');
    p.profile.fieldMeta.firstName.verified = true;
    expect(buildAutofillProfile(p).verifiedKeys).toContain('firstName');
  });
});

describe('normalisation', () => {
  it('phones', () => {
    expect(normalizePhone('+1 (415) 555-0100').e164).toBe('+14155550100');
    expect(normalizePhone('415 555 0100').e164).toBeNull();
  });
  it('loose dates', () => {
    expect(parseLooseDate('Jan 2020')).toBe('2020-01');
    expect(parseLooseDate('03/2021')).toBe('2021-03');
    expect(parseLooseDate('Present')).toBe('present');
    expect(formatDateForField('2021-03', 'us')).toBe('03/01/2021');
  });
});

describe('liveness (ported from career-ops)', () => {
  it('reads closure banners as expired', () => {
    expect(classifyLiveness({ status: 200, bodyText: 'Sorry, this job is no longer available.' }).result).toBe('expired');
  });
  it('treats bot walls as uncertain, never expired', () => {
    expect(classifyLiveness({ status: 200, bodyText: 'Just a moment... checking your browser before' }).result).toBe('uncertain');
  });
  it('apply control means active', () => {
    expect(classifyLiveness({ status: 200, bodyText: 'x'.repeat(400), applyControls: ['Apply for this job'] }).result).toBe('active');
  });
});

describe('automatic discovery filters', () => {
  it('matches target titles by core keywords and common synonyms', () => {
    const targets = ['Senior Frontend Engineer'];
    expect(titleFit('Frontend Engineer II', targets)).toBeGreaterThan(0.9);
    expect(titleFit('Front-End Developer', targets)).toBeGreaterThan(0.5);
    expect(titleFit('Staff Software Engineer, Web (React)', targets)).toBeGreaterThan(0);
    expect(titleFit('Backend Engineer', targets)).toBe(0);
    expect(titleFit('Account Executive', ['Software Engineer'])).toBe(0);
    expect(titleKeywords('Sr. Product Manager II')).toEqual(['product', 'manager']);
  });
  it('respects remote and location preferences, and explicit remote regions', () => {
    const us = { workplaceTypes: ['remote'], desiredLocations: [], city: 'Austin', country: 'United States' };
    expect(locationFits({ location: 'Remote', workplaceType: 'remote' }, us)).toBe(true);
    expect(locationFits({ location: 'Remote (US only)', workplaceType: 'remote' }, us)).toBe(true);
    expect(locationFits({ location: 'Remote - Europe', workplaceType: 'remote' }, us)).toBe(false);
    expect(locationFits({ location: 'Berlin, Germany', workplaceType: null }, us)).toBe(false); // office job, remote only
    const office = { workplaceTypes: ['onsite', 'hybrid'], desiredLocations: ['London'], city: null, country: 'United Kingdom' };
    expect(locationFits({ location: 'London, UK', workplaceType: 'hybrid' }, office)).toBe(true);
    expect(locationFits({ location: 'Manchester, United Kingdom', workplaceType: null }, office)).toBe(true);
    expect(locationFits({ location: 'New York, NY', workplaceType: null }, office)).toBe(false);
    expect(locationFits({ location: 'Remote', workplaceType: 'remote' }, office)).toBe(false);
  });
  it('keeps only recent postings', () => {
    const now = Date.parse('2026-10-10T00:00:00Z');
    expect(isRecent('2026-10-01T00:00:00Z', 21, now)).toBe(true);
    expect(isRecent('2026-08-01T00:00:00Z', 21, now)).toBe(false);
    expect(isRecent(null, 21, now)).toBe(true);
  });
});

describe('screening answers from the profile', () => {
  const withScreening = (s: Partial<ScreeningAnswers>) => autofill({ screening: ScreeningAnswers.parse(s) });
  it('declines voluntary self-identification by default, picking the form\'s own wording', () => {
    const p = withScreening({});
    expect(answerFromProfile('Gender', ['Male', 'Female', 'Decline To Self Identify'], p).answer).toBe('Decline To Self Identify');
    expect(answerFromProfile('Veteran Status', ['I am not a protected veteran', 'I identify as one or more of the classifications of protected veteran', "I don't wish to answer"], p).answer).toBe("I don't wish to answer");
    expect(answerFromProfile('Are you Hispanic/Latino?', ['Yes', 'No', 'Prefer not to say'], p).answer).toBe('Prefer not to say');
  });
  it('uses answers the person chose to give', () => {
    const p = withScreening({ eeo: 'answer', gender: 'Female', over18: true, backgroundCheck: true, referralSource: 'LinkedIn' });
    expect(answerFromProfile('Gender', ['Male', 'Female', 'Decline To Self Identify'], p).answer).toBe('Female');
    expect(answerFromProfile('Are you at least 18 years of age?', ['Yes', 'No'], p).answer).toBe('Yes');
    expect(answerFromProfile('Are you willing to undergo a background check?', ['Yes', 'No'], p).answer).toBe('Yes');
    expect(answerFromProfile('How did you hear about us?', ['Company website', 'LinkedIn', 'Referral'], p).answer).toBe('LinkedIn');
    expect(answerFromProfile('How did you hear about this job?', undefined, p).answer).toBe('LinkedIn');
  });
  it('only ticks consent boxes when the person allowed it, and never guesses unset facts', () => {
    expect(answerFromProfile('I acknowledge the privacy notice', undefined, withScreening({})).needsUser).toBe(true);
    expect(answerFromProfile('I acknowledge the privacy notice', undefined, withScreening({ acceptConsents: true })).answer).toBe('Yes');
    expect(answerFromProfile('Have you ever been convicted of a felony?', ['Yes', 'No'], withScreening({})).needsUser).toBe(true);
  });
  it('picks the salary option containing the expectation', () => {
    const p = autofill({ desiredSalaryMin: 95000 });
    expect(answerFromProfile('Desired salary range', ['$50,000 - $80,000', '$80,000 - $100,000', '$100k+'], p).answer).toBe('$80,000 - $100,000');
  });
});
