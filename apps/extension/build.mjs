// Builds the MV3 extension into dist/. Configure with env vars:
//   APPLYFLUX_API_URL  (default https://$RAILWAY_PUBLIC_DOMAIN on Railway, else http://localhost:3001)
//   APPLYFLUX_WEB_URL  (default https://$RAILWAY_PUBLIC_DOMAIN on Railway, else http://localhost:5173)
//   APPLYFLUX_EXTENSION_KEY  base64 public key pinned as manifest "key" so the extension ID is stable
//                            (the web app talks to it by ID: VITE_EXTENSION_ID)
// A production build also writes release/applyflux-agent.zip, which the server offers as a download.
//   APPLYFLUX_E2E=1    grants host access to the API origin's sandbox only at install time (automated tests)
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const railway = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined;
const api = process.env.APPLYFLUX_API_URL || railway || 'http://localhost:3001';
const web = process.env.APPLYFLUX_WEB_URL || railway || 'http://localhost:5173';
const key = process.env.APPLYFLUX_EXTENSION_KEY?.trim();
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
  // notifications + offscreen (alert sound) are on by default so nobody has to find a setting to be told when they're needed.
  permissions: ['storage', 'alarms', 'scripting', 'notifications', 'offscreen'],
  // The API origin hosts the ApplyFlux Sandbox used for the onboarding test run.
  host_permissions: [match(api)],
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  externally_connectable: { matches: [...new Set([match(web), match(api)])] },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  minimum_chrome_version: '116',
  ...(key ? { key } : {}),
};
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));

const opts = {
  entryPoints: { background: 'src/background.ts', content: 'src/content.ts', popup: 'src/popup.ts', offscreen: 'src/offscreen.ts' },
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
const rest = { ...opts, entryPoints: { background: 'src/background.ts', popup: 'src/popup.ts', offscreen: 'src/offscreen.ts' } };

if (process.argv.includes('--watch')) {
  for (const o of [content, rest]) await (await context(o)).watch();
} else {
  await build(content);
  await build(rest);
  writeZip('dist', 'release/applyflux-agent.zip');
  console.log(`ApplyFlux Agent ${pkg.version} built for API ${api}${key ? '' : ' (no APPLYFLUX_EXTENSION_KEY: extension ID will vary per install)'}`);
}

/** Minimal zip writer (deflate), so packaging needs no system zip tool. */
function writeZip(dir, out) {
  const files = [];
  const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
  walk(dir);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files.sort()) {
    const name = Buffer.from(relative(dir, f).split('\\').join('/'));
    const data = readFileSync(f);
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(comp.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(head, name, comp);
    centrals.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  mkdirSync('release', { recursive: true });
  writeFileSync(out, Buffer.concat([...locals, cd, end]));
}
