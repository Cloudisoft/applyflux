/** Consistent API envelope and error codes shared by server, web and extension. */

export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_TRANSITION',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_FILE',
  'AI_NOT_CONFIGURED',
  'AI_FAILED',
  'SOURCE_FAILED',
  'PROFILE_INCOMPLETE',
  'CONSENT_REQUIRED',
  'LEASE_LOST',
  'EXTENSION_REVOKED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown; requestId?: string };
}
export type ApiSuccess<T> = { data: T };

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
