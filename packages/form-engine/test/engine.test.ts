import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ScreeningAnswers, type AutofillProfile } from '@applyflux/shared';
import {
  detectFields,
  mapField,
  runPass,
  selectAdapter,
  detectChallenge,
  challengeBlocking,
  challengeResolved,
  detectAuthWall,
  collectSubmissionEvidence,
  judgeEvidence,
  greenhouseAdapter,
  leverAdapter,
  workdayAdapter,
  genericAdapter,
  linkedinAdapter,
  toReported,
  fillField,
  stillMissing,
} from '../src';

function load(name: string, url = 'https://example.com/apply') {
  const html = readFileSync(join(__dirname, 'fixtures', name), 'utf8');
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  return dom.window.document;
}

/** Simulates react-select: typing renders matching options into the listbox. */
function wireCombobox(doc: Document, id: string, options: string[]) {
  const input = doc.getElementById(id) as HTMLInputElement;
  const list = doc.getElementById(input.getAttribute('aria-controls')!)!;
  input.addEventListener('input', () => {
    list.innerHTML = '';
    for (const o of options.filter((x) => x.toLowerCase().includes(input.value.toLowerCase().slice(0, 3)))) {
      const div = doc.createElement('div');
      div.setAttribute('role', 'option');
      div.textContent = o;
      div.addEventListener('click', () => {
        input.value = o;
        input.setAttribute('data-selected', o);
        list.innerHTML = '';
      });
      list.appendChild(div);
    }
  });
}

const profile = (over: Partial<AutofillProfile> = {}): AutofillProfile => ({
  firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 20 7946 0000',
  city: 'London', region: null, country: 'United Kingdom', postalCode: null, addressLine1: null, location: 'London, United Kingdom',
  linkedinUrl: 'https://www.linkedin.com/in/ada', githubUrl: null, portfolioUrl: null,
  currentCompany: 'Analytical Engines', currentTitle: 'Engineer', yearsExperience: 7, highestDegree: 'Bachelor of Science', school: 'University of London',
  workAuthorizations: [{ country: 'United Kingdom', authorized: true, requiresSponsorship: false }],
  noticePeriod: '4 weeks', availableFrom: null, desiredSalaryMin: null, desiredSalaryMax: null, salaryCurrency: null, willingToRelocate: null,
  experiences: [
    { company: 'Analytical Engines', title: 'Engineer', location: 'London', startDate: '2020-03', endDate: null, isCurrent: true, description: null, verified: true },
    { company: 'Difference Ltd', title: 'Junior Engineer', location: 'London', startDate: '2017-06', endDate: '2020-02', isCurrent: false, description: null, verified: true },
  ],
  educations: [{ institution: 'University of London', degree: 'Bachelor of Science', fieldOfStudy: 'Mathematics', startDate: '2013', endDate: '2017', verified: true }],
  screening: ScreeningAnswers.parse({}),
  verifiedKeys: ['firstName', 'lastName', 'fullName', 'email', 'phone', 'linkedinUrl', 'workAuthorizations', 'location', 'city', 'country', 'currentCompany', 'currentTitle'],
  ...over,
});

const pdf = { fileName: 'Ada_Lovelace_CV.pdf', mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 test') };

describe('field detection (Greenhouse-shaped markup)', () => {
  it('finds fields with accessible labels and skips hidden helper inputs', () => {
    const doc = load('greenhouse.html', 'https://job-boards.greenhouse.io/acme/jobs/123');
    const fields = detectFields(doc);
    const labels = fields.map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(['First Name', 'Last Name', 'Email', 'Phone', 'Resume/CV', 'Cover Letter', 'LinkedIn Profile']));
    expect(fields.find((f) => f.element.id === 'resume')?.required).toBe(true);
    expect(fields.find((f) => f.element.id === 'question_3')?.kind).toBe('combobox');
    // aria-hidden required helper inputs are not fields
    expect(fields.some((f) => f.element.classList.contains('requiredInput'))).toBe(false);
  });
  it('maps by autocomplete and label, and treats long questions as questions', () => {
    const doc = load('greenhouse.html');
    const byId = Object.fromEntries(detectFields(doc).map((f) => [f.element.id, mapField(f)]));
    expect(byId.first_name.mappedTo).toBe('firstName');
    expect(byId.email.mappedTo).toBe('email');
    expect(byId.resume.mappedTo).toBe('resume');
    expect(byId.cover_letter.mappedTo).toBe('coverLetter');
    expect(byId.question_1.mappedTo).toBe('linkedinUrl');
    expect(byId.question_2.mappedTo).toBe('question');
    expect(byId.question_3.mappedTo).toBe('question');
  });
});

describe('runPass', () => {
  it('fills a Greenhouse form, attaches the resume, defers questions to the server', async () => {
    const doc = load('greenhouse.html', 'https://job-boards.greenhouse.io/acme/jobs/123');
    wireCombobox(doc, 'country', ['United Kingdom +44', 'United States +1']);
    wireCombobox(doc, 'question_3', ['Yes', 'No']);
    const adapter = selectAdapter(doc);
    expect(adapter.id).toBe('greenhouse');
    const ctx = { adapter, mode: 'assisted' as const, profile: profile(), savedAnswers: [], files: { resume: pdf } };
    const pass = await runPass(doc, ctx);
    expect((doc.getElementById('first_name') as HTMLInputElement).value).toBe('Ada');
    expect((doc.getElementById('email') as HTMLInputElement).value).toBe('ada@example.com');
    expect((doc.getElementById('resume') as HTMLInputElement).files?.[0]?.name).toBe('Ada_Lovelace_CV.pdf');
    expect((doc.getElementById('country') as HTMLInputElement).value).toBe('United Kingdom +44');
    expect(pass.pendingQuestions.map((q) => q.element.id)).toEqual(expect.arrayContaining(['question_2', 'question_3', 'gender']));
    expect(pass.hasSubmit).toBe(true);

    // Second pass with server answers: sponsorship from verified facts; motivation AI draft; gender needs the user.
    const pass2 = await runPass(doc, {
      ...ctx,
      resolved: {
        question_2: { key: 'question_2', answer: 'I build reliable systems and Acme...', source: 'ai', confidence: 0.8, needsUser: false },
        question_3: { key: 'question_3', answer: 'No', source: 'profile', confidence: 0.95, needsUser: false },
        gender: { key: 'gender', answer: null, source: 'none', confidence: 0, needsUser: true, reason: 'Sensitive' },
      },
    });
    expect((doc.getElementById('question_3') as HTMLInputElement).value).toBe('No');
    expect((doc.getElementById('question_2') as HTMLTextAreaElement).value).toMatch(/^I build/);
    expect(pass2.uncertain.map((r) => r.field.element.id)).toContain('question_2');
    expect(pass2.missingRequired).toHaveLength(0);
    expect((doc.getElementById('gender') as HTMLInputElement).value).toBe('');
  });

  it('never accepts an AI answer for a sensitive question even if the server sent one', async () => {
    const doc = load('greenhouse.html');
    wireCombobox(doc, 'question_3', ['Yes', 'No']);
    const pass = await runPass(doc, {
      adapter: greenhouseAdapter, mode: 'assisted', profile: profile(), savedAnswers: [], files: { resume: pdf },
      resolved: { question_3: { key: 'question_3', answer: 'No', source: 'ai', confidence: 0.99, needsUser: false } },
    });
    expect((doc.getElementById('question_3') as HTMLInputElement).value).toBe('');
    expect(pass.missingRequired.map((r) => r.field.element.id)).toContain('question_3');
  });

  it('never writes while the person is working, and never over a field they touched', async () => {
    const doc = load('greenhouse.html');
    const first = doc.getElementById('first_name') as HTMLInputElement;
    const email = doc.getElementById('email') as HTMLInputElement;
    let busyUntil = Date.now() + 600;
    const writes: Array<{ id: string; at: number }> = [];
    for (const el of [first, email]) el.addEventListener('input', () => writes.push({ id: el.id, at: Date.now() }));
    // The person is typing their own first name (empty so far) when the pass starts.
    const started = Date.now();
    await runPass(doc, {
      adapter: greenhouseAdapter, mode: 'assisted', profile: profile(), savedAnswers: [], files: {},
      personBusy: () => Date.now() < busyUntil,
      touchedByPerson: (el) => el === first,
    });
    expect(first.value).toBe('');
    expect(writes.some((w) => w.id === 'first_name')).toBe(false);
    // Other fields were filled, but only once the person had paused.
    expect(email.value).not.toBe('');
    expect(Math.min(...writes.map((w) => w.at))).toBeGreaterThanOrEqual(started + 550);
    busyUntil = 0;
  }, 30_000);

  it('keeps a choice the person made after the pass started', async () => {
    const doc = load('greenhouse.html');
    wireCombobox(doc, 'question_3', ['Yes', 'No']);
    const input = doc.getElementById('question_3') as HTMLInputElement;
    const pass = await runPass(doc, {
      adapter: greenhouseAdapter, mode: 'auto', profile: profile(), savedAnswers: [], files: {},
      resolved: { question_3: { key: 'question_3', answer: 'No', source: 'saved', confidence: 0.99, needsUser: false } },
      // The person picks "Yes" while the pass waits for them to pause.
      personBusy: () => {
        if (!input.value) input.value = 'Yes';
        return false;
      },
      touchedByPerson: () => false,
    });
    expect(input.value).toBe('Yes');
    expect(pass.results.find((r) => r.field.element === input)?.reason).toBe('Answered by you');
  });

  it('Auto Mode refuses unverified profile values', async () => {
    const doc = load('greenhouse.html');
    const pass = await runPass(doc, {
      adapter: greenhouseAdapter, mode: 'auto', profile: profile({ verifiedKeys: ['email'] }), savedAnswers: [], files: { resume: pdf },
    });
    expect((doc.getElementById('first_name') as HTMLInputElement).value).toBe('');
    expect(pass.missingRequired.map((r) => r.field.element.id)).toContain('first_name');
  });

  it('Review mode fills unverified values but flags them', async () => {
    const doc = load('greenhouse.html');
    const pass = await runPass(doc, {
      adapter: greenhouseAdapter, mode: 'review', profile: profile({ verifiedKeys: ['email'] }), savedAnswers: [], files: {},
    });
    expect((doc.getElementById('first_name') as HTMLInputElement).value).toBe('Ada');
    expect(pass.uncertain.map((r) => r.field.element.id)).toContain('first_name');
    expect(pass.missingRequired.map((r) => r.field.element.id)).toContain('resume');
  });

  it('reuses approved saved answers, including checkbox groups and radios (Lever-shaped markup)', async () => {
    const doc = load('lever.html', 'https://jobs.lever.co/acme/abc-123/apply');
    const adapter = selectAdapter(doc);
    expect(adapter.id).toBe('lever');
    const pass = await runPass(doc, {
      adapter, mode: 'assisted', profile: profile(), files: { resume: pdf },
      savedAnswers: [
        { questionKey: 'language skill s check all that apply', answer: 'English (ENG); French (FRA)', category: 'other' },
        { questionKey: 'are you legally authorized to work in the united states', answer: 'No', category: 'work_authorization' },
      ],
    });
    const q = (s: string) => doc.querySelector(s) as HTMLInputElement;
    expect(q('input[name="name"]').value).toBe('Ada Lovelace');
    expect(q('input[name="org"]').value).toBe('Analytical Engines');
    expect(q('input[name="urls[LinkedIn]"]').value).toBe('https://www.linkedin.com/in/ada');
    expect(q('input[value="English (ENG)"]').checked).toBe(true);
    expect(q('input[value="French (FRA)"]').checked).toBe(true);
    expect(q('input[value="Spanish (SPA)"]').checked).toBe(false);
    expect(q('input[name="cards[c1][field1]"][value="No"]').checked).toBe(true);
    expect(pass.missingRequired).toHaveLength(0);
    // GitHub empty in profile: optional, skipped, not guessed
    expect(q('input[name="urls[GitHub]"]').value).toBe('');
  });

  it('fills repeating work-history and education sections (Workday-shaped markup)', async () => {
    const doc = load('workday-experience.html', 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/apply');
    const adapter = selectAdapter(doc);
    expect(adapter.id).toBe('workday');
    const pass = await runPass(doc, { adapter, mode: 'assisted', profile: profile(), savedAnswers: [], files: {} });
    const v = (id: string) => (doc.getElementById(id) as HTMLInputElement).value;
    expect(v('we1-title')).toBe('Engineer');
    expect(v('we1-company')).toBe('Analytical Engines');
    expect(v('we1-from')).toBe('03/2020');
    expect((doc.getElementById('we1-current') as HTMLInputElement).checked).toBe(true);
    expect(v('we1-to')).toBe('');
    expect(v('we2-company')).toBe('Difference Ltd');
    expect(v('we2-to')).toBe('02/2020');
    expect(v('ed1-school')).toBe('University of London');
    expect((doc.getElementById('ed1-degree') as HTMLSelectElement).value).toBe('bsc');
    expect(pass.hasNext).toBe(true);
    expect(pass.missingRequired).toHaveLength(0);
  });
});

describe('human verification', () => {
  it('fills the form around an unticked reCAPTCHA checkbox, which the person ticks before submit', async () => {
    const doc = load('recaptcha.html');
    const c = detectChallenge(doc);
    expect(c.provider).toBe('recaptcha');
    expect(c.widgetVisible).toBe(true);
    expect(challengeBlocking(c)).toBe(true); // needs the person before submitting
    expect(challengeResolved(c)).toBe(false);
    const pass = await runPass(doc, { adapter: genericAdapter, mode: 'auto', profile: profile(), savedAnswers: [], files: {} });
    expect(pass.blockedByChallenge).toBe(false);
    expect((doc.getElementById('first_name') as HTMLInputElement).value).toBe('Ada');
    expect(pass.results.some((r) => /recaptcha/i.test(r.field.name ?? ''))).toBe(false);
  });
  it('does not fill a form locked behind a verification checkbox', async () => {
    const doc = load('recaptcha.html');
    for (const id of ['first_name', 'last_name', 'email']) doc.getElementById(id)!.hidden = true;
    const pass = await runPass(doc, { adapter: genericAdapter, mode: 'auto', profile: profile(), savedAnswers: [], files: {} });
    expect(pass.blockedByChallenge).toBe(true);
    expect(pass.results).toHaveLength(0);
  });
  it.each([
    ['reCAPTCHA v3 / Enterprise (invisible iframe)', '<iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=key&size=invisible"></iframe><div class="grecaptcha-badge"></div>'],
    ['reCAPTCHA bound to the submit button', '<button class="g-recaptcha" data-sitekey="key" data-callback="onSubmit">Submit</button>'],
    ['invisible hCaptcha', '<div class="h-captcha" data-sitekey="key" data-size="invisible"><iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox-invisible"></iframe></div>'],
    ['an empty widget container whose iframe never rendered', '<div data-sitekey="key"></div>'],
  ])('never pauses for %s', async (_name, html) => {
    const doc = new JSDOM(`<!doctype html><form id="f"><label for="first_name">First Name*</label><input id="first_name" required><label for="last_name">Last Name*</label><input id="last_name" required><label for="email">Email*</label><input id="email" type="email" required>${html}<button type="submit">Submit application</button></form>`, { url: 'https://example.com/apply', pretendToBeVisual: true }).window.document;
    const c = detectChallenge(doc);
    expect(c.present).toBe(true);
    expect(challengeBlocking(c)).toBe(false);
    const pass = await runPass(doc, { adapter: genericAdapter, mode: 'auto', profile: profile(), savedAnswers: [], files: {} });
    expect(pass.blockedByChallenge).toBe(false);
    expect((doc.getElementById('first_name') as HTMLInputElement).value).toBe('Ada');
  });
  it('requires a response token as evidence of completion', () => {
    const doc = load('recaptcha.html');
    (doc.getElementById('g-recaptcha-response') as HTMLTextAreaElement).value = 'token-from-google';
    const c = detectChallenge(doc);
    expect(challengeResolved(c)).toBe(true);
    expect(challengeBlocking(c)).toBe(false);
  });
  it('detects an open challenge popup even when a token exists', () => {
    const doc = load('recaptcha.html');
    const f = doc.createElement('iframe');
    f.src = 'https://www.google.com/recaptcha/api2/bframe?k=test';
    doc.body.appendChild(f);
    const c = detectChallenge(doc);
    expect(c.challengeVisible).toBe(true);
    expect(challengeResolved(c)).toBe(false);
  });
  it('detects sign-in walls', () => {
    expect(detectAuthWall(load('login.html'))).toBe('login_required');
    expect(detectAuthWall(load('greenhouse.html'))).toBeNull();
  });
});

describe('submission evidence', () => {
  it('confirms only with a confirmation message and the form gone', () => {
    const dom = new JSDOM('<html><body><h1>Thank you for applying!</h1><p>Your application has been submitted.</p></body></html>', {
      url: 'https://job-boards.greenhouse.io/acme/jobs/123/confirmation',
    });
    const e = collectSubmissionEvidence(dom.window.document, { adapter: 'greenhouse' });
    expect(e.formStillPresent).toBe(false);
    expect(judgeEvidence(e)).toBe('confirmed');
  });
  it('a page that still shows the form with errors is a failure', () => {
    const doc = load('greenhouse.html');
    const err = doc.createElement('div');
    err.setAttribute('role', 'alert');
    err.textContent = 'First Name is required';
    doc.body.appendChild(err);
    expect(judgeEvidence(collectSubmissionEvidence(doc, { adapter: 'greenhouse' }))).toBe('failed');
  });
  it('no signal at all is unverified, never confirmed', () => {
    const dom = new JSDOM('<html><body><p>Loading…</p></body></html>', { url: 'https://example.com/careers' });
    expect(judgeEvidence(collectSubmissionEvidence(dom.window.document, { adapter: 'generic' }))).toBe('unverified');
  });
});

describe('adapters', () => {
  it('routes LinkedIn to the manual-only adapter', () => {
    const dom = new JSDOM('<html><body></body></html>', { url: 'https://www.linkedin.com/jobs/view/123' });
    const a = selectAdapter(dom.window.document);
    expect(a).toBe(linkedinAdapter);
    expect(a.restriction).toBeTruthy();
    expect(a.capabilities.autofill).toBe(false);
  });
  it('only restricted sites are kept from submitting (the server decides per platform via AUTO_SUBMIT_PLATFORMS)', () => {
    expect(workdayAdapter.capabilities.autoSubmit).toBe(true);
    expect(linkedinAdapter.capabilities.autoSubmit).toBe(false);
    expect(leverAdapter.capabilities.autofill).toBe(true);
  });
  it('serialises results for reporting', async () => {
    const doc = load('lever.html', 'https://jobs.lever.co/acme/abc-123/apply');
    const pass = await runPass(doc, { adapter: leverAdapter, mode: 'review', profile: profile(), savedAnswers: [], files: {} });
    const rep = toReported(pass.results);
    expect(rep.every((r) => typeof r.key === 'string' && r.label.length > 0)).toBe(true);
  });
});

describe('Ashby (div-based form with Yes/No buttons)', () => {
  it('finds the form without a <form> tag, fills profile fields and clicks the right Yes/No button', async () => {
    const doc = load('ashby.html', 'https://jobs.ashbyhq.com/acme/123/application');
    const adapter = selectAdapter(doc);
    expect(adapter.id).toBe('ashby');
    expect(adapter.findForm(doc)).not.toBeNull();
    const clicked: string[] = [];
    doc.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => clicked.push(b.textContent!)));
    const ctx = { adapter, mode: 'auto' as const, profile: profile(), savedAnswers: [], files: {} };
    const first = await runPass(doc, ctx);
    expect((doc.getElementById('_systemfield_name') as HTMLInputElement).value).toBe('Ada Lovelace');
    expect((doc.getElementById('_systemfield_email') as HTMLInputElement).value).toBe('ada@example.com');
    // The sponsorship question is detected as a choice (not the hidden checkbox) and sent for an answer.
    const q = first.pendingQuestions.find((f) => /sponsorship/.test(f.label))!;
    expect(q.kind).toBe('radio');
    expect(q.options).toEqual(['Yes', 'No']);
    expect(first.pendingQuestions.some((f) => f.kind === 'checkbox')).toBe(false);
    // The autofill uploader outside the application container is not treated as the resume field.
    expect(first.results.filter((r) => r.field.kind === 'file').map((r) => r.field.element.id)).toEqual(['_systemfield_resume']);
    const second = await runPass(doc, { ...ctx, resolved: { [q.key]: { key: q.key, answer: 'No', source: 'profile', confidence: 0.95, needsUser: false } } });
    expect(clicked).toContain('No');
    expect(clicked).not.toContain('Yes');
    expect(second.hasSubmit).toBe(true);
    expect(adapter.submitButton(doc)?.textContent).toBe('Submit Application');
  });

  it('finds div-based forms on unknown sites from the submit button', () => {
    const doc = new JSDOM(`<!doctype html><div id="app"><div class="apply"><label for="a">First name</label><input id="a"><label for="b">Last name</label><input id="b"><label for="c">Email</label><input id="c" type="email"><button>Submit application</button></div></div>`, { url: 'https://careers.example.com/apply', pretendToBeVisual: true }).window.document;
    expect(genericAdapter.findForm(doc)?.className).toBe('apply');
  });
});


describe('searchable dropdowns (react-select, as on Greenhouse job boards)', () => {
  /** A react-select look-alike: the menu opens on mousedown on the control; the choice shows in a single-value div. */
  function reactSelect(id: string, label: string, options: string[]) {
    return `<div class="field"><label for="${id}">${label} *</label><div class="select__container"><div class="select__control">
      <div class="select__value-container"><div class="select__placeholder">Select...</div><div class="select__input-container">
      <input id="${id}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-required="true" required class="select__input" value=""></div></div></div>
      <div class="select__menu-host" data-options='${JSON.stringify(options).replace(/'/g, '&#39;')}'></div></div></div>`;
  }
  function wire(doc: Document) {
    for (const host of Array.from(doc.querySelectorAll<HTMLElement>('.select__menu-host'))) {
      const options: string[] = JSON.parse(host.dataset.options!);
      const container = host.parentElement!;
      const input = container.querySelector('input')!;
      const render = (filter: string) => {
        host.innerHTML = '';
        const menu = doc.createElement('div');
        menu.className = 'select__menu';
        const shown = options.filter((o) => o.toLowerCase().includes(filter.toLowerCase()));
        if (!shown.length) menu.innerHTML = '<div class="select__menu-notice--no-options">No options</div>';
        for (const o of shown) {
          const el = doc.createElement('div');
          el.className = 'select__option';
          el.id = `react-select-${input.id}-option-${options.indexOf(o)}`;
          el.textContent = o;
          el.addEventListener('click', () => {
            const vc = container.querySelector('.select__value-container')!;
            vc.querySelector('.select__placeholder, .select__single-value')?.remove();
            const sv = doc.createElement('div');
            sv.className = 'select__single-value';
            sv.textContent = o;
            vc.prepend(sv);
            input.value = '';
            host.innerHTML = '';
          });
          menu.appendChild(el);
        }
        host.appendChild(menu);
      };
      container.querySelector('.select__control')!.addEventListener('mousedown', () => render(''));
      input.addEventListener('input', () => render(input.value));
    }
  }
  const page = () => {
    const doc = new JSDOM(`<!doctype html><form>${reactSelect('vet', 'Protected Veteran Status', ['I identify as one or more of the classifications of protected veteran', 'I am not a protected veteran', "I don't wish to answer"])}
      ${reactSelect('gender', 'Gender', ['Male', 'Female', 'Decline To Self Identify'])}<button type="submit">Submit</button></form>`, { url: 'https://job-boards.greenhouse.io/x/jobs/1', pretendToBeVisual: true }).window.document;
    wire(doc);
    return doc;
  };

  it('opens the menu, picks the option that means the answer (without filtering it away), and reads the choice back', async () => {
    const doc = page();
    const fields = detectFields(doc);
    const vet = fields.find((f) => f.element.id === 'vet')!;
    const gender = fields.find((f) => f.element.id === 'gender')!;
    expect(vet.kind).toBe('combobox');
    expect(vet.currentValue).toBe('');
    expect(await fillField(vet, 'No')).toMatchObject({ ok: true, value: 'I am not a protected veteran' });
    expect(await fillField(gender, 'Prefer not to say')).toMatchObject({ ok: true, value: 'Decline To Self Identify' });
    const again = detectFields(doc);
    expect(again.find((f) => f.element.id === 'vet')!.currentValue).toBe('I am not a protected veteran');
  });

  it('treats a dropdown the person chose themselves as answered (typed search text alone is not an answer)', () => {
    const doc = page();
    const missing = detectFields(doc).filter((f) => f.required);
    const adapter = { ...genericAdapter, findForm: (d: Document) => d.querySelector('form') };
    const gender = doc.getElementById('gender') as HTMLInputElement;
    gender.value = 'Fem';
    expect(stillMissing(doc, adapter, missing).map((f) => f.element.id)).toEqual(['vet', 'gender']);
    (doc.querySelector('.select__control') as HTMLElement).dispatchEvent(new doc.defaultView!.MouseEvent('mousedown', { bubbles: true }));
    (doc.querySelector('.select__option:nth-child(2)') as HTMLElement).click();
    expect(stillMissing(doc, adapter, missing).map((f) => f.element.id)).toEqual(['gender']);
  });
});
