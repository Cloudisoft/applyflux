import { cleanText, findButton, isVisible } from '../dom';
import type { PlatformAdapter } from './types';

export type { PlatformAdapter, AdapterCapabilities, TestStatus } from './types';

const NEXT = [/^(next|continue|save (and|&) continue|next step|proceed)\b/i];
const SUBMIT = [/^submit( application| my application)?$/i, /^(send|complete) application$/i, /^apply( now)?$/i, /^submit$/i];
const NOT_SUBMIT = [/^apply (with|using) linkedin/i, /indeed/i, /^save (draft|for later)/i];

const hostIs = (h: string, s: string) => h === s || h.endsWith('.' + s);

function formWithInputs(doc: Document, selector: string): HTMLElement | null {
  const forms = Array.from(doc.querySelectorAll<HTMLElement>(selector));
  return forms.find((f) => isVisible(f) && f.querySelectorAll('input:not([type=hidden]), textarea, select').length >= 2) ?? null;
}

/** ApplyFlux Sandbox: mock application pages served by the ApplyFlux API for setup tests and E2E. */
export const sandboxAdapter: PlatformAdapter = {
  id: 'sandbox',
  name: 'ApplyFlux Sandbox',
  capabilities: { autofill: true, multiStep: true, attachments: true, autoSubmit: true },
  testStatus: 'tested_sandbox',
  matchesUrl: (u) => /^\/sandbox\//.test(u.pathname),
  matchesDocument: (d) => !!d.querySelector('meta[name="applyflux-sandbox"]'),
  findForm: (d) => formWithInputs(d, 'form[data-applyflux-form]'),
  openApplication: (d) => {
    const b = d.querySelector<HTMLElement>('[data-action="open-application"]');
    if (b && isVisible(b)) {
      b.click();
      return true;
    }
    return false;
  },
  nextButton: (d) => d.querySelector<HTMLElement>('form[data-applyflux-form] [data-action="next"]:not([disabled])'),
  submitButton: (d) => d.querySelector<HTMLElement>('form[data-applyflux-form] [data-action="submit"]:not([disabled])'),
  addSectionButton: (d, s) => d.querySelector<HTMLElement>(`[data-action="add-${s}"]`),
  formSelector: 'form[data-applyflux-form]',
};

/**
 * Greenhouse hosted boards (boards.greenhouse.io, job-boards.greenhouse.io) and
 * embedded boards (#grnhse_app iframe on company sites). Single-page form with
 * standard ids (first_name, last_name, email, phone) and question_* fields.
 */
export const greenhouseAdapter: PlatformAdapter = {
  id: 'greenhouse',
  name: 'Greenhouse',
  capabilities: { autofill: true, multiStep: false, attachments: true, autoSubmit: true },
  testStatus: 'tested_fixture',
  matchesUrl: (u) => hostIs(u.hostname, 'greenhouse.io') || u.searchParams.has('gh_jid'),
  matchesDocument: (d) => !!d.querySelector('#application_form, form#application-form, #grnhse_app, [data-provides="greenhouse"]'),
  findForm: (d) => formWithInputs(d, '#application_form, form#application-form, form[action*="greenhouse"], form.application--form, main form'),
  openApplication: (d) => {
    const b = findButton(d, [/^apply( for this job| now)?$/i]);
    if (b && !greenhouseAdapter.findForm(d)) {
      b.click();
      return true;
    }
    return false;
  },
  nextButton: () => null,
  submitButton: (d) =>
    d.querySelector<HTMLElement>('#submit_app, button[type="submit"].application--submit') ?? findButton(d, SUBMIT, NOT_SUBMIT),
  mappingRules: [
    { match: (f) => f.element.id === 'first_name', key: 'firstName' },
    { match: (f) => f.element.id === 'last_name', key: 'lastName' },
    { match: (f) => f.element.id === 'email', key: 'email' },
    { match: (f) => f.element.id === 'phone', key: 'phone' },
    { match: (f) => f.kind === 'file' && /resume/i.test(f.element.id + (f.name ?? '')), key: 'resume' },
    { match: (f) => f.kind === 'file' && /cover/i.test(f.element.id + (f.name ?? '')), key: 'coverLetter' },
    { match: (f) => /job_application\[location\]|candidate-location/i.test(f.name ?? f.element.id), key: 'location' },
  ],
  confirmationText: [/thank you for applying/i, /application (has been )?submitted/i],
  confirmationUrl: [/\/confirmation/i],
  formSelector: '#application_form, form#application-form',
};

/** Lever hosted applications (jobs.lever.co/<company>/<id>/apply). Single page, name="urls[LinkedIn]" style fields. */
export const leverAdapter: PlatformAdapter = {
  id: 'lever',
  name: 'Lever',
  capabilities: { autofill: true, multiStep: false, attachments: true, autoSubmit: true },
  testStatus: 'tested_fixture',
  matchesUrl: (u) => hostIs(u.hostname, 'lever.co'),
  findForm: (d) => formWithInputs(d, 'form#application-form, form[action*="/apply"], .application-form form, form'),
  openApplication: (d) => {
    const a = d.querySelector<HTMLAnchorElement>('a.postings-btn[href$="/apply"], a[href$="/apply"]');
    if (a && !leverAdapter.findForm(d)) {
      a.click();
      return true;
    }
    return false;
  },
  nextButton: () => null,
  submitButton: (d) => d.querySelector<HTMLElement>('#btn-submit, button[data-qa="btn-submit"]') ?? findButton(d, SUBMIT, NOT_SUBMIT),
  mappingRules: [
    { match: (f) => f.name === 'name', key: 'fullName' },
    { match: (f) => f.name === 'email', key: 'email' },
    { match: (f) => f.name === 'phone', key: 'phone' },
    { match: (f) => f.name === 'org', key: 'currentCompany' },
    { match: (f) => f.name === 'location', key: 'location' },
    { match: (f) => /^urls\[linkedin\]$/i.test(f.name ?? ''), key: 'linkedinUrl' },
    { match: (f) => /^urls\[github\]$/i.test(f.name ?? ''), key: 'githubUrl' },
    { match: (f) => /^urls\[portfolio\]$/i.test(f.name ?? ''), key: 'portfolioUrl' },
    { match: (f) => /^urls\[other\]$/i.test(f.name ?? ''), key: 'websiteUrl' },
    { match: (f) => f.kind === 'file' && f.name === 'resume', key: 'resume' },
    { match: (f) => f.kind === 'textarea' && f.name === 'comments', key: 'coverLetterText' },
  ],
  confirmationText: [/application submitted/i, /thanks for applying/i],
  confirmationUrl: [/\/thanks/i],
};

/** Ashby hosted applications (jobs.ashbyhq.com/<org>/<id>/application). React single page. */
export const ashbyAdapter: PlatformAdapter = {
  id: 'ashby',
  name: 'Ashby',
  capabilities: { autofill: true, multiStep: false, attachments: true, autoSubmit: false },
  testStatus: 'tested_fixture',
  matchesUrl: (u) => hostIs(u.hostname, 'ashbyhq.com'),
  findForm: (d) => formWithInputs(d, 'form, [class*="ApplicationForm"]'),
  openApplication: (d) => {
    const tab = Array.from(d.querySelectorAll<HTMLElement>('a, button')).find((b) => /^application$/i.test(cleanText(b.textContent)));
    if (tab && !ashbyAdapter.findForm(d)) {
      tab.click();
      return true;
    }
    return false;
  },
  nextButton: () => null,
  submitButton: (d) => findButton(d, [/^submit application$/i, ...SUBMIT], NOT_SUBMIT),
  mappingRules: [
    { match: (f) => f.name === '_systemfield_name', key: 'fullName' },
    { match: (f) => f.name === '_systemfield_email', key: 'email' },
    { match: (f) => f.kind === 'file' && /_systemfield_resume/.test(f.name ?? f.element.id), key: 'resume' },
  ],
};

/**
 * Workday (myworkdayjobs.com). Multi-step wizard driven by data-automation-id
 * attributes. Most tenants require creating a Workday account first; ApplyFlux
 * pauses for the person to sign in (login_required) and never creates accounts.
 */
export const workdayAdapter: PlatformAdapter = {
  id: 'workday',
  name: 'Workday',
  capabilities: { autofill: true, multiStep: true, attachments: true, autoSubmit: false },
  testStatus: 'tested_fixture',
  matchesUrl: (u) => hostIs(u.hostname, 'myworkdayjobs.com') || hostIs(u.hostname, 'myworkdaysite.com'),
  findForm: (d) =>
    d.querySelector<HTMLElement>('[data-automation-id="applyFlowPage"], [data-automation-id="applicationPage"]') ??
    formWithInputs(d, 'form, [role="main"]'),
  openApplication: (d) => {
    const manual = d.querySelector<HTMLElement>('[data-automation-id="applyManually"]');
    if (manual && isVisible(manual)) {
      manual.click();
      return true;
    }
    const apply = d.querySelector<HTMLElement>('[data-automation-id="adventureButton"], a[data-uxi-element-id="Apply_adventureButton"]');
    if (apply && isVisible(apply)) {
      apply.click();
      return true;
    }
    return false;
  },
  nextButton: (d) =>
    d.querySelector<HTMLElement>('[data-automation-id="bottom-navigation-next-button"], [data-automation-id="pageFooterNextButton"]') ??
    findButton(d, NEXT),
  submitButton: (d) => {
    const b = d.querySelector<HTMLElement>('[data-automation-id="bottom-navigation-next-button"], [data-automation-id="pageFooterNextButton"]');
    return b && /submit/i.test(cleanText(b.textContent)) ? b : findButton(d, [/^submit$/i]);
  },
  addSectionButton: (d, s) =>
    d.querySelector<HTMLElement>(
      s === 'experience' ? '[data-automation-id="workExperienceSection"] [data-automation-id="Add"], [aria-label="Add Work Experience"]' : '[data-automation-id="educationSection"] [data-automation-id="Add"], [aria-label="Add Education"]',
    ),
  groupSelectors: ['[data-automation-id^="workExperience-"]', '[data-automation-id^="education-"]'],
  mappingRules: [
    { match: (f) => /legalNameSection_firstName/.test(f.element.getAttribute('data-automation-id') ?? f.element.id), key: 'firstName' },
    { match: (f) => /legalNameSection_lastName/.test(f.element.getAttribute('data-automation-id') ?? f.element.id), key: 'lastName' },
    { match: (f) => /addressSection_addressLine1/.test(f.element.getAttribute('data-automation-id') ?? f.element.id), key: 'addressLine1' },
    { match: (f) => /addressSection_city/.test(f.element.getAttribute('data-automation-id') ?? f.element.id), key: 'city' },
    { match: (f) => /addressSection_postalCode/.test(f.element.getAttribute('data-automation-id') ?? f.element.id), key: 'postalCode' },
    { match: (f) => /^email$/.test(f.element.getAttribute('data-automation-id') ?? ''), key: 'email' },
    { match: (f) => /phone-number/.test(f.element.getAttribute('data-automation-id') ?? ''), key: 'phone' },
    { match: (f) => f.kind === 'file' && /file-upload-input-ref/.test(f.element.getAttribute('data-automation-id') ?? ''), key: 'resume' },
  ],
  confirmationText: [/application (was )?submitted/i, /congratulations.*application/i],
};

/** iCIMS (careers-<company>.icims.com). Multi-step, frequently inside an iframe and behind sign-in. */
export const icimsAdapter: PlatformAdapter = {
  id: 'icims',
  name: 'iCIMS',
  capabilities: { autofill: true, multiStep: true, attachments: true, autoSubmit: false },
  testStatus: 'tested_fixture',
  matchesUrl: (u) => hostIs(u.hostname, 'icims.com'),
  findForm: (d) => formWithInputs(d, 'form.iCIMS_Forms, form#cp_form, form'),
  nextButton: (d) => d.querySelector<HTMLElement>('#cp_form_submit_i, input[type="submit"][value="Next"]') ?? findButton(d, NEXT),
  submitButton: (d) => findButton(d, [/^submit( application)?$/i]),
  confirmationText: [/thank you for (your interest|applying)/i, /application (is )?complete/i],
};

/**
 * LinkedIn: LinkedIn's User Agreement prohibits automated activity on its
 * services, so ApplyFlux does not automate LinkedIn (including Easy Apply).
 * The adapter detects LinkedIn pages so the user gets a clear manual fallback.
 */
export const linkedinAdapter: PlatformAdapter = {
  id: 'linkedin',
  name: 'LinkedIn',
  capabilities: { autofill: false, multiStep: false, attachments: false, autoSubmit: false },
  testStatus: 'manual_only',
  restriction:
    "LinkedIn's User Agreement prohibits automated access, so ApplyFlux will not fill or submit LinkedIn Easy Apply. Open the job and apply manually; ApplyFlux will track it.",
  matchesUrl: (u) => hostIs(u.hostname, 'linkedin.com'),
  findForm: () => null,
  nextButton: () => null,
  submitButton: () => null,
};

/** Any other careers page: deterministic detection + mapping, Assisted/Review only. */
export const genericAdapter: PlatformAdapter = {
  id: 'generic',
  name: 'Company career page',
  capabilities: { autofill: true, multiStep: true, attachments: true, autoSubmit: false },
  testStatus: 'tested_fixture',
  matchesUrl: () => true,
  findForm: (d) => {
    const forms = Array.from(d.querySelectorAll<HTMLElement>('form')).filter(isVisible);
    const scored = forms
      .map((f) => ({
        f,
        n: f.querySelectorAll('input:not([type=hidden]):not([type=search]), textarea, select').length + (f.querySelector('input[type=file]') ? 5 : 0),
        login: !!f.querySelector('input[type=password]'),
      }))
      .filter((x) => !x.login && x.n >= 3)
      .sort((a, b) => b.n - a.n);
    return scored[0]?.f ?? null;
  },
  nextButton: (d) => findButton(d, NEXT),
  submitButton: (d) => findButton(d, SUBMIT, NOT_SUBMIT),
};

export const ADAPTERS: PlatformAdapter[] = [
  sandboxAdapter,
  linkedinAdapter,
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  workdayAdapter,
  icimsAdapter,
  genericAdapter,
];

export function selectAdapter(doc: Document, href?: string): PlatformAdapter {
  let url: URL | null = null;
  try {
    url = new URL(href ?? doc.location.href);
  } catch {
    url = null;
  }
  for (const a of ADAPTERS) {
    if (a.id === 'generic') continue;
    if (url && a.matchesUrl(url) && (a.id !== 'sandbox' || a.matchesDocument?.(doc))) return a;
  }
  // Company-hosted pages embedding a known ATS.
  for (const a of ADAPTERS) if (a.id !== 'generic' && a.id !== 'sandbox' && a.matchesDocument?.(doc)) return a;
  if (sandboxAdapter.matchesDocument?.(doc)) return sandboxAdapter;
  return genericAdapter;
}

export function adapterById(id: string): PlatformAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
