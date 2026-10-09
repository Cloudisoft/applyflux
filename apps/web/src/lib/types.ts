import type { ApplicationState, FullCandidateProfile, ProfileAssessment } from '@applyflux/shared';

export interface Me {
  user: { id: string; email: string | null };
  account: { displayName: string | null; onboardingStep: string; onboardingCompletedAt: string | null; timezone: string | null };
  assessment: ProfileAssessment;
  setup: { hasResume: boolean; extensionConnected: boolean; sandboxTested: boolean };
  aiConfigured: boolean;
}

export type ProfileResponse = FullCandidateProfile & { assessment: ProfileAssessment; version: number };

export interface Doc {
  id: string;
  kind: 'resume' | 'cover_letter';
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  rootDocumentId: string | null;
  isDefault: boolean;
  origin: 'upload' | 'tailored' | 'generated';
  parseStatus: 'pending' | 'parsed' | 'failed' | 'not_applicable';
  parseError: string | null;
  createdAt: string;
}

export interface MatchBreakdown {
  score: number;
  components: Array<{ key: string; label: string; score: number; weight: number; detail: string }>;
  matchedSkills: string[];
  missingSkills: string[];
  concerns: string[];
  highlights: string[];
}

export interface Job {
  id: string;
  url: string;
  company: string;
  title: string;
  location: string | null;
  workplaceType: string | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postedAt: string | null;
  atsVendor: string | null;
  liveness: 'active' | 'expired' | 'uncertain' | 'unknown';
  livenessReason: string | null;
  isBookmarked: boolean;
  origin: string;
  createdAt: string;
  score: number | null;
  breakdown: MatchBreakdown | null;
  applicationId: string | null;
  applicationState: ApplicationState | null;
  description?: string | null;
  duplicates?: Array<{ id: string; url: string; title: string; company: string }>;
}

export interface Intervention {
  type: string;
  title: string;
  message: string;
  action: string;
  since: string;
  pageUrl?: string;
}

export interface Application {
  id: string;
  state: ApplicationState;
  mode: string | null;
  priority: number;
  attempts: number;
  maxAttempts: number;
  currentStep: string | null;
  progress: number;
  adapter: string | null;
  intervention: Intervention | null;
  lastError: { code: string; message: string } | null;
  submitAttemptedAt: string | null;
  submittedAt: string | null;
  stateChangedAt: string;
  createdAt: string;
  updatedAt: string;
  jobId: string;
  title: string;
  company: string;
  url: string;
  location: string | null;
  atsVendor: string | null;
  score: number | null;
  resumeDocumentId: string | null;
  coverLetterId: string | null;
  verificationChallenges: number;
  fields?: Array<{ key: string; label: string; kind: string; required: boolean; mappedTo: string | null; status: string; value?: string | null; reason?: string }>;
  submissionEvidence?: Record<string, unknown> | null;
  notes?: string | null;
  events?: Array<{ id: number; type: string; fromState: string | null; toState: string | null; actor: string; message: string | null; createdAt: string }>;
}

export interface Usage {
  applications: { usedToday: number; reserved: number; dailyLimit: number };
}

export interface Run {
  id: string;
  status: 'running' | 'paused' | 'stopped' | 'completed';
  mode: string;
  startedAt: string;
  pausedAt: string | null;
}

export interface Dashboard {
  byState: Record<ApplicationState, number>;
  submittedToday: number;
  submittedThisWeek: number;
  jobsDiscovered: number;
  jobsDiscoveredThisWeek: number;
  confirmedSubmissions: number;
  unverifiedSubmissions: number;
  interviews: number;
  responses: number;
  profileCompleteness: number;
  usage: Usage;
  recentActivity: Array<{ id: number; type: string; message: string | null; toState: string | null; createdAt: string; applicationId: string; title: string; company: string }>;
  attention: Application[];
  run: Run | null;
}

export interface AutomationPrefs {
  mode: 'review' | 'assisted' | 'auto';
  dailyLimit: number;
  maxConcurrency: number;
  minMatchScore: number;
  excludedCompanies: string[];
  excludedKeywords: string[];
  requireSponsorshipFriendly: boolean;
  notifyBrowser: boolean;
  defaultResumeId: string | null;
  coverLetterPolicy: 'never' | 'when_requested' | 'always';
  autoSubmitConsentAt: string | null;
  autoSubmitConsentVersion: string | null;
}

export interface AutomationState {
  preferences: AutomationPrefs;
  run: Run | null;
  runCounts: Partial<Record<ApplicationState, number>>;
  active: Application[];
  consent: { text: string; version: string };
  autoSubmitPlatforms: string[];
}

export interface SavedAnswer {
  id: string;
  question: string;
  questionKey: string;
  category: string;
  answer: string;
  isSensitive: boolean;
  approved: boolean;
  source: 'user' | 'ai_draft' | 'extension';
  usageCount: number;
  updatedAt: string;
}

export interface CoverLetter {
  id: string;
  jobId: string | null;
  jobTitle: string | null;
  jobCompany: string | null;
  title: string;
  body: string;
  length: 'concise' | 'detailed';
  status: 'draft' | 'approved';
  generated: boolean;
  documentId: string | null;
  updatedAt: string;
  warnings?: string[];
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  applicationId: string | null;
  severity: 'info' | 'success' | 'warning' | 'danger';
  readAt: string | null;
  createdAt: string;
}

export interface Source {
  id: string;
  kind: 'greenhouse' | 'lever' | 'ashby';
  identifier: string;
  name: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastJobCount: number | null;
}

export interface Platform {
  id: string;
  name: string;
  autofill: boolean;
  multiStep: boolean;
  attachments: boolean;
  autoSubmit: boolean;
  testStatus: string;
  restriction: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
