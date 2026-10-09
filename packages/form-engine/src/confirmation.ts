import type { SubmissionEvidence } from '@applyflux/shared';
import { isVisible, visibleText } from './dom';

const CONFIRMATION_TEXT: RegExp[] = [
  /thank(s| you) for (applying|your application|submitting)/i,
  /your application (has been|was) (successfully )?(submitted|received|sent)/i,
  /application (successfully )?(submitted|received)/i,
  /we('ve| have) received your application/i,
  /application complete/i,
  /you('ve| have) (successfully )?applied/i,
];
const CONFIRMATION_URL: RegExp[] = [/\/(thank-?you|thanks|confirmation|application[-_]?submitted|submitted)(\/|$|\?)/i, /[?&](submitted|success)=(1|true)/i];

export interface ConfirmationOptions {
  adapter: string;
  extraText?: RegExp[];
  extraUrl?: RegExp[];
  formSelector?: string;
}

export function hasVisibleErrors(doc: Document): boolean {
  const invalid = Array.from(doc.querySelectorAll('[aria-invalid="true"]')).filter(isVisible);
  if (invalid.length) return true;
  const alerts = Array.from(doc.querySelectorAll('[role="alert"], .error, .field-error, .error-message, .errors')).filter(
    (e) => isVisible(e) && (e.textContent ?? '').trim().length > 0,
  );
  return alerts.some((a) => /required|invalid|error|please (enter|select|provide|complete)|must/i.test(a.textContent ?? ''));
}

/** Gather evidence after a submit click. The server decides SUBMITTED vs SUBMISSION_UNVERIFIED from it. */
export function collectSubmissionEvidence(doc: Document, opts: ConfirmationOptions): SubmissionEvidence {
  const text = visibleText(doc.body).slice(0, 20000);
  const url = doc.location?.href ?? '';
  const matchedSignals: string[] = [];
  let confirmationText: string | undefined;
  for (const re of [...CONFIRMATION_TEXT, ...(opts.extraText ?? [])]) {
    const m = text.match(re);
    if (m) {
      matchedSignals.push(`text:${re.source}`);
      const i = m.index ?? 0;
      confirmationText = confirmationText ?? text.slice(Math.max(0, i - 80), i + 200);
    }
  }
  for (const re of [...CONFIRMATION_URL, ...(opts.extraUrl ?? [])]) if (re.test(url)) matchedSignals.push(`url:${re.source}`);
  const form = doc.querySelector(opts.formSelector ?? 'form');
  const formStillPresent = !!form && isVisible(form) && form.querySelectorAll('input:not([type=hidden]), textarea, select').length > 2;
  return {
    finalUrl: url,
    pageTitle: doc.title?.slice(0, 500),
    confirmationText: confirmationText?.slice(0, 2000),
    matchedSignals,
    formStillPresent,
    errorsVisible: hasVisibleErrors(doc),
    adapter: opts.adapter,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Server-side and client-side shared verdict. A submission is "confirmed" only
 * with a confirmation signal, no visible errors, and the form gone (or a
 * confirmation URL). Anything weaker is SUBMISSION_UNVERIFIED.
 */
export function judgeEvidence(e: SubmissionEvidence): 'confirmed' | 'unverified' | 'failed' {
  if (e.errorsVisible && e.formStillPresent) return 'failed';
  const hasText = e.matchedSignals.some((s) => s.startsWith('text:'));
  const hasUrl = e.matchedSignals.some((s) => s.startsWith('url:'));
  if ((hasText && !e.formStillPresent && !e.errorsVisible) || (hasText && hasUrl)) return 'confirmed';
  return 'unverified';
}
