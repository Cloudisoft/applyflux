import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { AppContext } from './context';
import { requireUser } from './lib/auth';
import { AppError, errorHandler } from './lib/errors';
import { accountRoutes } from './routes/account';
import { applicationRoutes } from './routes/applications';
import { contentRoutes } from './routes/content';
import { documentRoutes } from './routes/documents';
import { extRoutes } from './routes/ext';
import { jobRoutes } from './routes/jobs';
import { profileRoutes } from './routes/profile';
import { publicRoutes } from './routes/public';
import { sandboxApi, sandboxPages } from './sandbox/routes';

export function createApp(ctx: AppContext, opts: { webDist?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, _res, next) => {
    (req as express.Request & { id: string }).id = randomUUID();
    next();
  });

  if (ctx.config.ENABLE_SANDBOX) app.use('/sandbox', sandboxPages());

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: ["'self'", ctx.config.SUPABASE_URL ?? '', ctx.config.SUPABASE_URL?.replace(/^https/, 'wss') ?? ''].filter(Boolean),
          imgSrc: ["'self'", 'data:', 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          frameSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  const webOrigins = ctx.config.WEB_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const extOrigins = ctx.config.EXTENSION_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    '/api',
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (webOrigins.includes(origin)) return cb(null, true);
        if (origin.startsWith('chrome-extension://') && (!extOrigins.length || extOrigins.includes(origin))) return cb(null, true);
        cb(null, false);
      },
      allowedHeaders: ['authorization', 'content-type'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxAge: 600,
    }),
  );
  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false, skip: () => ctx.config.NODE_ENV === 'test' }));

  app.use('/api', publicRoutes(ctx));
  app.use('/api/ext', extRoutes(ctx));

  const authed = express.Router();
  authed.use(requireUser(ctx.verifyJwt));
  authed.use(profileRoutes(ctx));
  authed.use(documentRoutes(ctx));
  authed.use(jobRoutes(ctx));
  authed.use(applicationRoutes(ctx));
  authed.use(contentRoutes(ctx));
  authed.use(accountRoutes(ctx));
  if (ctx.config.ENABLE_SANDBOX) authed.use(sandboxApi(ctx));
  app.use('/api', authed);
  app.use('/api', (_req, _res, next) => next(new AppError('NOT_FOUND', 'No such endpoint')));

  // Serve the built web app (single-origin deployment, e.g. Replit).
  const dist = opts.webDist;
  if (dist && existsSync(join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
