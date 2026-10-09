import { fileURLToPath as __f } from 'node:url';
import { dirname as __d } from 'node:path';
const __here = __d(__f(import.meta.url));
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export default async function globalTeardown() {
  try {
    const pid = Number(readFileSync(resolve(__here, '.server.pid'), 'utf8'));
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  rmSync(resolve(__here, '.server.pid'), { force: true });
}
