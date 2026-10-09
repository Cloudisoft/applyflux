/// <reference types="chrome" />
/**
 * ApplyFlux Agent service worker: coordinates one application at a time per
 * browser (the server enforces the user's concurrency limit across browsers).
 * The server is the source of truth; everything here is recoverable from it.
 */
import type { ExecutionTask } from '@applyflux/shared';
import { ApiError, DEFAULTS, api, download, getStored, pair } from './api';
import { ContentToBackground, ExternalMessage, type Phase, type RunContext } from './messages';

interface Active {
  applicationId: string;
  tabId: number;
  phase: Phase;
  task: Omit<ExecutionTask, 'profile' | 'answers'>;
  submitApproved: boolean;
  startedAt: number;
}

const files = new Map<string, { base64: string; mimeType: string }>();
let taskCache: ExecutionTask | null = null;
let ticking = false;

const getActive = async () => ((await chrome.storage.local.get('active')).active as Active | undefined) ?? null;
const setActive = (a: Active | null) => (a ? chrome.storage.local.set({ active: a }) : chrome.storage.local.remove('active'));
const setStatus = (status: Record<string, unknown>) => chrome.storage.session.set({ status: { ...status, at: Date.now() } });

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.info('[ApplyFlux]', msg, extra);
}

async function notifyUser(title: string, message: string) {
  if (!(await chrome.permissions.contains({ permissions: ['notifications'] }))) return;
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon-128.png', title, message, priority: 2 });
}

async function report(applicationId: string, body: unknown) {
  return api<{ ok: boolean; state?: string }>(`/applications/${applicationId}/report`, { body });
}

/* ------------------------------------------------------------------ */
/* Main loop                                                            */
/* ------------------------------------------------------------------ */

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const { token } = await getStored();
    if (!token) return void (await setStatus({ state: 'disconnected' }));
    const active = await getActive();
    if (active) return void (await superviseActive(active));
    const session = await api<{ run: { status: string; mode: string } | null; counts: { queued: number; attention: number } }>('/session');
    await setStatus({ state: session.run?.status ?? 'idle', counts: session.counts, mode: session.run?.mode });
    if (session.run?.status !== 'running') return;
    const next = await api<ExecutionTask | { idle: true; reason: string }>('/next', { method: 'POST' });
    if ('idle' in next) return void (await setStatus({ state: 'running', idleReason: next.reason, counts: session.counts }));
    await startTask(next);
  } catch (e) {
    log('tick failed', { message: (e as Error).message });
    await setStatus({ state: 'error', error: (e as Error).message });
  } finally {
    ticking = false;
  }
}

async function superviseActive(active: Active) {
  // The tab may have been closed by the person.
  const tab = await chrome.tabs.get(active.tabId).catch(() => null);
  if (!tab) {
    log('application tab closed', { id: active.applicationId });
    await report(active.applicationId, { type: 'failed', data: { code: 'tab_closed', message: 'The application tab was closed', retryable: active.phase !== 'submitting' } }).catch(() => {});
    await finish();
    return;
  }
  try {
    const hb = await api<{ signal: 'continue' | 'pause' | 'stop'; state: string; submitApproved?: boolean }>(`/applications/${active.applicationId}/heartbeat`, { method: 'POST' });
    await setStatus({ state: 'working', applicationId: active.applicationId, phase: active.phase, job: { title: active.task.job.title, company: active.task.job.company } });
    if (hb.signal === 'stop') {
      await chrome.tabs.sendMessage(active.tabId, { type: 'af:stop' }).catch(() => {});
      await finish();
      return;
    }
    if (hb.signal === 'pause') {
      await chrome.tabs.sendMessage(active.tabId, { type: 'af:pause' }).catch(() => {});
      return;
    }
    // Clears a pause after the person resumes the run (no-op otherwise).
    await chrome.tabs.sendMessage(active.tabId, { type: 'af:resume' }).catch(() => {});
    if (hb.submitApproved && !active.submitApproved) {
      active.submitApproved = true;
      active.phase = 'filling';
      await setActive(active);
      await inject(active, true);
    }
  } catch (e) {
    if (e instanceof ApiError && ['LEASE_LOST', 'NOT_FOUND', 'EXTENSION_REVOKED', 'UNAUTHENTICATED'].includes(e.code)) await finish();
  }
}

async function finish() {
  taskCache = null;
  files.clear();
  await setActive(null);
  setTimeout(tick, 1500);
}

/* ------------------------------------------------------------------ */
/* Task start & content-script injection                                */
/* ------------------------------------------------------------------ */

async function startTask(task: ExecutionTask) {
  taskCache = task;
  log('starting application', { id: task.applicationId, company: task.job.company });
  try {
    if (task.resume) files.set('resume', await download(task.resume.downloadUrl));
    if (task.coverLetter?.downloadUrl) files.set('cover', await download(task.coverLetter.downloadUrl));
  } catch (e) {
    await report(task.applicationId, { type: 'failed', data: { code: 'document_download', message: `Could not download your documents: ${(e as Error).message}`, retryable: true } }).catch(() => {});
    return finish();
  }
  const origin = new URL(task.job.url).origin;
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    await report(task.applicationId, {
      type: 'intervention',
      data: { intervention: 'automation_restricted', message: `ApplyFlux does not have permission to access ${new URL(task.job.url).host}. Open the ApplyFlux extension and choose "Allow job sites", then retry.`, pageUrl: task.job.url },
    }).catch(() => {});
    return finish();
  }
  const tab = await chrome.tabs.create({ url: task.job.url, active: false });
  const { profile: _p, answers: _a, ...rest } = task;
  await setActive({ applicationId: task.applicationId, tabId: tab.id!, phase: 'opening', task: rest, submitApproved: false, startedAt: Date.now() });
  await report(task.applicationId, { type: 'progress', data: { step: 'Opening application page', progress: 10, pageUrl: task.job.url } }).catch(() => {});
}

async function fullTask(active: Active): Promise<ExecutionTask | null> {
  if (taskCache?.applicationId === active.applicationId) return taskCache;
  // The service worker restarted mid-application; the server has the authoritative task data.
  return null;
}

async function inject(active: Active, submitApproved = active.submitApproved) {
  const task = await fullTask(active);
  if (!task) {
    // Lost in-memory context (worker restart): hand back to the queue rather than guess.
    await report(active.applicationId, { type: 'failed', data: { code: 'worker_restarted', message: 'The browser extension restarted mid-application', retryable: active.phase !== 'submitting' } }).catch(() => {});
    return finish();
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: active.tabId }, files: ['content.js'] });
  } catch (e) {
    await report(active.applicationId, { type: 'failed', data: { code: 'inject_failed', message: `Could not access the application page: ${(e as Error).message}`, retryable: true } }).catch(() => {});
    return finish();
  }
  const resume = files.get('resume');
  const cover = files.get('cover');
  const ctx: RunContext = {
    applicationId: task.applicationId,
    mode: task.mode,
    allowSubmit: task.allowSubmit || submitApproved,
    submitApproved,
    phase: active.phase,
    profile: task.profile,
    answers: task.answers.map((a) => ({ questionKey: a.questionKey, answer: a.answer, category: a.category })),
    resume: resume && task.resume ? { fileName: task.resume.fileName, mimeType: task.resume.mimeType, base64: resume.base64 } : null,
    coverLetter: task.coverLetter ? { fileName: task.coverLetter.fileName, mimeType: cover?.mimeType ?? 'application/pdf', base64: cover?.base64 ?? null, text: task.coverLetter.text } : null,
    jobUrl: task.job.url,
  };
  await chrome.tabs.sendMessage(active.tabId, { type: 'af:run', ctx }).catch((e) => log('sendMessage failed', { message: (e as Error).message }));
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const active = await getActive();
  if (!active || active.tabId !== tabId || active.phase === 'done') return;
  await inject(active);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await getActive();
  if (active?.tabId === tabId) setTimeout(tick, 100);
});

/* ------------------------------------------------------------------ */
/* Messages                                                             */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  // Only our own content scripts and pages.
  if (sender.id !== chrome.runtime.id) return false;
  if (raw?.type?.startsWith?.('popup:')) {
    handlePopup(raw).then(sendResponse, (e) => sendResponse({ error: (e as Error).message }));
    return true;
  }
  const parsed = ContentToBackground.safeParse(raw);
  if (!parsed.success) {
    sendResponse({ error: 'invalid message' });
    return false;
  }
  handleContent(parsed.data, sender).then(sendResponse, (e) => sendResponse({ error: (e as Error).message, code: (e as ApiError).code }));
  return true;
});

async function handleContent(msg: ContentToBackground, sender: chrome.runtime.MessageSender) {
  if (msg.type === 'af:save_job') return api('/jobs', { body: msg.job });
  const active = await getActive();
  if (msg.type === 'af:ready') return { ok: true };
  if (!active || sender.tab?.id !== active.tabId || msg.applicationId !== active.applicationId) throw new Error('Not the active application tab');

  if (msg.type === 'af:answers') return api('/answers', { body: { applicationId: msg.applicationId, questions: msg.questions }, timeoutMs: 180_000 }); // AI drafting can take a while
  if (msg.type === 'af:phase') {
    active.phase = msg.phase;
    await setActive(active);
    return { ok: true };
  }
  // af:report
  const r = msg.report;
  try {
    const out = await report(active.applicationId, r);
    if (r.type === 'intervention' || r.type === 'ready_for_review') {
      active.phase = r.type === 'ready_for_review' || r.data.intervention === 'review_before_submit' ? 'awaiting_review' : r.data.intervention === 'captcha' ? 'awaiting_verification' : 'done';
      await setActive(active);
      if (r.type === 'intervention' && r.data.intervention === 'captcha') {
        await chrome.tabs.update(active.tabId, { active: true });
        const tab = await chrome.tabs.get(active.tabId);
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        await notifyUser('Verification needed', `${active.task.job.company}: please complete the verification in the open tab.`);
      } else if (r.type === 'ready_for_review') {
        await notifyUser('Ready for your review', `${active.task.job.title} at ${active.task.job.company}`);
      }
      if (active.phase === 'done') await finish();
    }
    if (r.type === 'verification_resolved') {
      active.phase = 'filling';
      await setActive(active);
    }
    if (r.type === 'submit_attempted') {
      active.phase = 'submitting';
      await setActive(active);
    }
    if (r.type === 'submission_result' || r.type === 'failed' || (out.state && ['NEEDS_ATTENTION', 'FAILED', 'SKIPPED', 'QUEUED', 'SUBMITTED', 'SUBMISSION_UNVERIFIED'].includes(out.state))) {
      active.phase = 'done';
      await setActive(active);
      await finish();
    }
    return out;
  } catch (e) {
    if (e instanceof ApiError && ['LEASE_LOST', 'INVALID_TRANSITION'].includes(e.code)) await finish();
    throw e;
  }
}

async function handlePopup(msg: { type: string; code?: string; apiBase?: string }) {
  switch (msg.type) {
    case 'popup:pair':
      await pair(msg.code!, msg.apiBase);
      await tick();
      return { ok: true };
    case 'popup:start':
      await api('/run/start', { method: 'POST' });
      setTimeout(tick, 100);
      return { ok: true };
    case 'popup:pause':
      return api('/run/pause', { method: 'POST' });
    case 'popup:stop': {
      const out = await api('/run/stop', { method: 'POST' });
      const active = await getActive();
      if (active) {
        await chrome.tabs.sendMessage(active.tabId, { type: 'af:stop' }).catch(() => {});
        await finish();
      }
      return out;
    }
    case 'popup:disconnect':
      await api('/disconnect', { method: 'POST' }).catch(() => {});
      await chrome.storage.local.remove(['token', 'connectionId', 'active']);
      return { ok: true };
    case 'popup:focus': {
      const active = await getActive();
      if (active) await chrome.tabs.update(active.tabId, { active: true });
      return { ok: true };
    }
    case 'popup:tick':
      await tick();
      return { ok: true };
    default:
      throw new Error('Unknown popup action');
  }
}

/** The ApplyFlux web app can hand over a pairing code directly (origins limited by externally_connectable). */
chrome.runtime.onMessageExternal.addListener((raw, sender, sendResponse) => {
  const allowed = [DEFAULTS.webBase, DEFAULTS.apiBase].map((u) => new URL(u).origin);
  if (!sender.origin || !allowed.includes(sender.origin)) return false;
  const parsed = ExternalMessage.safeParse(raw);
  if (!parsed.success) return false;
  if (parsed.data.type === 'af:ping') {
    getStored().then((s) => sendResponse({ ok: true, connected: !!s.token, version: chrome.runtime.getManifest().version }));
    return true;
  }
  pair(parsed.data.code, parsed.data.apiBase && new URL(parsed.data.apiBase).origin === new URL(DEFAULTS.apiBase).origin ? parsed.data.apiBase : undefined)
    .then(() => {
      sendResponse({ ok: true });
      tick();
    })
    .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
  return true;
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

chrome.alarms.create('af-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'af-tick') tick();
});
chrome.runtime.onStartup.addListener(async () => {
  // Browser restarted: an application we were holding cannot be resumed safely from memory.
  const active = await getActive();
  if (active) {
    await report(active.applicationId, { type: 'failed', data: { code: 'browser_restarted', message: 'The browser restarted during this application', retryable: active.phase !== 'submitting' } }).catch(() => {});
    await setActive(null);
  }
  tick();
});
chrome.runtime.onInstalled.addListener(() => tick());
// Fast loop while working; alarms keep the worker alive-ish otherwise.
setInterval(tick, 5000);
tick();
