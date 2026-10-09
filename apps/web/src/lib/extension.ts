/** Talk to the ApplyFlux Agent extension via externally_connectable (only the pairing handshake is allowed). */
const EXT_ID = (import.meta.env.VITE_EXTENSION_ID as string | undefined) || '';
export const EXTENSION_STORE_URL = (import.meta.env.VITE_EXTENSION_STORE_URL as string | undefined) || '';

type ChromeRuntime = { sendMessage: (id: string, msg: unknown, cb: (r: unknown) => void) => void; lastError?: { message: string } };
const runtime = (): ChromeRuntime | null => (globalThis as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime ?? null;

function send<T>(msg: unknown): Promise<T | null> {
  const rt = runtime();
  if (!EXT_ID || !rt?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      rt.sendMessage(EXT_ID, msg, (r) => resolve(rt.lastError ? null : ((r as T) ?? null)));
    } catch {
      resolve(null);
    }
  });
}

export const extensionConfigured = !!EXT_ID;

export async function pingExtension() {
  return send<{ ok: boolean; connected: boolean; version: string }>({ type: 'af:ping' });
}

export async function pairExtension(code: string) {
  return send<{ ok: boolean; error?: string }>({ type: 'af:pair', code });
}
