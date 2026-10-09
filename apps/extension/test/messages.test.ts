import { describe, expect, it } from 'vitest';
import { ContentToBackground, ExternalMessage } from '../src/messages';

describe('extension message validation', () => {
  it('accepts well-formed reports', () => {
    const r = ContentToBackground.safeParse({ type: 'af:report', applicationId: '7d1c2f3e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', report: { type: 'submit_attempted', data: { pageUrl: 'https://x.test' } } });
    expect(r.success).toBe(true);
  });
  it('rejects unknown message types and malformed payloads from pages', () => {
    expect(ContentToBackground.safeParse({ type: 'af:exfiltrate', token: 'x' }).success).toBe(false);
    expect(ContentToBackground.safeParse({ type: 'af:report', applicationId: 'not-a-uuid', report: { type: 'progress', data: {} } }).success).toBe(false);
  });
  it('external pages may only ping or pair', () => {
    expect(ExternalMessage.safeParse({ type: 'af:pair', code: 'ABCD-2345' }).success).toBe(true);
    expect(ExternalMessage.safeParse({ type: 'af:pair', code: 'DROP TABLE' }).success).toBe(false);
    expect(ExternalMessage.safeParse({ type: 'popup:stop' }).success).toBe(false);
  });
});
