import { z } from 'zod';
import { APPLICATION_STATES, INTERVENTION_TYPES } from './states';

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

const trimmed = (max = 500) => z.string().trim().max(max);
const optionalText = (max = 500) => trimmed(max).nullish().transform((v) => (v ? v : null));
/** Year-month (YYYY-MM) or full date (YYYY-MM-DD). Partial dates are common on resumes. */
export const partialDate = z
  .string()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'Use YYYY, YYYY-MM or YYYY-MM-DD')
  .nullish()
  .transform((v) => v ?? null);
const url = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    if (!v) return true;
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Must be an http(s) URL')
  .nullish()
  .transform((v) => (v ? v : null));

export const FactSource = z.enum(['resume', 'user', 'ai_suggestion']);
export type FactSource = z.infer<typeof FactSource>;

/** Per-field provenance. `verified` means the user confirmed the value. */
export const FieldMeta = z.object({
  source: FactSource,
  verified: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
});
export type FieldMeta = z.infer<typeof FieldMeta>;

export const WorkplaceType = z.enum(['remote', 'hybrid', 'onsite']);
export const EmploymentType = z.enum(['full_time', 'part_time', 'contract', 'internship', 'temporary']);
export const ExperienceLevel = z.enum(['entry', 'mid', 'senior', 'lead', 'executive']);

export const WorkAuthorization = z.object({
  country: trimmed(80),
  authorized: z.boolean().nullable(),
  requiresSponsorship: z.boolean().nullable(),
});
export type WorkAuthorization = z.infer<typeof WorkAuthorization>;

/* ------------------------------------------------------------------ */
/* Candidate profile                                                   */
/* ------------------------------------------------------------------ */

/**
 * The person's own answers to common screening questions, given once and reused on every form.
 * These are user-provided facts, so they may answer sensitive questions (EEO, consent) that AI never drafts.
 */
const yesNo = z.boolean().nullish().transform((v) => v ?? null);
export const ScreeningAnswers = z.object({
  /** Voluntary self-identification (gender, race, veteran, disability): decline by default. */
  eeo: z.enum(['decline', 'answer']).default('decline'),
  gender: optionalText(80),
  raceEthnicity: optionalText(120),
  hispanicLatino: yesNo,
  veteranStatus: optionalText(120),
  disabilityStatus: optionalText(120),
  sexualOrientation: optionalText(80),
  pronouns: optionalText(40),
  over18: yesNo,
  backgroundCheck: yesNo,
  drugTest: yesNo,
  felonyConviction: yesNo,
  driversLicense: yesNo,
  willingOnsite: yesNo,
  /** Tick privacy-notice / "I certify this is accurate" acknowledgements on application forms. */
  acceptConsents: z.boolean().default(false),
  referralSource: optionalText(120),
});
export type ScreeningAnswers = z.output<typeof ScreeningAnswers>;

export const CandidateProfileInput = z.object({
  firstName: optionalText(80),
  lastName: optionalText(80),
  email: z.string().trim().email().max(254).nullish().or(z.literal('')).transform((v) => (v ? v : null)),
  phone: optionalText(40),
  city: optionalText(120),
  region: optionalText(120),
  country: optionalText(80),
  postalCode: optionalText(20),
  addressLine1: optionalText(200),
  linkedinUrl: url,
  githubUrl: url,
  portfolioUrl: url,
  otherLinks: z.array(z.object({ label: trimmed(60), url: z.string().url().max(500) })).max(10).default([]),
  headline: optionalText(200),
  summary: optionalText(4000),
  yearsExperience: z.number().min(0).max(70).nullish().transform((v) => v ?? null),
  experienceLevel: ExperienceLevel.nullish().transform((v) => v ?? null),
  skills: z.array(trimmed(60)).max(200).default([]),
  industries: z.array(trimmed(60)).max(30).default([]),
  languages: z.array(z.object({ language: trimmed(60), proficiency: optionalText(40) })).max(20).default([]),
  workAuthorizations: z.array(WorkAuthorization).max(20).default([]),
  noticePeriod: optionalText(80),
  availableFrom: partialDate,
  desiredTitles: z.array(trimmed(120)).max(20).default([]),
  desiredSalaryMin: z.number().int().min(0).nullish().transform((v) => v ?? null),
  desiredSalaryMax: z.number().int().min(0).nullish().transform((v) => v ?? null),
  salaryCurrency: z.string().trim().length(3).toUpperCase().nullish().transform((v) => v ?? null),
  employmentTypes: z.array(EmploymentType).max(5).default([]),
  workplaceTypes: z.array(WorkplaceType).max(3).default([]),
  desiredLocations: z.array(trimmed(120)).max(30).default([]),
  willingToRelocate: z.boolean().nullish().transform((v) => v ?? null),
  screening: ScreeningAnswers.default({}),
  fieldMeta: z.record(z.string(), FieldMeta).default({}),
});
export type CandidateProfileInput = z.input<typeof CandidateProfileInput>;
export type CandidateProfileData = z.output<typeof CandidateProfileInput>;

export const WorkExperienceInput = z.object({
  company: trimmed(200).min(1),
  title: trimmed(200).min(1),
  location: optionalText(200),
  startDate: partialDate,
  endDate: partialDate,
  isCurrent: z.boolean().default(false),
  description: optionalText(5000),
  achievements: z.array(trimmed(1000)).max(30).default([]),
  source: FactSource.default('user'),
  verified: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});
export type WorkExperienceInput = z.input<typeof WorkExperienceInput>;
export type WorkExperience = z.output<typeof WorkExperienceInput> & { id: string };

export const EducationInput = z.object({
  institution: trimmed(200).min(1),
  degree: optionalText(200),
  fieldOfStudy: optionalText(200),
  startDate: partialDate,
  endDate: partialDate,
  grade: optionalText(40),
  source: FactSource.default('user'),
  verified: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});
export type Education = z.output<typeof EducationInput> & { id: string };

export const CertificationInput = z.object({
  name: trimmed(200).min(1),
  issuer: optionalText(200),
  issuedOn: partialDate,
  expiresOn: partialDate,
  credentialId: optionalText(120),
  source: FactSource.default('user'),
  verified: z.boolean().default(false),
});
export type Certification = z.output<typeof CertificationInput> & { id: string };

export const ProjectInput = z.object({
  name: trimmed(200).min(1),
  url: url,
  description: optionalText(3000),
  skills: z.array(trimmed(60)).max(40).default([]),
  source: FactSource.default('user'),
  verified: z.boolean().default(false),
});
export type Project = z.output<typeof ProjectInput> & { id: string };

export interface FullCandidateProfile {
  profile: CandidateProfileData & { verifiedAt: string | null; updatedAt: string | null };
  experiences: WorkExperience[];
  educations: Education[];
  certifications: Certification[];
  projects: Project[];
}

/* ------------------------------------------------------------------ */
/* Saved answers                                                       */
/* ------------------------------------------------------------------ */

export const QUESTION_CATEGORIES = [
  'work_authorization',
  'sponsorship',
  'salary',
  'availability',
  'relocation',
  'experience_years',
  'education',
  'demographic',
  'disability',
  'veteran',
  'criminal_history',
  'motivation',
  'referral',
  'contact',
  'links',
  'legal_consent',
  'other',
] as const;
export const QuestionCategory = z.enum(QUESTION_CATEGORIES);
export type QuestionCategory = z.infer<typeof QuestionCategory>;

export const SavedAnswerInput = z.object({
  question: trimmed(1000).min(3),
  answer: trimmed(5000).min(1),
  category: QuestionCategory.optional(),
  approved: z.boolean().default(true),
});

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export const JobImportInput = z.object({
  url: z.string().url().max(2000),
  title: trimmed(300).optional(),
  company: trimmed(200).optional(),
  location: trimmed(300).optional(),
  description: trimmed(60000).optional(),
});

export const JobSearchQuery = z.object({
  q: trimmed(200).optional(),
  location: trimmed(120).optional(),
  remoteOnly: z.coerce.boolean().optional(),
  workplaceType: WorkplaceType.optional(),
  employmentType: EmploymentType.optional(),
  salaryMin: z.coerce.number().int().min(0).optional(),
  company: trimmed(200).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  excludeApplied: z.coerce.boolean().optional(),
  bookmarked: z.coerce.boolean().optional(),
  sponsorshipOk: z.coerce.boolean().optional(),
  sort: z.enum(['score', 'recent', 'company']).default('score'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type JobSearchQuery = z.infer<typeof JobSearchQuery>;

export const JobSourceInput = z.object({
  kind: z.enum(['greenhouse', 'lever', 'ashby']),
  identifier: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, 'Board identifiers contain only letters, digits, dot, dash and underscore'),
  name: trimmed(200).optional(),
});

/* ------------------------------------------------------------------ */
/* Automation                                                          */
/* ------------------------------------------------------------------ */

export const AutomationMode = z.enum(['review', 'assisted', 'auto']);
export type AutomationMode = z.infer<typeof AutomationMode>;

export const AUTO_SUBMIT_CONSENT_VERSION = '2026-10-01';
export const AUTO_SUBMIT_CONSENT_TEXT =
  'I authorise ApplyFlux to submit job applications on my behalf, using only the verified information in my profile and answers I have approved, on platforms ApplyFlux supports for automatic submission. I understand ApplyFlux will pause for CAPTCHAs, sign-ins and any question it cannot answer from my verified data, and that I can pause or stop automation at any time.';

export const AutomationPreferencesInput = z.object({
  mode: AutomationMode,
  dailyLimit: z.number().int().min(1).max(200),
  maxConcurrency: z.number().int().min(1).max(5),
  minMatchScore: z.number().int().min(0).max(100),
  excludedCompanies: z.array(trimmed(200)).max(200).default([]),
  excludedKeywords: z.array(trimmed(100)).max(200).default([]),
  requireSponsorshipFriendly: z.boolean().default(false),
  notifyBrowser: z.boolean().default(false),
  defaultResumeId: z.string().uuid().nullish(),
  coverLetterPolicy: z.enum(['never', 'when_requested', 'always']).default('when_requested'),
});
export type AutomationPreferences = z.infer<typeof AutomationPreferencesInput> & {
  autoSubmitConsentAt: string | null;
  autoSubmitConsentVersion: string | null;
};

export const ApplicationStateSchema = z.enum(APPLICATION_STATES);
export const InterventionTypeSchema = z.enum(INTERVENTION_TYPES);

/* ------------------------------------------------------------------ */
/* Extension protocol                                                  */
/* ------------------------------------------------------------------ */

export const FieldKind = z.enum([
  'text',
  'textarea',
  'email',
  'tel',
  'url',
  'number',
  'date',
  'select',
  'combobox',
  'radio',
  'checkbox',
  'checkbox_group',
  'file',
]);
export type FieldKind = z.infer<typeof FieldKind>;

export const ReportedField = z.object({
  key: z.string().max(300),
  label: z.string().max(1000),
  kind: FieldKind,
  required: z.boolean(),
  options: z.array(z.string().max(300)).max(300).optional(),
  mappedTo: z.string().max(100).nullable(),
  confidence: z.number().min(0).max(1),
  status: z.enum(['filled', 'skipped', 'needs_input', 'uncertain', 'error']),
  value: z.string().max(5000).nullable().optional(),
  reason: z.string().max(500).optional(),
});
export type ReportedField = z.infer<typeof ReportedField>;

export const SubmissionEvidence = z.object({
  finalUrl: z.string().max(2000),
  pageTitle: z.string().max(500).optional(),
  confirmationText: z.string().max(2000).optional(),
  matchedSignals: z.array(z.string().max(200)).max(20),
  formStillPresent: z.boolean(),
  errorsVisible: z.boolean(),
  adapter: z.string().max(60),
  observedAt: z.string(),
});
export type SubmissionEvidence = z.infer<typeof SubmissionEvidence>;

export const VerificationEvidence = z.object({
  challengeVisible: z.boolean(),
  tokenPresent: z.boolean(),
  provider: z.string().max(60),
  observedAt: z.string(),
});
export type VerificationEvidence = z.infer<typeof VerificationEvidence>;

export const ExtensionProgress = z.object({
  step: z.string().max(120),
  progress: z.number().int().min(0).max(100),
  adapter: z.string().max(60).optional(),
  fields: z.array(ReportedField).max(400).optional(),
  stepState: z.record(z.string(), z.unknown()).optional(),
  pageUrl: z.string().max(2000).optional(),
});

export const ExtensionReport = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), data: ExtensionProgress }),
  z.object({
    type: z.literal('intervention'),
    data: z.object({
      intervention: InterventionTypeSchema,
      message: z.string().max(1000),
      fields: z.array(ReportedField).max(400).optional(),
      stepState: z.record(z.string(), z.unknown()).optional(),
      pageUrl: z.string().max(2000).optional(),
    }),
  }),
  z.object({ type: z.literal('verification_resolved'), data: VerificationEvidence }),
  z.object({ type: z.literal('ready_for_review'), data: z.object({ fields: z.array(ReportedField).max(400), pageUrl: z.string().max(2000) }) }),
  z.object({ type: z.literal('submit_attempted'), data: z.object({ pageUrl: z.string().max(2000) }) }),
  z.object({ type: z.literal('submission_result'), data: SubmissionEvidence }),
  z.object({
    type: z.literal('failed'),
    data: z.object({ code: z.string().max(80), message: z.string().max(1000), retryable: z.boolean() }),
  }),
]);
export type ExtensionReport = z.infer<typeof ExtensionReport>;

export const AnswerRequest = z.object({
  applicationId: z.string().uuid(),
  questions: z
    .array(
      z.object({
        key: z.string().max(300),
        label: z.string().max(1000),
        kind: FieldKind,
        options: z.array(z.string().max(300)).max(300).optional(),
        required: z.boolean(),
        maxLength: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(40),
});
export type AnswerRequest = z.infer<typeof AnswerRequest>;

export interface ResolvedAnswer {
  key: string;
  answer: string | null;
  /** 'saved' = user-approved answer, 'profile' = verified fact, 'ai' = generated draft grounded in facts */
  source: 'saved' | 'profile' | 'ai' | 'none';
  confidence: number;
  needsUser: boolean;
  reason?: string;
}

export interface ExecutionTask {
  applicationId: string;
  leaseExpiresAt: string;
  mode: AutomationMode;
  allowSubmit: boolean;
  job: { id: string; url: string; title: string; company: string; atsVendor: string | null };
  profile: AutofillProfile;
  answers: Array<{ question: string; questionKey: string; answer: string; category: string }>;
  resume: { documentId: string; fileName: string; mimeType: string; downloadUrl: string } | null;
  coverLetter: { id: string; text: string; downloadUrl: string | null; fileName: string | null } | null;
  resumeFromStep: Record<string, unknown> | null;
  attempt: number;
}

/** The subset of verified profile data an executor may type into a form. */
export interface AutofillProfile {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postalCode: string | null;
  addressLine1: string | null;
  location: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  currentCompany: string | null;
  currentTitle: string | null;
  yearsExperience: number | null;
  highestDegree: string | null;
  school: string | null;
  workAuthorizations: WorkAuthorization[];
  noticePeriod: string | null;
  availableFrom: string | null;
  desiredSalaryMin: number | null;
  desiredSalaryMax: number | null;
  salaryCurrency: string | null;
  willingToRelocate: boolean | null;
  /** The person's own screening answers (always theirs, so usable in Auto Mode). */
  screening: ScreeningAnswers;
  /** Most recent first. `verified` false entries are never typed in Auto Mode. */
  experiences: Array<{ company: string; title: string; location: string | null; startDate: string | null; endDate: string | null; isCurrent: boolean; description: string | null; verified: boolean }>;
  educations: Array<{ institution: string; degree: string | null; fieldOfStudy: string | null; startDate: string | null; endDate: string | null; verified: boolean }>;
  /** Keys of the fields above the user has verified; unverified values are never filled in Auto Mode. */
  verifiedKeys: string[];
}
