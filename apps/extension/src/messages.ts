import { z } from 'zod';
import { ExtensionReport, FieldKind } from '@applyflux/shared';

/**
 * Every message between extension components is validated against these
 * schemas. Content scripts can only ask the service worker for a small, fixed
 * set of things; nothing a web page says is ever forwarded as an instruction.
 */

export const ContentToBackground = z.discriminatedUnion('type', [
  z.object({ type: z.literal('af:ready') }),
  z.object({ type: z.literal('af:report'), applicationId: z.string().uuid(), report: ExtensionReport }),
  z.object({
    type: z.literal('af:answers'),
    applicationId: z.string().uuid(),
    questions: z
      .array(z.object({ key: z.string().max(300), label: z.string().max(1000), kind: FieldKind, options: z.array(z.string().max(300)).max(300).optional(), required: z.boolean(), maxLength: z.number().int().positive().optional() }))
      .max(40),
  }),
  z.object({ type: z.literal('af:phase'), applicationId: z.string().uuid(), phase: z.enum(['filling', 'awaiting_verification', 'awaiting_auth', 'awaiting_review', 'submitting', 'done']) }),
  z.object({ type: z.literal('af:save_job'), job: z.object({ url: z.string().url().max(2000), title: z.string().min(1).max(300), company: z.string().min(1).max(200), location: z.string().max(300).optional(), description: z.string().max(60000).optional() }) }),
]);
export type ContentToBackground = z.infer<typeof ContentToBackground>;

/** Messages from ApplyFlux web pages (externally_connectable): status, pairing, and bringing a waiting tab forward. */
export const ExternalMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('af:ping') }),
  z.object({ type: z.literal('af:focus'), applicationId: z.string().uuid().optional() }),
  z.object({ type: z.literal('af:pair'), code: z.string().regex(/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i), apiBase: z.string().url().optional() }),
]);

export type Phase = 'opening' | 'filling' | 'awaiting_verification' | 'awaiting_auth' | 'awaiting_review' | 'submitting' | 'done';

/** Run context the service worker hands to the content script. */
export interface RunContext {
  applicationId: string;
  mode: 'review' | 'assisted' | 'auto';
  allowSubmit: boolean;
  submitApproved: boolean;
  phase: Phase;
  profile: import('@applyflux/shared').AutofillProfile;
  answers: Array<{ questionKey: string; answer: string; category: string }>;
  resume: { fileName: string; mimeType: string; base64: string } | null;
  coverLetter: { fileName: string | null; mimeType: string; base64: string | null; text: string } | null;
  jobUrl: string;
}
