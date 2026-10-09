import type { ErrorCode } from '@applyflux/shared';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  QUOTA_EXCEEDED: 402,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_FILE: 415,
  AI_NOT_CONFIGURED: 503,
  AI_FAILED: 502,
  SOURCE_FAILED: 502,
  PROFILE_INCOMPLETE: 422,
  CONSENT_REQUIRED: 403,
  LEASE_LOST: 409,
  EXTENSION_REVOKED: 401,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  get status() {
    return STATUS[this.code];
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);

/** Express 4 does not catch async rejections; wrap every async handler. */
export const ah =
  <T extends Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req as T, res, next).catch(next);

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req as Request & { id?: string }).id;
  if (err instanceof ZodError) {
    return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid request', details: err.flatten(), requestId } });
  }
  if (err instanceof AppError) {
    if (err.status >= 500) console.error(JSON.stringify({ level: 'error', requestId, path: req.path, code: err.code, message: err.message }));
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId } });
  }
  const pg = err as { code?: string; hint?: string; message?: string };
  if (pg?.hint === 'INVALID_TRANSITION') {
    return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: pg.message, requestId } });
  }
  if (pg?.code === '23505') return res.status(409).json({ error: { code: 'CONFLICT', message: 'Already exists', requestId } });
  if ((err as { type?: string })?.type === 'entity.too.large')
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request too large', requestId } });
  // Malformed JSON and other client errors raised by middleware (body-parser, multer).
  const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
  if ((typeof status === 'number' && status >= 400 && status < 500) || (err as Error)?.name === 'MulterError')
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: (err as { type?: string })?.type === 'entity.parse.failed' ? 'Malformed JSON' : (err as Error).message, requestId } });
  // Log without request bodies: they contain personal data.
  console.error(JSON.stringify({ level: 'error', requestId, path: req.path, message: (err as Error)?.message, stack: (err as Error)?.stack?.split('\n').slice(0, 5) }));
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong', requestId } });
}
