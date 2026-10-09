/// <reference types="chrome" />
import { DEFAULTS, getStored } from './api';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const call = (type: string, extra: Record<string, unknown> = {}) =>
  new Promise<{ error?: string }>((resolve) => chrome.runtime.sendMessage({ type, ...extra }, (r) => resolve(r ?? {})));

const LABEL: Record<string, string> = {
  disconnected: 'Not connected',
  idle: 'Automation is off',
  running: 'Running — waiting for the next application',
  paused: 'Paused',
  working: 'Working on an application',
  error: 'Connection problem',
};
const PHASE: Record<string, string> = {
  opening: 'Opening the application…',
  filling: 'Filling the form…',
  awaiting_verification: 'Waiting for you to complete verification',
  awaiting_auth: 'Waiting for you to sign in',
  awaiting_review: 'Ready for your review',
  submitting: 'Submitting…',
  done: 'Finishing up…',
};

async function render() {
  const { token } = await getStored();
  $('pair').hidden = !!token;
  $('main').hidden = !token;
  $('open-app').setAttribute('href', DEFAULTS.webBase);
  const { status } = (await chrome.storage.session.get('status')) as { status?: Record<string, any> };
  const s = status?.state ?? (token ? 'idle' : 'disconnected');
  $('badge').textContent = token ? 'Connected' : 'Offline';
  $('badge').classList.toggle('on', !!token);
  $('status-text').textContent = s === 'working' ? PHASE[status?.phase] ?? LABEL.working : (LABEL[s] ?? s) + (status?.idleReason ? ` (${status.idleReason})` : '');
  $('job').textContent = status?.job ? `${status.job.title} · ${status.job.company}` : status?.counts ? `${status.counts.queued} queued · ${status.counts.attention} need attention` : '';
  $('focus').hidden = s !== 'working';
  ($('start') as HTMLButtonElement).disabled = s === 'running' || s === 'working';
  ($('pause') as HTMLButtonElement).disabled = !(s === 'running' || s === 'working');
  $('error').textContent = s === 'error' ? status?.error ?? '' : '';
  const sites = await chrome.permissions.contains({ origins: ['https://*/*'] });
  $('grant-sites').textContent = sites ? 'Job site access granted' : 'Allow job sites';
  ($('grant-sites') as HTMLButtonElement).disabled = sites;
  const notes = await chrome.permissions.contains({ permissions: ['notifications'] });
  ($('grant-notify') as HTMLButtonElement).disabled = notes;
  $('grant-notify').textContent = notes ? 'Notifications enabled' : 'Enable notifications';
}

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-error').textContent = '';
  const r = await call('popup:pair', { code: ($('code') as HTMLInputElement).value.trim() });
  if (r.error) $('pair-error').textContent = r.error;
  render();
});
for (const [id, type] of [['start', 'popup:start'], ['pause', 'popup:pause'], ['stop', 'popup:stop'], ['focus', 'popup:focus']] as const) {
  $(id).addEventListener('click', async () => {
    const r = await call(type);
    $('error').textContent = r.error ?? '';
    await call('popup:tick');
    render();
  });
}
$('disconnect').addEventListener('click', async (e) => {
  e.preventDefault();
  await call('popup:disconnect');
  render();
});
// Optional permissions are requested only when the person asks, from a user gesture.
$('grant-sites').addEventListener('click', async () => {
  await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
  render();
});
$('grant-notify').addEventListener('click', async () => {
  await chrome.permissions.request({ permissions: ['notifications'] });
  render();
});
chrome.storage.onChanged.addListener(render);
render();
