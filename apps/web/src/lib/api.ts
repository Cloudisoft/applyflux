import { supabase } from './supabase';

const BASE = ((import.meta.env.VITE_API_URL as string | undefined) || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function token() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; raw?: boolean } = {}): Promise<T> {
  const t = await token();
  const headers: Record<string, string> = {};
  if (t) headers.authorization = `Bearer ${t}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api${path}`, {
    method: init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET'),
    headers,
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  if (init.raw && res.ok) return res as unknown as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error ?? {};
    if (res.status === 401 && t) await supabase.auth.refreshSession().catch(() => {});
    throw new ApiError(res.status, e.code ?? 'HTTP_' + res.status, e.message ?? `Request failed (${res.status})`, e.details);
  }
  return (json?.data ?? json) as T;
}

export const api = {
  get: <T>(p: string) => apiFetch<T>(p),
  post: <T>(p: string, body: unknown = {}) => apiFetch<T>(p, { method: 'POST', body }),
  put: <T>(p: string, body: unknown) => apiFetch<T>(p, { method: 'PUT', body }),
  patch: <T>(p: string, body: unknown) => apiFetch<T>(p, { method: 'PATCH', body }),
  del: <T>(p: string, body?: unknown) => apiFetch<T>(p, { method: 'DELETE', body }),
  upload: <T>(p: string, form: FormData) => apiFetch<T>(p, { form }),
};

/** Fetch an authenticated file and return an object URL (for previews and downloads). */
export async function fileUrl(path: string): Promise<string> {
  const res = await apiFetch<Response>(path, { raw: true });
  return URL.createObjectURL(await res.blob());
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
