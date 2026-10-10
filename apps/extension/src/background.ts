/// <reference types="chrome" />
/**
 * ApplyFlux Agent service worker. Fills one application at a time per browser, but an application
 * that is waiting on the person (a verification check, a review, a sign-in) is parked in its own tab
 * so the next one can start; the server enforces the user's concurrency limit across browsers.
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
  /** When the person was last alerted that this application needs them. */
  alertedAt?: number;
  reminded?: boolean;
}

/** Waiting on the person: does not block the next application. */
const PARKED: Phase[] = ['awaiting_verification', 'awaiting_review', 'awaiting_auth'];
const MAX_PARKED = 5;
const REMIND_AFTER_MS = 2 * 60_000;

let ticking = false;

/* ------------------------------------------------------------------ */
/* State (chrome.storage survives service-worker restarts)              */
/* ------------------------------------------------------------------ */

type Actives = Record<string, Active>;
const getActives = async () => ((await chrome.storage.local.get('actives')).actives as Actives | undefined) ?? {};
const saveActives = (a: Actives) => chrome.storage.local.set({ actives: a });
async function putActive(a: Active) {
  const all = await getActives();
  all[a.applicationId] = a;
  await saveActives(all);
}
async function activeByTab(tabId: number) {
  return Object.values(await getActives()).find((a) => a.tabId === tabId) ?? null;
}
const setStatus = (status: Record<string, unknown>) => chrome.storage.session.set({ status: { ...status, at: Date.now() } });

/** Full task (profile, answers) and documents, kept in session storage: memory-only, cleared when the browser closes. */
const taskKey = (id: string) => `task:${id}`;
const fileKey = (id: string, k: 'resume' | 'cover') => `file:${id}:${k}`;
async function getTask(id: string) {
  return ((await chrome.storage.session.get(taskKey(id)))[taskKey(id)] as ExecutionTask | undefined) ?? null;
}
async function getFile(id: string, k: 'resume' | 'cover') {
  return ((await chrome.storage.session.get(fileKey(id, k)))[fileKey(id, k)] as { base64: string; mimeType: string } | undefined) ?? null;
}

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.info('[ApplyFlux]', msg, extra);
}

async function report(applicationId: string, body: unknown) {
  return api<{ ok: boolean; state?: string }>(`/applications/${applicationId}/report`, { body });
}

/* ------------------------------------------------------------------ */
/* Alerts: notification, sound and icon badge                           */
/* ------------------------------------------------------------------ */

async function updateBadge() {
  const waiting = Object.values(await getActives()).filter((a) => PARKED.includes(a.phase)).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#e11d48' });
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : '' });
  await chrome.action.setTitle({ title: waiting ? `ApplyFlux: ${waiting} application${waiting === 1 ? '' : 's'} need you` : 'ApplyFlux Agent' });
}

/** A short two-tone chime, played from an offscreen document (service workers cannot play audio). */
async function chime() {
  try {
    const has = await chrome.offscreen.hasDocument();
    if (!has) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK], justification: 'Alert sound when an application needs the person' });
    await chrome.runtime.sendMessage({ type: 'offscreen:chime' });
  } catch (e) {
    log('chime failed', { message: (e as Error).message });
  }
}

async function alertUser(a: Active, kind: 'verification' | 'review' | 'auth', reminder = false) {
  const job = `${a.task.job.title} at ${a.task.job.company}`;
  const text = {
    verification: { title: reminder ? 'Still waiting: quick verification' : 'Quick verification needed', message: `${job}: tick the check in the highlighted spot. ApplyFlux continues by itself.` },
    review: { title: 'Ready for your review', message: `${job} is filled in. Check it and submit.` },
    auth: { title: 'Sign-in needed', message: `${job}: sign in to the site, then ApplyFlux can continue.` },
  }[kind];
  chrome.notifications.create(`af:${a.applicationId}`, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: text.title,
    message: text.message,
    priority: 2,
    requireInteraction: kind !== 'review',
    buttons: [{ title: 'Open the tab' }],
  });
  if (kind !== 'review') await chime();
  a.alertedAt = Date.now();
  a.reminded = reminder || a.reminded;
  await putActive(a);
  await updateBadge();
}

async function focusApplication(a: Active) {
  const tab = await chrome.tabs.update(a.tabId, { active: true }).catch(() => null);
  if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }).catch(() => {});
}

/** The application most in need of the person: verification first, then sign-in, then review. */
async function mostUrgent() {
  const all = Object.values(await getActives());
  for (const p of ['awaiting_verification', 'awaiting_auth', 'awaiting_review'] as Phase[]) {
    const a = all.filter((x) => x.phase === p).sort((x, y) => (x.alertedAt ?? 0) - (y.alertedAt ?? 0))[0];
    if (a) return a;
  }
  return all[0] ?? null;
}

const openFromNotification = async (id: string) => {
  if (!id.startsWith('af:')) return;
  const a = (await getActives())[id.slice(3)];
  if (a) await focusApplication(a);
  chrome.notifications.clear(id);
};
chrome.notifications.onClicked.addListener(openFromNotification);
chrome.notifications.onButtonClicked.addListener(openFromNotification);

/* ------------------------------------------------------------------ */
/* Main loop                                                            */
/* ------------------------------------------------------------------ */

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const { token } = await getStored();
    if (!token) return void (await setStatus({ state: 'disconnected' }));
    const actives = Object.values(await getActives());
    for (const a of actives) await superviseActive(a);
    const current = Object.values(await getActives());
    const working = current.find((a) => !PARKED.includes(a.phase));
    const parked = current.filter((a) => PARKED.includes(a.phase));
    await updateBadge();
    if (working) {
      return void (await setStatus({ state: 'working', applicationId: working.applicationId, phase: working.phase, job: { title: working.task.job.title, company: working.task.job.company }, waiting: parked.length }));
    }
    const session = await api<{ run: { status: string; mode: string } | null; counts: { queued: number; attention: number } }>('/session');
    await setStatus({ state: session.run?.status ?? 'idle', counts: session.counts, mode: session.run?.mode, waiting: parked.length });
    if (session.run?.status !== 'running' || parked.length >= MAX_PARKED) return;
    const next = await api<ExecutionTask | { idle: true; reason: string }>('/next', { method: 'POST' });
    if ('idle' in next) return void (await setStatus({ state: 'running', idleReason: next.reason, counts: session.counts, waiting: parked.length }));
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
    await finish(active.applicationId);
    return;
  }
  try {
    const hb = await api<{ signal: 'continue' | 'pause' | 'stop'; state: string; submitApproved?: boolean }>(`/applications/${active.applicationId}/heartbeat`, { method: 'POST' });
    if (hb.signal === 'stop') {
      await chrome.tabs.sendMessage(active.tabId, { type: 'af:stop' }).catch(() => {});
      await finish(active.applicationId);
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
      await putActive(active);
      await inject(active, true);
    }
    // One reminder if a verification has been waiting a while.
    if (active.phase === 'awaiting_verification' && !active.reminded && active.alertedAt && Date.now() - active.alertedAt > REMIND_AFTER_MS) await alertUser(active, 'verification', true);
  } catch (e) {
    if (e instanceof ApiError && ['LEASE_LOST', 'NOT_FOUND', 'EXTENSION_REVOKED', 'UNAUTHENTICATED'].includes(e.code)) await finish(active.applicationId);
  }
}

async function finish(applicationId: string) {
  const all = await getActives();
  delete all[applicationId];
  await saveActives(all);
  await chrome.storage.session.remove([taskKey(applicationId), fileKey(applicationId, 'resume'), fileKey(applicationId, 'cover')]);
  chrome.notifications.clear(`af:${applicationId}`);
  await updateBadge();
  setTimeout(tick, 1500);
}

/* ------------------------------------------------------------------ */
/* Task start & content-script injection                                */
/* ------------------------------------------------------------------ */

async function startTask(task: ExecutionTask) {
  log('starting application', { id: task.applicationId, company: task.job.company });
  try {
    const store: Record<string, unknown> = { [taskKey(task.applicationId)]: task };
    if (task.resume) store[fileKey(task.applicationId, 'resume')] = await download(task.resume.downloadUrl);
    if (task.coverLetter?.downloadUrl) store[fileKey(task.applicationId, 'cover')] = await download(task.coverLetter.downloadUrl);
    await chrome.storage.session.set(store);
  } catch (e) {
    await report(task.applicationId, { type: 'failed', data: { code: 'document_download', message: `Could not download your documents: ${(e as Error).message}`, retryable: true } }).catch(() => {});
    return finish(task.applicationId);
  }
  const origin = new URL(task.job.url).origin;
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    await report(task.applicationId, {
      type: 'intervention',
      data: { intervention: 'automation_restricted', message: `ApplyFlux does not have permission to access ${new URL(task.job.url).host}. Open the ApplyFlux extension and choose "Allow job sites", then retry.`, pageUrl: task.job.url },
    }).catch(() => {});
    return finish(task.applicationId);
  }
  const tab = await chrome.tabs.create({ url: task.job.url, active: false });
  const { profile: _p, answers: _a, ...rest } = task;
  await putActive({ applicationId: task.applicationId, tabId: tab.id!, phase: 'opening', task: rest, submitApproved: false, startedAt: Date.now() });
  await report(task.applicationId, { type: 'progress', data: { step: 'Opening application page', progress: 10, pageUrl: task.job.url } }).catch(() => {});
}

async function inject(active: Active, submitApproved = active.submitApproved) {
  const task = await getTask(active.applicationId);
  if (!task) {
    // The browser session was lost mid-application: hand it back to the queue rather than guess.
    await report(active.applicationId, { type: 'failed', data: { code: 'worker_restarted', message: 'The browser extension restarted mid-application', retryable: active.phase !== 'submitting' } }).catch(() => {});
    return finish(active.applicationId);
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: active.tabId }, files: ['content.js'] });
  } catch (e) {
    await report(active.applicationId, { type: 'failed', data: { code: 'inject_failed', message: `Could not access the application page: ${(e as Error).message}`, retryable: true } }).catch(() => {});
    return finish(active.applicationId);
  }
  const resume = await getFile(active.applicationId, 'resume');
  const cover = await getFile(active.applicationId, 'cover');
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
  const active = await activeByTab(tabId);
  if (!active || active.phase === 'done') return;
  await inject(active);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (await activeByTab(tabId)) setTimeout(tick, 100);
});

/* ------------------------------------------------------------------ */
/* Messages                                                             */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  // Only our own content scripts and pages.
  if (sender.id !== chrome.runtime.id) return false;
  if (raw?.type?.startsWith?.('offscreen:')) return false;
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
  if (msg.type === 'af:ready') return { ok: true };
  const active = (await getActives())[msg.applicationId];
  if (!active || sender.tab?.id !== active.tabId) throw new Error('Not an active application tab');

  if (msg.type === 'af:answers') return api('/answers', { body: { applicationId: msg.applicationId, questions: msg.questions }, timeoutMs: 180_000 }); // AI drafting can take a while
  if (msg.type === 'af:phase') {
    active.phase = msg.phase;
    await putActive(active);
    if (!PARKED.includes(msg.phase)) {
      chrome.notifications.clear(`af:${active.applicationId}`);
      await updateBadge();
    }
    return { ok: true };
  }
  // af:report
  const r = msg.report;
  try {
    const out = await report(active.applicationId, r);
    if (r.type === 'intervention' || r.type === 'ready_for_review') {
      const kind = r.type === 'ready_for_review' || r.data.intervention === 'review_before_submit' ? 'review' : r.data.intervention === 'captcha' ? 'verification' : ['login_required', 'mfa', 'session_expired'].includes(r.data.intervention) ? 'auth' : null;
      active.phase = kind === 'review' ? 'awaiting_review' : kind === 'verification' ? 'awaiting_verification' : 'done';
      await putActive(active);
      if (kind === 'verification') {
        // Bring the tab forward in its window (without stealing focus from another app) and alert the person.
        await chrome.tabs.update(active.tabId, { active: true }).catch(() => {});
        await alertUser(active, 'verification');
      } else if (kind === 'review') {
        await alertUser(active, 'review');
      } else if (kind === 'auth') {
        await alertUser(active, 'auth');
      }
      if (active.phase === 'done') await finish(active.applicationId);
      else setTimeout(tick, 500); // parked: start the next application meanwhile
    }
    if (r.type === 'verification_resolved') {
      active.phase = 'filling';
      await putActive(active);
      chrome.notifications.clear(`af:${active.applicationId}`);
      await updateBadge();
    }
    if (r.type === 'submit_attempted') {
      active.phase = 'submitting';
      await putActive(active);
    }
    if (r.type === 'submission_result' || r.type === 'failed' || (out.state && ['NEEDS_ATTENTION', 'FAILED', 'SKIPPED', 'QUEUED', 'SUBMITTED', 'SUBMISSION_UNVERIFIED'].includes(out.state))) {
      await finish(active.applicationId);
    }
    return out;
  } catch (e) {
    if (e instanceof ApiError && ['LEASE_LOST', 'INVALID_TRANSITION'].includes(e.code)) await finish(active.applicationId);
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
      for (const a of Object.values(await getActives())) {
        await chrome.tabs.sendMessage(a.tabId, { type: 'af:stop' }).catch(() => {});
        await finish(a.applicationId);
      }
      return out;
    }
    case 'popup:disconnect':
      await api('/disconnect', { method: 'POST' }).catch(() => {});
      await chrome.storage.local.remove(['token', 'connectionId', 'actives']);
      await updateBadge();
      return { ok: true };
    case 'popup:focus': {
      const a = await mostUrgent();
      if (a) await focusApplication(a);
      return { ok: true };
    }
    case 'popup:tick':
      await tick();
      return { ok: true };
    default:
      throw new Error('Unknown popup action');
  }
}

/** The ApplyFlux web app can hand over a pairing code, and bring a waiting application's tab to the front. */
chrome.runtime.onMessageExternal.addListener((raw, sender, sendResponse) => {
  const allowed = [DEFAULTS.webBase, DEFAULTS.apiBase].map((u) => new URL(u).origin);
  if (!sender.origin || !allowed.includes(sender.origin)) return false;
  const parsed = ExternalMessage.safeParse(raw);
  if (!parsed.success) return false;
  if (parsed.data.type === 'af:ping') {
    getStored().then((s) => sendResponse({ ok: true, connected: !!s.token, version: chrome.runtime.getManifest().version }));
    return true;
  }
  if (parsed.data.type === 'af:focus') {
    const id = parsed.data.applicationId;
    (async () => {
      const a = id ? (await getActives())[id] : await mostUrgent();
      if (a) await focusApplication(a);
      sendResponse({ ok: !!a });
    })();
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
  // Browser restarted: applications we were holding cannot be resumed safely (session data is gone).
  for (const a of Object.values(await getActives())) {
    await report(a.applicationId, { type: 'failed', data: { code: 'browser_restarted', message: 'The browser restarted during this application', retryable: a.phase !== 'submitting' } }).catch(() => {});
  }
  await saveActives({});
  await updateBadge();
  tick();
});
chrome.runtime.onInstalled.addListener(async () => {
  // Upgrading from the single-application version.
  await chrome.storage.local.remove('active');
  tick();
});
// Fast loop while working; alarms keep the worker alive-ish otherwise.
setInterval(tick, 5000);
tick();
