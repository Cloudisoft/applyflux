/// <reference types="chrome" />
/**
 * Content script: runs inside the job application tab only when the service
 * worker injects it for an application the person queued. It reads and fills
 * the application form; it never reads other tabs, cookies or browsing history.
 */
import {
  challengeBlocking,
  challengeResolved,
  collectSubmissionEvidence,
  detectAuthWall,
  detectChallenge,
  hasVisibleErrors,
  judgeEvidence,
  questionsPayload,
  runPass,
  selectAdapter,
  sleep,
  toReported,
  waitFor,
  type EngineContext,
  type FileAttachment,
  type PassResult,
} from '@applyflux/form-engine';
import type { ExtensionReport, ResolvedAnswer } from '@applyflux/shared';
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

async function handleBlockers(ctx: RunContext, pass: PassResult): Promise<'continue' | 'stop'> {
  if (challengeBlocking(pass.challenge)) {
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
  if ((await handleBlockers(ctx, pass)) === 'stop') return null;
  if (challengeBlocking(pass.challenge)) return fillCurrentStep(ctx, engine);
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
  // The person was reviewing and submitted it themselves.
  if (ctx.phase === 'awaiting_review' && !ctx.submitApproved) {
    const ev = collectSubmissionEvidence(document, { adapter: adapter.id, extraText: adapter.confirmationText, extraUrl: adapter.confirmationUrl, formSelector: adapter.formSelector });
    if (ev.matchedSignals.length && !ev.formStillPresent) {
      await report(ctx, { type: 'submit_attempted', data: { pageUrl: location.href } }).catch(() => {});
      await report(ctx, { type: 'submission_result', data: ev });
    }
    return;
  }
  if (ctx.phase === 'awaiting_verification') await waitForVerification(ctx);

  if (adapter.restriction || !adapter.capabilities.autofill) {
    await report(ctx, { type: 'intervention', data: { intervention: 'automation_restricted', message: adapter.restriction ?? `${adapter.name} is not supported for automated filling.`, pageUrl: location.href } });
    return;
  }

  const engine: EngineContext = {
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
    if ((await handleBlockers(ctx, pass)) === 'stop') return;
    if (!adapter.findForm(document)) {
      await report(ctx, { type: 'intervention', data: { intervention: 'unexpected_form', message: 'ApplyFlux could not find an application form on this page.', pageUrl: location.href } });
      return;
    }
  }

  const startUrl = location.href;
  for (let step = 1; step <= MAX_STEPS; step++) {
    await waitWhilePaused();
    const pass = await fillCurrentStep(ctx, engine);
    if (!pass) return;
    const fields = toReported(pass.results);
    await report(ctx, { type: 'progress', data: { step: pass.hasNext && !pass.hasSubmit ? `Filled step ${step}` : 'Filled final step', progress: Math.min(85, 20 + step * 15), adapter: adapter.id, fields, stepState: { step, url: location.href }, pageUrl: location.href } });

    if (pass.missingRequired.length) {
      await report(ctx, {
        type: 'intervention',
        data: { intervention: 'missing_answers', message: `${pass.missingRequired.length} required question(s) need your answer: ${pass.missingRequired.map((r) => r.field.label).slice(0, 5).join('; ')}`, fields, stepState: { step, url: location.href }, pageUrl: location.href },
      });
      return;
    }
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
