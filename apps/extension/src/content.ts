/// <reference types="chrome" />
/**
 * Content script: runs inside the job application tab only when the service
 * worker injects it for an application the person queued. It reads and fills
 * the application form; it never reads other tabs, cookies or browsing history.
 */
import {
  challengeBlocking,
  challengeBlocksFilling,
  formUsable,
  challengeResolved,
  collectSubmissionEvidence,
  detectAuthWall,
  detectChallenge,
  hasVisibleErrors,
  judgeEvidence,
  questionsPayload,
  runPass,
  comboboxValue,
  detectFields,
  selectAdapter,
  stillMissing,
  sleep,
  toReported,
  waitFor,
  type EngineContext,
  type FileAttachment,
  type PassResult,
} from '@applyflux/form-engine';
import type { ExtensionReport, ResolvedAnswer } from '@applyflux/shared';
import { hideGuide, showGuide } from './guide';
import type { Phase, RunContext } from './messages';

declare global {
  interface Window {
    __applyflux?: { running: boolean; ctx: RunContext | null; paused: boolean; stopped: boolean; listening?: boolean };
  }
}

const MAX_STEPS = 12;
const state = (window.__applyflux ??= { running: false, ctx: null, paused: false, stopped: false });

function send<T = unknown>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.error) return reject(Object.assign(new Error(res.error), { code: res.code }));
      resolve(res as T);
    }),
  );
}

const report = (ctx: RunContext, r: ExtensionReport) => send({ type: 'af:report', applicationId: ctx.applicationId, report: r });
const phase = (ctx: RunContext, p: Exclude<Phase, 'opening'>) => send({ type: 'af:phase', applicationId: ctx.applicationId, phase: p });

function toFile(f: { fileName: string; mimeType: string; base64: string }): FileAttachment {
  const bin = atob(f.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { fileName: f.fileName, mimeType: f.mimeType, bytes };
}

function checkControl() {
  if (state.stopped) throw new Stop();
}
class Stop extends Error {}

async function waitWhilePaused() {
  while (state.paused && !state.stopped) await sleep(1000);
  checkControl();
}

/** Wait (indefinitely, until stopped) for positive evidence that the person completed verification. */
async function waitForVerification(ctx: RunContext, resumePhase: 'filling' | 'submitting' = 'filling') {
  await phase(ctx, 'awaiting_verification');
  for (;;) {
    checkControl();
    const c = detectChallenge(document);
    if (challengeResolved(c)) {
      hideGuide();
      try {
        await report(ctx, { type: 'verification_resolved', data: { challengeVisible: c.challengeVisible, tokenPresent: c.present ? c.tokenPresent : true, provider: c.provider ?? 'none', observedAt: new Date().toISOString() } });
        await phase(ctx, resumePhase);
        await sleep(500);
        return;
      } catch {
        // Server did not accept the evidence yet; keep waiting.
      }
    }
    await sleep(1500);
  }
}

/** Many checks (Cloudflare's "Just a moment", Turnstile, invisible reCAPTCHA) pass on their own in a few seconds. */
async function clearsOnItsOwn(engine: EngineContext): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    checkControl();
    const form = engine.adapter.findForm(document);
    const c = detectChallenge(document);
    if (!challengeBlocksFilling(c, !!form && formUsable(form))) return true;
  }
  return false;
}

async function handleBlockers(ctx: RunContext, pass: PassResult, engine?: EngineContext): Promise<'continue' | 'stop'> {
  if (pass.blockedByChallenge && engine && (await clearsOnItsOwn(engine))) return 'continue';
  if (pass.blockedByChallenge) {
    showGuide(
      pass.challenge.provider === 'interstitial' ? 'Security check' : 'Quick verification',
      pass.challenge.provider === 'interstitial' ? 'Complete the check on this page. ApplyFlux continues by itself afterwards.' : 'Complete the highlighted check. ApplyFlux fills the rest and continues by itself.',
      { highlightCaptcha: pass.challenge.provider !== 'interstitial' },
    );
    await report(ctx, { type: 'intervention', data: { intervention: 'captcha', message: `${pass.challenge.provider === 'interstitial' ? 'A security check' : 'A verification challenge'} appeared. Please complete it in this tab.`, fields: toReported(pass.results), stepState: { url: location.href }, pageUrl: location.href } });
    await waitForVerification(ctx);
    return 'continue';
  }
  if (pass.authWall) {
    await report(ctx, { type: 'intervention', data: { intervention: pass.authWall, message: pass.authWall === 'mfa' ? 'The site is asking for a verification code.' : pass.authWall === 'session_expired' ? 'Your session on this site expired.' : 'This site requires you to sign in first.', pageUrl: location.href } });
    return 'stop';
  }
  return 'continue';
}

async function fillCurrentStep(ctx: RunContext, engine: EngineContext): Promise<PassResult | null> {
  let pass = await runPass(document, engine);
  if ((await handleBlockers(ctx, pass, engine)) === 'stop') return null;
  if (pass.blockedByChallenge) return fillCurrentStep(ctx, engine);
  if (!pass.formFound) return pass;
  if (pass.pendingQuestions.length) {
    const answers = await send<ResolvedAnswer[]>({ type: 'af:answers', applicationId: ctx.applicationId, questions: questionsPayload(pass.pendingQuestions) }).catch((e) => {
      // The questions stay unanswered and go to the person; keep the cause visible for support.
      console.warn('[ApplyFlux] answer drafting failed', (e as Error).message);
      return [] as ResolvedAnswer[];
    });
    engine.resolved = { ...(engine.resolved ?? {}), ...Object.fromEntries(answers.map((a) => [a.key, a])) };
    pass = await runPass(document, engine);
    if ((await handleBlockers(ctx, pass)) === 'stop') return null;
  }
  return pass;
}

async function submitAndVerify(ctx: RunContext, engine: EngineContext) {
  const adapter = engine.adapter;
  // A visible "I'm not a robot" checkbox: everything else is filled, so ask the person to tick it, then submit.
  if (challengeBlocking(detectChallenge(document))) {
    showGuide('Almost done', 'Everything is filled in. Tick the highlighted check and ApplyFlux submits for you.', { highlightCaptcha: true });
    await report(ctx, { type: 'intervention', data: { intervention: 'captcha', message: 'The form is filled. Please tick the verification checkbox in this tab and ApplyFlux will submit.', pageUrl: location.href } });
    await waitForVerification(ctx, 'filling');
  }
  await phase(ctx, 'submitting');
  await report(ctx, { type: 'submit_attempted', data: { pageUrl: location.href } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const btn = adapter.submitButton(document);
    if (!btn) break;
    btn.click();
    // Same-document outcomes (SPA confirmation, inline errors, a challenge popup). Navigation re-injects us in phase 'submitting'.
    await waitFor(() => {
      const ev = collectSubmissionEvidence(document, { adapter: adapter.id, extraText: adapter.confirmationText, extraUrl: adapter.confirmationUrl, formSelector: adapter.formSelector });
      return judgeEvidence(ev) !== 'unverified' || challengeBlocking(detectChallenge(document)) || hasVisibleErrors(document);
    }, 8000);
    const c = detectChallenge(document);
    if (challengeBlocking(c)) {
      showGuide('Quick verification', 'The site asked for a check when submitting. Complete it and ApplyFlux finishes the submission.', { highlightCaptcha: true });
      await report(ctx, { type: 'intervention', data: { intervention: 'captcha', message: 'A verification challenge appeared when submitting. Please complete it in this tab.', pageUrl: location.href } });
      await waitForVerification(ctx, 'submitting');
      // Only re-submit when the first click demonstrably did not go through.
      const ev = collectSubmissionEvidence(document, { adapter: adapter.id, formSelector: adapter.formSelector });
      if (ev.formStillPresent && !ev.matchedSignals.length) continue;
    }
    break;
  }
  await collectAndReport(ctx, adapter.id);
}

async function collectAndReport(ctx: RunContext, adapterId: string) {
  const adapter = selectAdapter(document);
  const ev = collectSubmissionEvidence(document, { adapter: adapterId, extraText: adapter.confirmationText, extraUrl: adapter.confirmationUrl, formSelector: adapter.formSelector });
  await report(ctx, { type: 'submission_result', data: ev });
  await phase(ctx, 'done').catch(() => {});
}

/** Current value of a field as the person left it (option label for choices). */
function valueOf(f: PassResult['results'][number]['field']): string {
  const el = f.element as HTMLInputElement & HTMLSelectElement;
  if (f.choices?.length) {
    const sel = f.choices.find((b) => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true' || b.getAttribute('data-state') === 'on' || /(^|[_\s-])(active|selected|checked)/i.test(b.className));
    return sel?.textContent?.trim() ?? '';
  }
  if (f.group?.length) return f.group.filter((g) => g.checked).map((g) => (g.labels?.[0]?.textContent ?? g.value).trim()).join(', ');
  if (f.kind === 'checkbox') return el.checked ? 'Yes' : '';
  if (f.kind === 'select') return el.selectedOptions?.[0]?.value ? el.selectedOptions[0].textContent?.trim() ?? '' : '';
  if (f.kind === 'combobox') return comboboxValue(el).trim();
  return (el.value ?? '').trim();
}

/**
 * Some required questions are left. Park the application, highlight them, and wait for the person to answer
 * in the form. Their answers are saved (reused on later forms), then the run continues and submits itself.
 */
/** What the person entered for the questions ApplyFlux asked them, read fresh from the page. */
function learnedAnswers(engine: EngineContext, asked: PassResult['results'][number]['field'][]) {
  const form = engine.adapter.findForm(document);
  const fresh = form ? detectFields(document, { root: form, groupSelectors: engine.adapter.groupSelectors, buttonChoiceSelector: engine.adapter.buttonChoiceSelector }) : [];
  return asked
    .map((f) => {
      const now = fresh.find((x) => x.key === f.key) ?? fresh.find((x) => x.label === f.label) ?? f;
      return { question: f.label.replace(/\s*\*\s*$/, '').trim(), answer: valueOf(now) };
    })
    .filter((a) => a.question && a.answer && a.answer.length <= 5000 && !/^(select|choose)/i.test(a.answer));
}

/** Seconds of no typing/clicking before ApplyFlux continues, so it never submits mid-answer. */
const IDLE_MS = 4000;

/**
 * What the person is doing on the page, from real (trusted) input only: ApplyFlux's own typing and clicks are
 * synthetic and never count. While they are active nothing is written, and a field they have worked on is
 * never written over (see EngineContext.personBusy / touchedByPerson).
 */
const person = { lastTouch: 0, touched: new Set<Element>() };
let tracking = false;
function trackPerson() {
  if (tracking) return;
  tracking = true;
  const onEvent = (e: Event) => {
    if (!e.isTrusted) return;
    person.lastTouch = Date.now();
    // Scrolling makes the person busy but doesn't claim a field.
    if (e.type === 'wheel' || e.type === 'touchmove') return;
    // Escape, Tab and modifier keys aren't answers (and go wherever ApplyFlux last put the focus).
    if (e.type === 'keydown' && /^(Escape|Tab|Shift|Control|Alt|Meta|CapsLock)$/.test((e as KeyboardEvent).key)) return;
    if (e.target instanceof Element && !isNavigation(e.target)) person.touched.add(e.target);
  };
  for (const t of ['keydown', 'input', 'change', 'mousedown', 'pointerdown', 'wheel', 'touchstart', 'touchmove']) {
    document.addEventListener(t, onEvent, { capture: true, passive: true });
  }
}
const personBusy = () => Date.now() - person.lastTouch < IDLE_MS;

/** A button that moves through the form (Next, Continue, Submit, Back), as opposed to an answer button: claims no field. */
function isNavigation(el: Element): boolean {
  const btn = el.closest<HTMLElement>('button, [role="button"], input[type="submit"], input[type="button"], a');
  if (!btn) return false;
  if ((btn as HTMLButtonElement).type === 'submit') return true;
  const text = (btn.textContent || (btn as HTMLInputElement).value || btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  return /^(next|continue|submit|review|back|previous|apply|save|done|close|cancel)\b/i.test(text);
}

/** The largest container around a control that holds no other question (a radio group counts as one). */
function scopeOf(el: Element): Element {
  let node = el;
  for (let i = 0; i < 6; i++) {
    const parent = node.parentElement;
    if (!parent || parent === document.body || parent.tagName === 'FORM') break;
    const controls = Array.from(parent.querySelectorAll<HTMLInputElement>('input:not([type=hidden]), select, textarea'));
    const questions = new Set(controls.map((c) => ((c.type === 'radio' || c.type === 'checkbox') && c.name ? `group:${c.name}` : c)));
    if (questions.size > 1) break;
    node = parent;
  }
  return node;
}
function touchedByPerson(el: Element): boolean {
  if (!person.touched.size) return false;
  const scope = scopeOf(el);
  for (const t of person.touched) if (t.isConnected && scope.contains(t)) return true;
  return false;
}

async function waitForPersonAnswers(ctx: RunContext, engine: EngineContext, pass: PassResult, step: number): Promise<PassResult | null> {
  let missing = pass.missingRequired.map((r) => r.field);
  const asked = [...missing];
  // Give the person a moment to start before anything is checked.
  person.lastTouch = Math.max(person.lastTouch, Date.now());

  let marked: HTMLElement[] = [];
  const unmark = () => marked.forEach((el) => {
    el.style.outline = el.dataset.afOutline ?? '';
    el.style.outlineOffset = '';
  });
  const mark = (fields: typeof missing, scroll: boolean) => {
    unmark();
    marked = fields.map((f) => f.element.closest<HTMLElement>('.field, .ashby-application-form-field-entry, fieldset, [class*="question" i], [class*="field" i]') ?? f.element);
    marked.forEach((el) => {
      el.dataset.afOutline ??= el.style.outline;
      el.style.outline = '3px solid #f43f5e';
      el.style.outlineOffset = '4px';
    });
    // Scroll once, when asking; never while the person is working on the page.
    if (scroll) marked[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const ask = async (fields: typeof missing, scroll: boolean) => {
    const labels = fields.map((f) => f.label).slice(0, 5).join('; ');
    await report(ctx, {
      type: 'intervention',
      data: { intervention: 'review_before_submit', message: `${fields.length} question(s) need your answer: ${labels}. Answer them in the tab; ApplyFlux remembers your answers and continues by itself.`, fields: toReported(pass.results), stepState: { step, url: location.href }, pageUrl: location.href },
    });
    await phase(ctx, 'awaiting_review').catch(() => {});
    showGuide('Your answer needed', `Answer the ${fields.length} highlighted question${fields.length === 1 ? '' : 's'}. When you stop typing, ApplyFlux saves your answers for next time and submits by itself.`);
    mark(fields, scroll);
  };
  // If the person submits it themselves, still learn their answers and track the submission.
  let submittedByPerson = false;
  const onPersonSubmit = (e: Event) => {
    if (submittedByPerson) return;
    if (e.type === 'click') {
      const btn = engine.adapter.submitButton(document);
      if (!btn || !(e.target instanceof Node) || !btn.contains(e.target) || stillMissing(document, engine.adapter, asked).length) return;
    }
    submittedByPerson = true;
    const answers = learnedAnswers(engine, asked);
    if (answers.length) send({ type: 'af:report', applicationId: ctx.applicationId, report: { type: 'answers_provided', data: { answers, resume: false } } }).catch(() => {});
    send({ type: 'af:report', applicationId: ctx.applicationId, report: { type: 'submit_attempted', data: { pageUrl: location.href } } }).catch(() => {});
    send({ type: 'af:phase', applicationId: ctx.applicationId, phase: 'submitting' }).catch(() => {});
  };
  document.addEventListener('submit', onPersonSubmit, { capture: true });
  document.addEventListener('click', onPersonSubmit, { capture: true });
  const cleanup = () => {
    document.removeEventListener('submit', onPersonSubmit, { capture: true });
    document.removeEventListener('click', onPersonSubmit, { capture: true });
    unmark();
  };

  try {
    await ask(missing, true);
    for (;;) {
      await sleep(1000);
      checkControl();
      if (submittedByPerson) {
        // The page usually navigates (and the outcome is checked there); if it submits in place, check it here.
        await sleep(2500);
        cleanup();
        hideGuide();
        await collectAndReport(ctx, engine.adapter.id);
        return null;
      }
      // Watch only: nothing is typed, focused or scrolled while the person answers.
      const left = stillMissing(document, engine.adapter, missing);
      if (left.length) {
        if (left.length !== marked.length) mark(left, false);
        continue;
      }
      if (personBusy()) continue;
      // All answered and the person paused: fill anything else once, then carry on.
      const now = await runPass(document, engine);
      if (now.missingRequired.length) {
        // A follow-up question appeared (e.g. "If yes, explain").
        missing = now.missingRequired.map((r) => r.field);
        asked.push(...missing.filter((m) => !asked.some((a) => a.key === m.key)));
        await ask(missing, false);
        continue;
      }
      // Also learn questions ApplyFlux had answered that the person changed.
      for (const r of now.results) {
        const question = !r.mapping.mappedTo || r.mapping.mappedTo === 'question';
        if (question && r.status === 'filled' && touchedByPerson(r.field.element) && !asked.some((a) => a.key === r.field.key)) asked.push(r.field);
      }
      // Remember what the person gave for the questions we could not answer.
      await report(ctx, { type: 'answers_provided', data: { answers: learnedAnswers(engine, asked), resume: true } });
      await phase(ctx, 'filling').catch(() => {});
      hideGuide();
      cleanup();
      return now;
    }
  } catch (e) {
    cleanup();
    if (e instanceof Stop) return null;
    throw e;
  }
}

async function run(ctx: RunContext) {
  state.ctx = ctx;
  state.stopped = false;
  state.paused = false;
  const adapter = selectAdapter(document);

  // Re-injected after a navigation that followed our submit click: just verify the outcome.
  if (ctx.phase === 'submitting') {
    await sleep(800);
    return collectAndReport(ctx, adapter.id);
  }
  // Waiting for the person when the page loaded again: either they submitted it themselves (a confirmation
  // page), or the page reloaded / moved on, in which case the application carries on from here.
  if (ctx.phase === 'awaiting_review' && !ctx.submitApproved) {
    const ev = collectSubmissionEvidence(document, { adapter: adapter.id, extraText: adapter.confirmationText, extraUrl: adapter.confirmationUrl, formSelector: adapter.formSelector });
    if (ev.matchedSignals.length && !ev.formStillPresent) {
      await report(ctx, { type: 'submit_attempted', data: { pageUrl: location.href } }).catch(() => {});
      await report(ctx, { type: 'submission_result', data: ev });
      return;
    }
  }
  if (ctx.phase === 'awaiting_verification') await waitForVerification(ctx);

  if (adapter.restriction || !adapter.capabilities.autofill) {
    await report(ctx, { type: 'intervention', data: { intervention: 'automation_restricted', message: adapter.restriction ?? `${adapter.name} is not supported for automated filling.`, pageUrl: location.href } });
    return;
  }

  trackPerson();
  const engine: EngineContext = {
    personBusy,
    touchedByPerson,
    adapter,
    mode: ctx.mode,
    profile: ctx.profile,
    savedAnswers: ctx.answers,
    files: {
      resume: ctx.resume ? toFile(ctx.resume) : null,
      coverLetter: ctx.coverLetter?.base64 && ctx.coverLetter.fileName ? toFile({ fileName: ctx.coverLetter.fileName, mimeType: ctx.coverLetter.mimeType, base64: ctx.coverLetter.base64 }) : null,
    },
    coverLetterText: ctx.coverLetter?.text ?? null,
  };

  await phase(ctx, 'filling');
  if (!adapter.findForm(document) && adapter.openApplication?.(document)) {
    await waitFor(() => adapter.findForm(document), 8000);
  }
  if (!adapter.findForm(document)) {
    const pass = await runPass(document, engine);
    if ((await handleBlockers(ctx, pass, engine)) === 'stop') return;
    if (!adapter.findForm(document)) {
      await report(ctx, { type: 'intervention', data: { intervention: 'unexpected_form', message: 'ApplyFlux could not find an application form on this page.', pageUrl: location.href } });
      return;
    }
  }

  const startUrl = location.href;
  for (let step = 1; step <= MAX_STEPS; step++) {
    await waitWhilePaused();
    let pass = await fillCurrentStep(ctx, engine);
    if (!pass) return;
    if (pass.missingRequired.length) {
      // Ask the person in the form itself, learn their answers, then carry on (and submit) by ourselves.
      const answered = await waitForPersonAnswers(ctx, engine, pass, step);
      if (!answered) return;
      pass = answered;
    }
    const fields = toReported(pass.results);
    await report(ctx, { type: 'progress', data: { step: pass.hasNext && !pass.hasSubmit ? `Filled step ${step}` : 'Filled final step', progress: Math.min(85, 20 + step * 15), adapter: adapter.id, fields, stepState: { step, url: location.href }, pageUrl: location.href } });

    if (pass.hasNext && !pass.hasSubmit) {
      const before = document.body.innerHTML.length;
      adapter.nextButton(document)!.click();
      await waitFor(() => document.body.innerHTML.length !== before || hasVisibleErrors(document), 6000);
      await sleep(400);
      if (hasVisibleErrors(document) && adapter.findForm(document)) {
        await report(ctx, { type: 'intervention', data: { intervention: 'validation_errors', message: 'The form reported errors on this step.', fields, pageUrl: location.href } });
        return;
      }
      if (new URL(location.href).origin !== new URL(startUrl).origin) {
        await report(ctx, { type: 'intervention', data: { intervention: 'unexpected_navigation', message: `The page navigated to ${location.host}.`, pageUrl: location.href } });
        return;
      }
      continue;
    }
    if (!pass.hasSubmit) {
      await report(ctx, { type: 'intervention', data: { intervention: 'unexpected_form', message: 'No submit or next button was found.', fields, pageUrl: location.href } });
      return;
    }
    // Final step.
    const confident = pass.uncertain.length === 0;
    if (ctx.allowSubmit && (ctx.submitApproved || (ctx.mode === 'auto' && confident && adapter.capabilities.autoSubmit))) {
      await submitAndVerify(ctx, engine);
      return;
    }
    showGuide('Ready for your review', 'ApplyFlux filled this application. Check the answers, then submit.');
    await report(ctx, { type: 'ready_for_review', data: { fields, pageUrl: location.href } });
    await phase(ctx, 'awaiting_review');
    watchManualSubmit(ctx);
    return;
  }
  await report(ctx, { type: 'intervention', data: { intervention: 'unexpected_form', message: `Stopped after ${MAX_STEPS} steps without reaching the end of the form.`, pageUrl: location.href } });
}

/** In Review mode the person clicks Submit; record the attempt so the outcome is tracked. */
function watchManualSubmit(ctx: RunContext) {
  const onSubmit = () => {
    send({ type: 'af:report', applicationId: ctx.applicationId, report: { type: 'submit_attempted', data: { pageUrl: location.href } } }).catch(() => {});
    send({ type: 'af:phase', applicationId: ctx.applicationId, phase: 'submitting' }).catch(() => {});
  };
  document.addEventListener('submit', onSubmit, { capture: true, once: true });
}

function onMessage(msg: { type?: string; ctx?: RunContext }, sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === 'af:pause') state.paused = true;
  if (msg?.type === 'af:resume') state.paused = false;
  if (msg?.type === 'af:stop') state.stopped = true;
  if (msg?.type === 'af:run' && msg.ctx) {
    // Exactly one run at a time per page, however many times we are injected.
    if (state.running) return;
    state.running = true;
    run(msg.ctx as RunContext)
      .catch(async (e) => {
        if (e instanceof Stop) return;
        const ctx = msg.ctx as RunContext;
        await report(ctx, { type: 'failed', data: { code: 'content_error', message: (e as Error).message.slice(0, 500), retryable: true } }).catch(() => {});
      })
      .finally(() => {
        state.running = false;
      });
  }
}

// executeScript may inject this file again into the same page (e.g. after a review approval); listen only once.
if (!state.listening) {
  state.listening = true;
  chrome.runtime.onMessage.addListener(onMessage);
}

send({ type: 'af:ready' }).catch(() => {});
