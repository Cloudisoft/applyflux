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
const app = createApp(ctx, { webDist });

const server = app.listen(config.PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'ApplyFlux API listening', port: config.PORT, ai: ctx.ai.configured, sandbox: config.ENABLE_SANDBOX }));
});

// Recovery loop: reclaim applications whose browser stopped reporting.
const sweeper = setInterval(() => {
  sweepExpiredLeases(db)
    .then((n) => n && console.log(JSON.stringify({ level: 'info', msg: 'recovered stale applications', count: n })))
    .catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'sweeper failed', message: e.message })));
}, 30_000);

function shutdown() {
  clearInterval(sweeper);
  server.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
