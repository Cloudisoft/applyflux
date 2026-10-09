import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiClient } from './ai/provider';
import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db';
import { createJwtVerifier } from './lib/auth';
import { createStorage, supabaseAdmin } from './lib/storage';
import { makeFetchJson } from './services/discovery';
import { sweepExpiredLeases } from './services/queue';

const config = loadConfig();
const db = createPool(config);
const ctx = {
  config,
  db,
  storage: createStorage(config),
  ai: createAiClient(config),
  verifyJwt: createJwtVerifier(config),
  fetchJson: makeFetchJson(),
  supabaseAdmin: supabaseAdmin(config),
};

const here = dirname(fileURLToPath(import.meta.url));
const webDist = process.env.WEB_DIST ?? resolve(here, '../../web/dist');
const extensionZip = process.env.EXTENSION_ZIP ?? resolve(here, '../../extension/release/applyflux-agent.zip');
const app = createApp(ctx, { webDist, extensionZip });

const server = app.listen(config.PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'ApplyFlux API listening', port: config.PORT, ai: ctx.ai.configured, sandbox: config.ENABLE_SANDBOX }));
});

// Recovery loop: reclaim applications whose browser stopped reporting.
// Passes never overlap: if one is slow (e.g. the database is struggling) the next waits for it.
let sweeping = false;
const sweeper = setInterval(() => {
  if (sweeping) return;
  sweeping = true;
  sweepExpiredLeases(db)
    .then((n) => n && console.log(JSON.stringify({ level: 'info', msg: 'recovered stale applications', count: n })))
    .catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'sweeper failed', message: e.message })))
    .finally(() => {
      sweeping = false;
    });
}, 30_000);

function shutdown() {
  clearInterval(sweeper);
  server.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Last-resort logging: anything reaching here is a bug. Log it so it shows in Railway, then restart cleanly.
process.on('unhandledRejection', (e) => {
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled rejection', message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }));
  shutdown();
});
process.on('uncaughtException', (e) => {
  console.error(JSON.stringify({ level: 'error', msg: 'uncaught exception', message: e.message, stack: e.stack }));
  shutdown();
});
