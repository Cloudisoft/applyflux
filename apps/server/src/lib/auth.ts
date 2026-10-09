import { createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from '../config';
import type { Db } from '../db';
import { AppError } from './errors';

export interface AuthedRequest extends Request {
  user: { id: string; email: string | null };
}
export interface ExtRequest extends Request {
  user: { id: string; email: null };
  connectionId: string;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Verifies Supabase access tokens: HS256 shared secret (legacy) or the project's JWKS (asymmetric keys). */
export function createJwtVerifier(config: Config) {
  const secret = config.SUPABASE_JWT_SECRET ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET) : null;
  const jwks = config.SUPABASE_URL ? createRemoteJWKSet(new URL(`${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`)) : null;
  return async (token: string): Promise<JWTPayload> => {
    const opts = { audience: 'authenticated' };
    if (secret) {
      try {
        return (await jwtVerify(token, secret, opts)).payload;
      } catch (e) {
        if (!jwks) throw e;
      }
    }
    if (!jwks) throw new Error('No JWT verification method configured');
    return (await jwtVerify(token, jwks, opts)).payload;
  };
}

export function requireUser(verify: (t: string) => Promise<JWTPayload>) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const h = req.header('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return next(new AppError('UNAUTHENTICATED', 'Sign in required'));
    try {
      const p = await verify(token);
      if (!p.sub || p.role !== 'authenticated') throw new Error('not a user token');
      (req as AuthedRequest).user = { id: p.sub, email: typeof p.email === 'string' ? p.email : null };
      next();
    } catch {
      next(new AppError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.'));
    }
  };
}

/** Extension tokens are opaque random strings; only their SHA-256 is stored. */
export function requireExtension(db: Db, config: Config) {
  const allowed = config.EXTENSION_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const origin = req.header('origin');
      if (origin && allowed.length && !allowed.includes(origin)) throw new AppError('FORBIDDEN', 'Unknown extension origin');
      if (origin && !allowed.length && !origin.startsWith('chrome-extension://') && config.NODE_ENV === 'production')
        throw new AppError('FORBIDDEN', 'Extension endpoints only accept extension origins');
      const h = req.header('authorization') ?? '';
      const token = h.startsWith('Ext ') ? h.slice(4) : null;
      if (!token) throw new AppError('UNAUTHENTICATED', 'Extension not connected');
      const r = await db.query(
        `update extension_connections set last_seen_at = now()
          where token_hash = $1 and revoked_at is null and expires_at > now()
          returning id, user_id`,
        [sha256(token)],
      );
      if (!r.rows[0]) throw new AppError('EXTENSION_REVOKED', 'This extension connection is no longer valid. Reconnect it from ApplyFlux.');
      (req as ExtRequest).user = { id: r.rows[0].user_id, email: null };
      (req as ExtRequest).connectionId = r.rows[0].id;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Short-lived HMAC-signed links so the extension can download a user's own document without Supabase credentials. */
export function signDownload(secret: string, documentId: string, userId: string, ttlSeconds = 600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${documentId}.${userId}.${exp}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${documentId}?u=${userId}&e=${exp}&s=${sig}`;
}

export function verifyDownload(secret: string, documentId: string, userId: string, exp: string, sig: string): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const expected = createHmac('sha256', secret).update(`${documentId}.${userId}.${exp}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
