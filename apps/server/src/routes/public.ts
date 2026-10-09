import { Router } from 'express';
import { ADAPTERS } from '@applyflux/form-engine';
import type { AppContext } from '../context';
import { ah } from '../lib/errors';

/** Public, unauthenticated data: health and the platform compatibility matrix. */
export function publicRoutes(ctx: AppContext) {
  const r = Router();
  r.get('/health', ah(async (_req, res) => {
    await ctx.db.query('select 1');
    res.json({ data: { ok: true, ai: ctx.ai.configured } });
  }));
  r.get('/public/platforms', (_req, res) => {
    const auto = new Set(ctx.config.AUTO_SUBMIT_PLATFORMS.split(',').map((s) => s.trim()));
    res.json({
      data: ADAPTERS.map((a) => ({
        id: a.id,
        name: a.name,
        autofill: a.capabilities.autofill,
        multiStep: a.capabilities.multiStep,
        attachments: a.capabilities.attachments,
        autoSubmit: a.capabilities.autoSubmit && auto.has(a.id),
        testStatus: a.testStatus,
        restriction: a.restriction ?? null,
      })),
    });
  });
  return r;
}
