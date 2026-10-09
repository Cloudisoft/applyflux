/**
 * Application state machine. This is the single definition of which states
 * exist and which transitions are legal; the database enforces the same table
 * through a trigger (see supabase/migrations/0003_state_machine.sql) and the
 * test suite checks the two stay in sync.
 */

export const APPLICATION_STATES = [
  'DISCOVERED',
  'SHORTLISTED',
  'QUEUED',
  'IN_PROGRESS',
  'AWAITING_HUMAN_VERIFICATION',
  'AWAITING_REVIEW',
  'NEEDS_ATTENTION',
  'SUBMITTED',
  'SUBMISSION_UNVERIFIED',
  'FAILED',
  'SKIPPED',
  'INTERVIEW',
  'REJECTED',
  'WITHDRAWN',
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];

export const TRANSITIONS: Record<ApplicationState, readonly ApplicationState[]> = {
  DISCOVERED: ['SHORTLISTED', 'QUEUED', 'SKIPPED'],
  SHORTLISTED: ['DISCOVERED', 'QUEUED', 'SKIPPED'],
  QUEUED: ['SHORTLISTED', 'IN_PROGRESS', 'SKIPPED'],
  IN_PROGRESS: [
    'QUEUED',
    'AWAITING_HUMAN_VERIFICATION',
    'AWAITING_REVIEW',
    'NEEDS_ATTENTION',
    'SUBMITTED',
    'SUBMISSION_UNVERIFIED',
    'FAILED',
    'SKIPPED',
  ],
  AWAITING_HUMAN_VERIFICATION: ['IN_PROGRESS', 'NEEDS_ATTENTION', 'FAILED', 'SKIPPED'],
  AWAITING_REVIEW: ['IN_PROGRESS', 'SUBMITTED', 'SUBMISSION_UNVERIFIED', 'NEEDS_ATTENTION', 'SKIPPED'],
  NEEDS_ATTENTION: ['QUEUED', 'IN_PROGRESS', 'SUBMITTED', 'SUBMISSION_UNVERIFIED', 'FAILED', 'SKIPPED'],
  SUBMITTED: ['INTERVIEW', 'REJECTED', 'WITHDRAWN'],
  SUBMISSION_UNVERIFIED: ['SUBMITTED', 'NEEDS_ATTENTION', 'INTERVIEW', 'REJECTED', 'WITHDRAWN'],
  FAILED: ['QUEUED', 'SKIPPED'],
  SKIPPED: ['SHORTLISTED', 'QUEUED'],
  INTERVIEW: ['REJECTED', 'WITHDRAWN'],
  REJECTED: [],
  WITHDRAWN: [],
};

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** States in which an executor (the extension) holds the application. */
export const ACTIVE_STATES: readonly ApplicationState[] = ['IN_PROGRESS', 'AWAITING_HUMAN_VERIFICATION', 'AWAITING_REVIEW'];

/** States that need a person before anything else happens. */
export const INTERVENTION_STATES: readonly ApplicationState[] = ['AWAITING_HUMAN_VERIFICATION', 'AWAITING_REVIEW', 'NEEDS_ATTENTION'];

/** An application was sent to the employer (confirmed or not). Used for usage counting. */
export const SUBMITTED_STATES: readonly ApplicationState[] = ['SUBMITTED', 'SUBMISSION_UNVERIFIED', 'INTERVIEW', 'REJECTED', 'WITHDRAWN'];

export const STATE_LABELS: Record<ApplicationState, string> = {
  DISCOVERED: 'Discovered',
  SHORTLISTED: 'Shortlisted',
  QUEUED: 'Queued',
  IN_PROGRESS: 'In progress',
  AWAITING_HUMAN_VERIFICATION: 'Awaiting verification',
  AWAITING_REVIEW: 'Awaiting review',
  NEEDS_ATTENTION: 'Needs attention',
  SUBMITTED: 'Submitted',
  SUBMISSION_UNVERIFIED: 'Submission unverified',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  INTERVIEW: 'Interview',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

export type StateTone = 'neutral' | 'info' | 'progress' | 'warning' | 'success' | 'danger' | 'muted';

export const STATE_TONES: Record<ApplicationState, StateTone> = {
  DISCOVERED: 'neutral',
  SHORTLISTED: 'info',
  QUEUED: 'info',
  IN_PROGRESS: 'progress',
  AWAITING_HUMAN_VERIFICATION: 'warning',
  AWAITING_REVIEW: 'warning',
  NEEDS_ATTENTION: 'danger',
  SUBMITTED: 'success',
  SUBMISSION_UNVERIFIED: 'warning',
  FAILED: 'danger',
  SKIPPED: 'muted',
  INTERVIEW: 'success',
  REJECTED: 'muted',
  WITHDRAWN: 'muted',
};

export const INTERVENTION_TYPES = [
  'captcha',
  'mfa',
  'login_required',
  'missing_answers',
  'uncertain_answers',
  'unexpected_form',
  'session_expired',
  'automation_restricted',
  'unexpected_navigation',
  'review_before_submit',
  'validation_errors',
  'executor_lost',
] as const;
export type InterventionType = (typeof INTERVENTION_TYPES)[number];

export const INTERVENTION_COPY: Record<InterventionType, { title: string; action: string }> = {
  captcha: { title: 'Human verification required', action: 'Open the tab and complete the verification yourself. ApplyFlux resumes once the page confirms it.' },
  mfa: { title: 'Sign-in verification required', action: 'Complete the multi-factor prompt in the application tab.' },
  login_required: { title: 'Sign-in required', action: 'Sign in to the job site in the application tab, then resume.' },
  missing_answers: { title: 'Missing required information', action: 'Answer the outstanding questions, then resume.' },
  uncertain_answers: { title: 'Answers need your confirmation', action: 'Review the flagged answers before ApplyFlux continues.' },
  unexpected_form: { title: 'Unrecognised application form', action: 'Complete this application manually or skip it.' },
  session_expired: { title: 'Session expired', action: 'Sign in again in the application tab, then resume.' },
  automation_restricted: { title: 'Automation not permitted here', action: 'This site restricts automated applications. Complete it manually or skip it.' },
  unexpected_navigation: { title: 'Page changed unexpectedly', action: 'Check the application tab, then resume or complete it manually.' },
  review_before_submit: { title: 'Ready for your review', action: 'Inspect the filled form and submit it yourself, or approve submission.' },
  validation_errors: { title: 'The form reported errors', action: 'Fix the highlighted fields in the tab, then resume.' },
  executor_lost: { title: 'Browser connection lost', action: 'The extension stopped reporting mid-application. Check whether it was submitted before retrying.' },
};

/** Bounded retry policy shared by server and extension. */
export const RETRY_POLICY = {
  maxAttempts: 3,
  maxVerificationChallenges: 3,
  leaseSeconds: 120,
  verificationTimeoutSeconds: 30 * 60,
} as const;
