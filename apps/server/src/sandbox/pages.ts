/**
 * ApplyFlux Sandbox: realistic mock application pages for the onboarding test
 * run and end-to-end tests. Clearly labelled; nothing submitted here leaves
 * ApplyFlux. The mock verification widget imitates how a CAPTCHA behaves
 * (blocks the form, needs a person, yields a response token) so pause/resume
 * can be exercised without touching any real CAPTCHA provider.
 */

export const SCENARIOS = {
  standard: { title: 'Senior Frontend Engineer', steps: 1, captcha: 'none', note: 'Single-page application form' },
  multistep: { title: 'Product Designer', steps: 3, captcha: 'none', note: 'Three-step form with work history and conditional questions' },
  'captcha-before': { title: 'Data Analyst', steps: 1, captcha: 'before', note: 'Verification required before the form unlocks' },
  'captcha-submit': { title: 'Backend Engineer', steps: 1, captcha: 'submit', note: 'Verification challenge appears when you submit' },
  'captcha-repeat': { title: 'Platform Engineer', steps: 3, captcha: 'repeat', note: 'Verification appears on every step' },
  'validation-error': { title: 'Customer Success Manager', steps: 1, captcha: 'none', note: 'The first submission is rejected with a field error' },
  'no-confirmation': { title: 'Marketing Manager', steps: 1, captcha: 'none', note: 'Submits without a clear confirmation page' },
  login: { title: 'Solutions Engineer', steps: 1, captcha: 'none', note: 'Requires signing in to an account first' },
} as const;
export type Scenario = keyof typeof SCENARIOS;

const COMPANY = 'Northwind Labs';

const STYLE = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f7fb;color:#151826}
.banner{background:#1e1b4b;color:#e0e7ff;padding:8px 16px;font-size:13px;text-align:center}
.wrap{max-width:760px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 12px}
.muted{color:#5b6070}.card{background:#fff;border:1px solid #e3e6ef;border-radius:14px;padding:24px;margin-top:20px}
label{display:block;font-weight:600;margin:14px 0 6px}input[type=text],input[type=email],input[type=tel],input[type=url],input[type=password],select,textarea{width:100%;padding:10px 12px;border:1px solid #cfd4e2;border-radius:10px;font:inherit;background:#fff}
textarea{min-height:110px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.opt{display:flex;gap:8px;align-items:center;font-weight:400;margin:6px 0}
button{background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:11px 18px;font:600 15px inherit;cursor:pointer}
button.secondary{background:#eef0f7;color:#151826}.actions{display:flex;justify-content:space-between;margin-top:24px}
.error{color:#b42318;font-size:13px;margin-top:4px}.steps{display:flex;gap:8px;margin:8px 0 0}.steps span{flex:1;height:4px;border-radius:4px;background:#e3e6ef}.steps span.on{background:#4f46e5}
fieldset{border:0;padding:0;margin:0}legend{font-weight:600;margin:14px 0 6px;padding:0}
.repeat{border:1px dashed #cfd4e2;border-radius:12px;padding:12px 16px;margin:12px 0}
.captcha{border:1px solid #cfd4e2;border-radius:10px;padding:14px;display:flex;gap:10px;align-items:center;background:#fafbff;margin:16px 0}
.popup{position:fixed;inset:0;background:rgba(15,17,30,.55);display:flex;align-items:center;justify-content:center}
.popup .box{background:#fff;border-radius:14px;padding:24px;width:320px;text-align:center}
[hidden]{display:none!important}
`;

function shell(title: string, body: string, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="applyflux-sandbox" content="1"><meta name="robots" content="noindex"><title>${title}</title><style>${STYLE}</style></head>
<body><div class="banner">ApplyFlux Sandbox — a fictional employer for testing. Nothing submitted here is sent anywhere.</div>
<div class="wrap">${body}</div><script>${script}</script></body></html>`;
}

const CAPTCHA_WIDGET = `
<div class="captcha" data-applyflux-captcha="generic" id="af-captcha">
  <input type="checkbox" id="af-captcha-check" aria-label="I am not a robot"><span>I'm not a robot</span>
  <input type="hidden" name="applyflux-captcha-response" id="af-captcha-token" value="">
</div>
<div class="popup" data-applyflux-captcha-popup hidden id="af-captcha-popup">
  <div class="box"><p><strong>Verify you are human</strong></p><p class="muted">Select every square with a traffic light.</p>
  <button type="button" id="af-captcha-verify">Verify</button></div>
</div>`;

const CAPTCHA_SCRIPT = `
function afCaptchaInit(onDone){
  var check=document.getElementById('af-captcha-check'),pop=document.getElementById('af-captcha-popup'),tok=document.getElementById('af-captcha-token');
  check.addEventListener('change',function(){ if(check.checked){ pop.hidden=false; } });
  document.getElementById('af-captcha-verify').addEventListener('click',function(){ pop.hidden=true; tok.value='sandbox-token-'+Date.now(); check.checked=true; onDone&&onDone(); });
}
function afCaptchaReset(){ var t=document.getElementById('af-captcha-token'); if(t){t.value='';} var c=document.getElementById('af-captcha-check'); if(c){c.checked=false;} }
`;

export function postingPage(scenario: Scenario, ref: string) {
  const s = SCENARIOS[scenario];
  return shell(
    `${s.title} — ${COMPANY}`,
    `<p class="muted">${COMPANY} · Remote (Europe) · Full-time</p><h1>${s.title}</h1>
<div class="card"><h2>About the role</h2>
<p>We're looking for a ${s.title.toLowerCase()} to help us build tools for small businesses. You'll work with TypeScript, React and Node.js, PostgreSQL and AWS, partnering closely with product and design.</p>
<ul><li>4+ years of relevant experience</li><li>Strong communication and stakeholder management</li><li>Experience with CI/CD and testing</li></ul>
<p class="muted">Scenario: ${s.note}.</p>
<a href="/sandbox/jobs/${scenario}/apply?ref=${encodeURIComponent(ref)}" data-action="open-application"><button type="button">Apply for this job</button></a></div>`,
  );
}

function contactFields() {
  return `<div class="row"><div><label for="first_name">First name *</label><input type="text" id="first_name" name="first_name" autocomplete="given-name" required></div>
<div><label for="last_name">Last name *</label><input type="text" id="last_name" name="last_name" autocomplete="family-name" required></div></div>
<label for="email">Email *</label><input type="email" id="email" name="email" required>
<label for="phone">Phone</label><input type="tel" id="phone" name="phone">
<label for="location">Location (city) *</label><input type="text" id="location" name="location" required>
<label for="resume">Resume/CV *</label><input type="file" id="resume" name="resume" accept=".pdf,.docx,.doc,.txt" required>
<label for="linkedin">LinkedIn profile</label><input type="url" id="linkedin" name="linkedin">`;
}

function questionFields() {
  return `<fieldset id="q-auth" aria-required="true"><legend>Are you legally authorized to work in the United Kingdom? *</legend>
<label class="opt"><input type="radio" name="authorized" value="yes" required> Yes</label><label class="opt"><input type="radio" name="authorized" value="no"> No</label></fieldset>
<fieldset id="q-sponsor" aria-required="true"><legend>Will you now or in the future require visa sponsorship? *</legend>
<label class="opt"><input type="radio" name="sponsorship" value="yes" required> Yes</label><label class="opt"><input type="radio" name="sponsorship" value="no"> No</label></fieldset>
<div id="visa-wrap" hidden><label for="visa_type">Which visa would you need? *</label><input type="text" id="visa_type" name="visa_type"></div>
<label for="notice">What is your notice period?</label><input type="text" id="notice" name="notice">
<label for="why">Why do you want to work at ${COMPANY}? *</label><textarea id="why" name="why" required maxlength="1500"></textarea>
<label for="heard">How did you hear about us?</label><select id="heard" name="heard"><option value="">Select…</option><option>Job board</option><option>Company website</option><option>Referral</option><option>Other</option></select>
<label class="opt"><input type="checkbox" id="consent" name="consent" required> I consent to ${COMPANY} processing my data for recruitment purposes. *</label>`;
}

function experienceFields() {
  const group = (n: number) => `<div class="repeat" data-repeat-group="experience"><strong>Work experience ${n}</strong>
<div class="row"><div><label for="exp${n}_title">Job title${n === 1 ? ' *' : ''}</label><input type="text" id="exp${n}_title" name="exp${n}_title" ${n === 1 ? 'required' : ''}></div>
<div><label for="exp${n}_company">Company${n === 1 ? ' *' : ''}</label><input type="text" id="exp${n}_company" name="exp${n}_company" ${n === 1 ? 'required' : ''}></div></div>
<div class="row"><div><label for="exp${n}_from">From</label><input type="text" id="exp${n}_from" name="exp${n}_from" placeholder="MM/YYYY"></div>
<div><label for="exp${n}_to">To</label><input type="text" id="exp${n}_to" name="exp${n}_to" placeholder="MM/YYYY"></div></div>
<label class="opt"><input type="checkbox" id="exp${n}_current" name="exp${n}_current"> I currently work here</label></div>`;
  return `${group(1)}${group(2)}
<div class="repeat" data-repeat-group="education"><strong>Education</strong>
<label for="edu1_school">School or university</label><input type="text" id="edu1_school" name="edu1_school">
<label for="edu1_degree">Degree</label><input type="text" id="edu1_degree" name="edu1_degree"></div>`;
}

export function applyPage(scenario: Scenario, ref: string) {
  const s = SCENARIOS[scenario];
  if (scenario === 'login') {
    return shell(
      `Sign in — ${COMPANY}`,
      `<h1>Sign in to continue your application</h1><div class="card"><form method="post" action="#" onsubmit="return false">
<label for="u">Email address</label><input type="email" id="u"><label for="p">Password</label><input type="password" id="p">
<div class="actions"><button type="submit">Sign in</button><a href="#">Create account</a></div></form></div>`,
    );
  }
  const multi = s.steps === 3;
  const step = (n: number, content: string) => `<section data-step="${n}" ${n > 1 ? 'hidden' : ''}>${content}</section>`;
  const body = multi
    ? step(1, `<h2>Your details</h2>${contactFields()}`) + step(2, `<h2>Experience</h2>${experienceFields()}`) + step(3, `<h2>A few questions</h2>${questionFields()}`)
    : step(1, `${contactFields()}<h2>Questions</h2>${questionFields()}`);
  const captchaBefore = s.captcha === 'before' || s.captcha === 'repeat';
  return shell(
    `Apply: ${s.title} — ${COMPANY}`,
    `<p class="muted">${COMPANY}</p><h1>Apply: ${s.title}</h1>
${multi ? '<div class="steps"><span class="on"></span><span></span><span></span></div>' : ''}
<div class="card"><form id="application-form" data-applyflux-form method="post" action="/sandbox/jobs/${scenario}/submit?ref=${encodeURIComponent(ref)}" enctype="multipart/form-data" novalidate>
${captchaBefore ? CAPTCHA_WIDGET : ''}
<div id="form-body" ${s.captcha === 'before' ? 'hidden' : ''}>${body}</div>
<div id="form-error" class="error" role="alert"></div>
${s.captcha === 'submit' ? CAPTCHA_WIDGET.replace('class="captcha"', 'class="captcha" data-size="invisible" hidden') : ''}
<div class="actions">${multi ? '<button type="button" class="secondary" data-action="back" hidden>Back</button><button type="button" data-action="next">Next</button>' : '<span></span>'}
<button type="submit" data-action="submit" ${multi ? 'hidden' : ''}>Submit application</button></div>
</form></div>`,
    `${CAPTCHA_SCRIPT}
var scenario=${JSON.stringify(scenario)}, step=1, steps=${s.steps};
var form=document.getElementById('application-form'), body=document.getElementById('form-body'), err=document.getElementById('form-error');
function show(n){ step=n; document.querySelectorAll('section[data-step]').forEach(function(sec){ sec.hidden = Number(sec.dataset.step)!==n; });
  document.querySelectorAll('.steps span').forEach(function(b,i){ b.className = i<n?'on':''; });
  var next=document.querySelector('[data-action=next]'), back=document.querySelector('[data-action=back]'), sub=document.querySelector('[data-action=submit]');
  if(next){ next.hidden = n===steps; } if(back){ back.hidden = n===1; } if(sub && steps>1){ sub.hidden = n!==steps; }
  if(scenario==='captcha-repeat' && n>1){ afCaptchaReset(); body.hidden=true; document.getElementById('af-captcha').hidden=false; }
}
if(${captchaBefore}){ afCaptchaInit(function(){ body.hidden=false; if(scenario==='captcha-repeat'){ document.getElementById('af-captcha').hidden=true; } }); }
document.querySelectorAll('input[name=sponsorship]').forEach(function(r){ r.addEventListener('change',function(){ var w=document.getElementById('visa-wrap'); var on=document.querySelector('input[name=sponsorship]:checked').value==='yes'; w.hidden=!on; document.getElementById('visa_type').required=on; }); });
function validate(scope){ var bad=[]; scope.querySelectorAll('[required]').forEach(function(el){ if(el.closest('[hidden]')) return;
  var ok = el.type==='radio' ? !!scope.querySelector('input[name="'+el.name+'"]:checked') : el.type==='checkbox' ? el.checked : el.type==='file' ? el.files.length>0 : !!el.value.trim();
  el.setAttribute('aria-invalid', ok?'false':'true'); if(!ok) bad.push(el.name||el.id); });
  err.textContent = bad.length ? 'Please complete the required fields: '+Array.from(new Set(bad)).join(', ') : ''; return !bad.length; }
var nextBtn=document.querySelector('[data-action=next]'); if(nextBtn) nextBtn.addEventListener('click',function(){ var sec=document.querySelector('section[data-step="'+step+'"]'); if(validate(sec)) show(step+1); });
var backBtn=document.querySelector('[data-action=back]'); if(backBtn) backBtn.addEventListener('click',function(){ show(step-1); });
var verifiedOnSubmit=false;
form.addEventListener('submit',function(e){ if(!validate(form)){ e.preventDefault(); return; }
  if(scenario==='captcha-submit' && !verifiedOnSubmit){ e.preventDefault(); var w=document.getElementById('af-captcha'); w.hidden=false;
    afCaptchaInit(function(){ verifiedOnSubmit=true; }); document.getElementById('af-captcha-popup').hidden=false; }
});
show(1);`,
  );
}

export function thanksPage(scenario: Scenario) {
  if (scenario === 'no-confirmation') return shell(`${COMPANY} careers`, `<h1>${COMPANY}</h1><div class="card"><p class="muted">Explore other openings on our careers page.</p></div>`);
  return shell(
    `Application submitted — ${COMPANY}`,
    `<h1>Thank you for applying!</h1><div class="card"><p>Your application has been submitted. The ${COMPANY} team will review it and get back to you.</p></div>`,
  );
}
