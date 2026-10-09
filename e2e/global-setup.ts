import { fileURLToPath as __f } from 'node:url';
import { dirname as __d } from 'node:path';
const __here = __d(__f(import.meta.url));
import { execSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { freshDatabase } from '../apps/server/test/helpers';

export const E2E = {
  port: 3999,
  api: 'http://127.0.0.1:3999',
  jwtSecret: 'e2e-jwt-secret-at-least-32-characters-long!!',
  db: 'applyflux_e2e',
};

export default async function globalSetup() {
  const root = resolve(__here, '..');
  const dbUrl = await freshDatabase(E2E.db);
  execSync('node build.mjs', {
    cwd: resolve(root, 'apps/extension'),
    env: { ...process.env, APPLYFLUX_API_URL: E2E.api, APPLYFLUX_WEB_URL: 'http://127.0.0.1:5173' },
    stdio: 'inherit',
  });
  // Web app served by the API (single origin), as on Replit. Supabase URL is a placeholder: tests inject a session.
  execSync('npx vite build', {
    cwd: resolve(root, 'apps/web'),
    env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_ANON_KEY: 'e2e-anon', VITE_API_URL: '' },
    stdio: 'ignore',
  });
  const server = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: resolve(root, 'apps/server'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(E2E.port),
      PUBLIC_API_URL: E2E.api,
      DATABASE_URL: dbUrl,
      SUPABASE_JWT_SECRET: E2E.jwtSecret,
      STORAGE_DRIVER: 'memory',
      DOWNLOAD_SIGNING_SECRET: 'e2e-download-signing-secret-0123456789abcdef',
      AUTO_SUBMIT_PLATFORMS: 'sandbox',
      AI_PROVIDER: 'none',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  writeFileSync(resolve(__here, '.server.pid'), String(server.pid));
  writeFileSync(resolve(__here, '.db-url'), dbUrl);
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${E2E.api}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API did not start');
}
