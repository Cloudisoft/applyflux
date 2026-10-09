import type { AdapterRule } from '../mapping';

export interface AdapterCapabilities {
  autofill: boolean;
  multiStep: boolean;
  attachments: boolean;
  /** Auto Mode may click the final submit button. */
  autoSubmit: boolean;
}

export type TestStatus = 'tested_sandbox' | 'tested_fixture' | 'untested' | 'manual_only';

export interface PlatformAdapter {
  id: string;
  name: string;
  capabilities: AdapterCapabilities;
  /** How this adapter has been verified (surfaced in the compatibility matrix). */
  testStatus: TestStatus;
  /** When set, automation is not permitted; the UI offers manual completion. */
  restriction?: string;
  matchesUrl(url: URL): boolean;
  /** Optional DOM confirmation when the URL alone is ambiguous (company-hosted careers pages). */
  matchesDocument?(doc: Document): boolean;
  /** The application form root, if the form is on screen. */
  findForm(doc: Document): HTMLElement | null;
  /** Click whatever reveals the form ("Apply for this job"); return true if something was clicked. */
  openApplication?(doc: Document): boolean;
  nextButton(doc: Document): HTMLElement | null;
  submitButton(doc: Document): HTMLElement | null;
  /** Add-another buttons for repeating sections, when the platform renders sections lazily. */
  addSectionButton?(doc: Document, section: 'experience' | 'education'): HTMLElement | null;
  mappingRules?: AdapterRule[];
  groupSelectors?: string[];
  confirmationText?: RegExp[];
  confirmationUrl?: RegExp[];
  formSelector?: string;
}
