/// <reference types="chrome" />
/**
 * "Save to ApplyFlux" on job boards (LinkedIn, Indeed, Monster, MyGreenhouse) and any page with job
 * posting markup. A small button; the page is read only when the person clicks it. Saved jobs are
 * matched to the employer's own application form and queued for Auto Apply by the server.
 */
import { extractJobs, type ClippedJob } from './extract';

declare global {
  interface Window {
    __applyfluxClip?: boolean;
  }
}

if (!window.__applyfluxClip && window.top === window) {
  window.__applyfluxClip = true;
  mount();
}

function mount() {
  const host = document.createElement('div');
  host.setAttribute('data-applyflux-clip', '');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; z-index: 2147483646; right: 18px; bottom: 18px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
        font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; }
      button { cursor: pointer; border: 0; border-radius: 999px; padding: 10px 16px; font: inherit; font-weight: 600; color: #fff;
        background: linear-gradient(135deg, #6d5efc, #8b5cf6 60%, #22d3ee 140%); box-shadow: 0 8px 24px rgba(76, 61, 220, .35); }
      button.secondary { background: #fff; color: #312e81; box-shadow: 0 4px 16px rgba(0,0,0,.15); }
      button[disabled] { opacity: .6; cursor: default; }
      .panel { background: #fff; color: #1f2937; border-radius: 14px; padding: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.2); max-width: 300px; display: flex; flex-direction: column; gap: 8px; }
      .panel b { color: #111827; }
      .muted { color: #6b7280; font-size: 12px; }
      a { color: #4f46e5; font-weight: 600; text-decoration: none; }
      .x { align-self: flex-end; background: none; color: #6b7280; box-shadow: none; padding: 0 4px; font-weight: 400; }
    </style>
    <div class="wrap"><div class="panel" hidden></div><button class="main" type="button">Save to ApplyFlux</button></div>`;
  const panel = root.querySelector<HTMLDivElement>('.panel')!;
  const main = root.querySelector<HTMLButtonElement>('.main')!;

  const show = (html: string) => {
    panel.innerHTML = `<button class="x" type="button" aria-label="Close">✕</button>${html}`;
    panel.hidden = false;
    panel.querySelector('.x')!.addEventListener('click', () => (panel.hidden = true));
  };

  async function save(jobs: ClippedJob[]) {
    main.disabled = true;
    main.textContent = `Saving ${jobs.length} job${jobs.length === 1 ? '' : 's'}…`;
    panel.hidden = true;
    const res = await new Promise<{ error?: string; queued?: number; saved?: number; needsYou?: number; results?: Array<{ title: string; status: string }> }>((resolve) =>
      chrome.runtime.sendMessage({ type: 'af:save_jobs', jobs }, (r) => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r ?? { error: 'No response' })),
    );
    main.disabled = false;
    main.textContent = 'Save to ApplyFlux';
    if (res.error) {
      show(`<b>Couldn't save</b><span class="muted">${escape(res.error)}${/connect/i.test(res.error) ? '<br>Open the ApplyFlux extension and connect your account.' : ''}</span>`);
      return;
    }
    const manual = (res.results ?? []).filter((r) => r.status === 'needs_you').map((r) => `• ${escape(r.title)}`).slice(0, 5).join('<br>');
    show(
      `<b>${res.queued ? `${res.queued} queued for Auto Apply` : 'Saved'}</b>` +
        (res.saved ? `<span class="muted">${res.saved} saved (already applied, queued or excluded)</span>` : '') +
        (res.needsYou ? `<span class="muted">${res.needsYou} couldn't be matched to the employer's own site, so apply to these yourself:<br>${manual}</span>` : '') +
        `<span class="muted">ApplyFlux applies on the employer's site, never through this job board.</span>`,
    );
  }

  main.addEventListener('click', () => {
    const { detail, list } = extractJobs(document, location.href);
    if (!detail && !list.length) {
      show(`<b>No job found on this page</b><span class="muted">Open a job posting or a search results page, then try again.</span>`);
      return;
    }
    if (detail && list.length <= 1) return void save([detail]);
    if (!detail) return void save(list);
    show(`<b>Save which jobs?</b>`);
    const one = document.createElement('button');
    one.type = 'button';
    one.className = 'secondary';
    one.textContent = `This job: ${detail.title.slice(0, 40)}`;
    one.addEventListener('click', () => save([detail]));
    const all = document.createElement('button');
    all.type = 'button';
    all.textContent = `All ${list.length} jobs on this page`;
    all.addEventListener('click', () => save(list));
    panel.append(one, all);
  });

  document.documentElement.appendChild(host);
}

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
