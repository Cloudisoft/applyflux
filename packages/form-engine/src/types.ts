import type { FieldKind } from '@applyflux/shared';

export type MappedKey =
  | 'firstName' | 'lastName' | 'fullName' | 'preferredName' | 'email' | 'phone'
  | 'city' | 'region' | 'country' | 'postalCode' | 'addressLine1' | 'location'
  | 'linkedinUrl' | 'githubUrl' | 'portfolioUrl' | 'websiteUrl'
  | 'currentCompany' | 'currentTitle' | 'yearsExperience'
  | 'school' | 'highestDegree'
  | 'salary' | 'noticePeriod' | 'availableFrom'
  | 'resume' | 'coverLetter' | 'coverLetterText'
  | 'experience.company' | 'experience.title' | 'experience.location' | 'experience.startDate' | 'experience.endDate' | 'experience.current' | 'experience.description'
  | 'education.school' | 'education.degree' | 'education.field' | 'education.startDate' | 'education.endDate'
  | 'question';

export interface DetectedField {
  /** Stable key within the page: id, name, or a label-derived slug. */
  key: string;
  kind: FieldKind;
  label: string;
  required: boolean;
  /** Primary element (first radio / checkbox of a group). */
  element: HTMLElement;
  /** All elements in a radio / checkbox group. */
  group?: HTMLInputElement[];
  options?: string[];
  name?: string;
  autocomplete?: string;
  placeholder?: string;
  pattern?: string | null;
  maxLength?: number | null;
  inputType?: string;
  /** Index of the repeating section (work history #2, ...), when in one. */
  groupIndex?: number;
  section?: 'experience' | 'education' | null;
  accept?: string | null;
  currentValue: string;
}

export interface FieldMapping {
  mappedTo: MappedKey | null;
  confidence: number;
  via: 'autocomplete' | 'name' | 'label' | 'adapter' | 'none';
}

export interface FileAttachment {
  fileName: string;
  mimeType: string;
  bytes: ArrayBuffer | Uint8Array;
}

export type FieldStatus = 'filled' | 'skipped' | 'needs_input' | 'uncertain' | 'error';

export interface FieldResult {
  field: DetectedField;
  mapping: FieldMapping;
  status: FieldStatus;
  value: string | null;
  reason?: string;
}
