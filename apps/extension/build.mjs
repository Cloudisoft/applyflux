// Builds the MV3 extension into dist/. Configure with env vars:
//   APPLYFLUX_API_URL  (default http://localhost:3001)
//   APPLYFLUX_WEB_URL  (default http://localhost:5173)
//   APPLYFLUX_E2E=1    grants host access to the API origin's sandbox only at install time (automated tests)
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const api = process.env.APPLYFLUX_API_URL ?? 'http://localhost:3001';
const web = process.env.APPLYFLUX_WEB_URL ?? 'http://localhost:5173';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const origin = (u) => new URL(u).origin;
const match = (u) => `${origin(u)}/*`;

mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });

const manifest = {
  manifest_version: 3,
  name: 'ApplyFlux Agent',
  short_name: 'ApplyFlux',
  description: 'Fills and tracks the job applications you queue in ApplyFlux. Pauses for CAPTCHAs, sign-ins and anything uncertain.',
  version: pkg.version,
  icons: { 16: 'icons/icon-16.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: { default_popup: 'popup.html', default_title: 'ApplyFlux Agent' },
  background: { service_worker: 'background.js', type: 'module' },
  // Minimum permissions. Site access and notifications are optional and requested from the popup.
  permissions: ['storage', 'alarms', 'scripting'],
  // The API origin hosts the ApplyFlux Sandbox used for the onboarding test run.
  host_permissions: [match(api)],
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  optional_permissions: ['notifications'],
  externally_connectable: { matches: [...new Set([match(web), match(api)])] },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  minimum_chrome_version: '116',
};
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));

const opts = {
  entryPoints: { background: 'src/background.ts', content: 'src/content.ts', popup: 'src/popup.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  minify: process.env.NODE_ENV === 'production',
  sourcemap: process.env.NODE_ENV === 'production' ? false : 'inline',
  define: { __API_BASE__: JSON.stringify(api), __WEB_BASE__: JSON.stringify(web) },
  logLevel: 'info',
};
// Content scripts injected with executeScript are classic scripts: build that one as an IIFE.
const content = { ...opts, entryPoints: { content: 'src/content.ts' }, format: 'iife' };
const rest = { ...opts, entryPoints: { background: 'src/background.ts', popup: 'src/popup.ts' } };

if (process.argv.includes('--watch')) {
  for (const o of [content, rest]) await (await context(o)).watch();
} else {
  await build(content);
  await build(rest);
  console.log(`ApplyFlux Agent ${pkg.version} built for API ${api}`);
}
