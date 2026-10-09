/// <reference types="chrome" />
declare const __API_BASE__: string;
declare const __WEB_BASE__: string;

export const DEFAULTS = { apiBase: __API_BASE__, webBase: __WEB_BASE__ };

export interface Stored {
  apiBase: string;
  token: string | null;
  connectionId: string | null;
}

export async function getStored(): Promise<Stored> {
  const s = await chrome.storage.local.get(['apiBase', 'token', 'connectionId']);
  return { apiBase: (s.apiBase as string) || DEFAULTS.apiBase, token: (s.token as string) ?? null, connectionId: (s.connectionId as string) ?? null };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Authenticated call to the ApplyFlux extension API. The token never leaves chrome.storage.local and this module. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { apiBase, token } = await getStored();
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Extension not connected');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/ext${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { authorization: `Ext ${token}`, 'content-type': 'application/json' },
      body: init.body ? JSON.stringify(init.body) : init.method === 'POST' ? '{}' : undefined,
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string } };
    if (!res.ok) {
      const code = json.error?.code ?? 'HTTP_' + res.status;
      if (code === 'EXTENSION_REVOKED' || res.status === 401) await chrome.storage.local.remove(['token', 'connectionId']);
      throw new ApiError(res.status, code, json.error?.message ?? `Request failed (${res.status})`);
    }
    return json.data as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function pair(code: string, apiBase?: string): Promise<void> {
  const base = (apiBase || (await getStored()).apiBase).replace(/\/$/, '');
  const res = await fetch(`${base}/api/ext/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.toUpperCase(), name: 'Chrome', version: chrome.runtime.getManifest().version }),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: { token: string; connectionId: string }; error?: { message: string } };
  if (!res.ok || !json.data) throw new Error(json.error?.message ?? 'Pairing failed');
  await chrome.storage.local.set({ apiBase: base, token: json.data.token, connectionId: json.data.connectionId });
}

export async function download(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { base64: btoa(bin), mimeType: res.headers.get('content-type') ?? 'application/octet-stream' };
}
