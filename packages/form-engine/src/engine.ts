import type { AutofillProfile, AutomationMode, ReportedField, ResolvedAnswer } from '@applyflux/shared';
import { classifyQuestion, isSensitive, questionKey } from '@applyflux/shared';
import type { PlatformAdapter } from './adapters';
import { challengeBlocking, detectAuthWall, detectChallenge, type ChallengeState, type WallKind } from './challenge';
import { detectFields } from './detect';
import { isVisible } from './dom';
import { attachFile, fillField } from './fill';
import { CONFIDENCE_FLOOR, mapField } from './mapping';
import type { DetectedField, FieldResult, FileAttachment, MappedKey } from './types';
import { valueFor } from './values';

export interface EngineContext {
  adapter: PlatformAdapter;
  mode: AutomationMode;
  profile: AutofillProfile;
  savedAnswers: Array<{ questionKey: string; answer: string; category: string }>;
  /** Answers resolved by the server (profile facts, approved answers, grounded AI drafts), keyed by field key. */
  resolved?: Record<string, ResolvedAnswer>;
  files: { resume?: FileAttachment | null; coverLetter?: FileAttachment | null };
  coverLetterText?: string | null;
}

export interface PassResult {
  adapterId: string;
  challenge: ChallengeState;
  authWall: WallKind;
  formFound: boolean;
  results: FieldResult[];
  /** Questions the server should try to answer (not yet resolved, no saved answer). */
  pendingQuestions: DetectedField[];
  /** Required fields still empty after this pass. */
  missingRequired: FieldResult[];
  /** Filled but needing a person's look (unverified facts, AI drafts in Assisted mode). */
  uncertain: FieldResult[];
  hasNext: boolean;
  hasSubmit: boolean;
}

const OPTION_KINDS = new Set(['select', 'radio', 'combobox', 'checkbox_group']);

function isEmpty(f: DetectedField): boolean {
  if (f.kind === 'checkbox') return f.currentValue !== 'true';
  return !f.currentValue || /^(select|choose|please select|--)/i.test(f.currentValue);
}

/** Inspect the current page and fill everything that can be filled safely. Idempotent: run it again after answers arrive. */
export async function runPass(doc: Document, ctx: EngineContext): Promise<PassResult> {
  const { adapter } = ctx;
  const challenge = detectChallenge(doc);
  const authWall = detectAuthWall(doc);
  const form = adapter.findForm(doc);
  const base: PassResult = {
    adapterId: adapter.id,
    challenge,
    authWall,
    formFound: !!form,
    results: [],
    pendingQuestions: [],
    missingRequired: [],
    uncertain: [],
    hasNext: false,
    hasSubmit: false,
  };
  // Never type into a page that is asking for a human.
  if (challengeBlocking(challenge) || authWall || !form) return base;

  const fields = detectFields(doc, { root: form, groupSelectors: adapter.groupSelectors });
  const saved = new Map(ctx.savedAnswers.map((a) => [a.questionKey, a]));
  const results: FieldResult[] = [];

  for (const field of fields) {
    const mapping = mapField(field, adapter.mappingRules);
    const res: FieldResult = { field, mapping, status: 'skipped', value: null };
    results.push(res);

    if (!isEmpty(field) && field.kind !== 'file') {
      res.status = 'filled';
      res.value = field.currentValue;
      res.reason = 'Kept the value already on the page';
      continue;
    }

    // Files
    if (field.kind === 'file') {
      if (field.currentValue) {
        res.status = 'filled';
        res.value = field.currentValue;
        continue;
      }
      const file = mapping.mappedTo === 'resume' ? ctx.files.resume : mapping.mappedTo === 'coverLetter' ? ctx.files.coverLetter : null;
      if (file) {
        const out = attachFile(field, file);
        res.status = out.ok ? 'filled' : 'error';
        res.value = out.value;
        res.reason = out.reason;
      } else if (field.required) {
        res.status = 'needs_input';
        res.reason = mapping.mappedTo === 'coverLetter' ? 'A cover letter file is required' : 'Unrecognised required upload';
      }
      continue;
    }

    if (mapping.mappedTo === 'coverLetterText') {
      if (ctx.coverLetterText) await applyValue(res, ctx.coverLetterText, 'filled');
      else if (field.required) res.status = 'needs_input';
      continue;
    }

    // Profile slots
    if (mapping.mappedTo && mapping.mappedTo !== 'question' && mapping.confidence >= CONFIDENCE_FLOOR) {
      const v = valueFor(mapping.mappedTo as MappedKey, field, ctx.profile);
      if (v.value == null) {
        res.status = field.required ? 'needs_input' : 'skipped';
        res.reason = v.reason;
        continue;
      }
      if (!v.verified && ctx.mode === 'auto') {
        res.status = field.required ? 'needs_input' : 'skipped';
        res.reason = 'Profile value not verified; Auto Mode only uses verified facts';
        continue;
      }
      await applyValue(res, v.value, v.verified ? 'filled' : 'uncertain');
      if (!v.verified && res.status === 'uncertain') res.reason = 'Filled from unverified profile data — please check';
      continue;
    }

    // Screening questions
    const qk = questionKey(field.label);
    const category = classifyQuestion(field.label);
    const savedAnswer = saved.get(qk);
    if (savedAnswer) {
      await applyValue(res, savedAnswer.answer, 'filled');
      if (res.status === 'error') {
        res.status = field.required ? 'needs_input' : 'skipped';
        res.reason = `Saved answer "${savedAnswer.answer}" does not match this form's options`;
      }
      continue;
    }
    const resolved = ctx.resolved?.[field.key];
    if (!resolved) {
      base.pendingQuestions.push(field);
      res.status = field.required ? 'needs_input' : 'skipped';
      res.reason = 'Awaiting answer';
      continue;
    }
    if (resolved.needsUser || !resolved.answer) {
      res.status = field.required ? 'needs_input' : 'skipped';
      res.reason = resolved.reason ?? 'Needs your answer';
      continue;
    }
    // Defence in depth: sensitive answers only ever come from the user or verified facts.
    if (isSensitive(category) && resolved.source === 'ai') {
      res.status = field.required ? 'needs_input' : 'skipped';
      res.reason = 'Sensitive question — needs your answer';
      continue;
    }
    const lowConfidence = resolved.confidence < (OPTION_KINDS.has(field.kind) ? 0.85 : 0.7);
    const isDraft = resolved.source === 'ai';
    if (ctx.mode === 'auto' && (lowConfidence || (isDraft && OPTION_KINDS.has(field.kind)))) {
      res.status = field.required ? 'needs_input' : 'skipped';
      res.reason = 'Answer not certain enough for Auto Mode';
      continue;
    }
    await applyValue(res, resolved.answer, isDraft || lowConfidence ? 'uncertain' : 'filled');
    if (res.status === 'uncertain') res.reason = isDraft ? 'AI-drafted from your verified profile — please review' : 'Low-confidence answer — please review';
  }

  base.results = results;
  base.missingRequired = results.filter((r) => r.field.required && (r.status === 'needs_input' || r.status === 'error'));
  base.uncertain = results.filter((r) => r.status === 'uncertain');
  const next = adapter.nextButton(doc);
  const submit = adapter.submitButton(doc);
  base.hasNext = !!next && isVisible(next);
  base.hasSubmit = !!submit && isVisible(submit);
  return base;
}

async function applyValue(res: FieldResult, value: string, okStatus: 'filled' | 'uncertain') {
  const out = await fillField(res.field, value);
  res.status = out.ok ? okStatus : 'error';
  res.value = out.value;
  res.reason = out.reason;
}

export function toReported(results: FieldResult[]): ReportedField[] {
  return results.map((r) => ({
    key: r.field.key.slice(0, 300),
    label: r.field.label.slice(0, 1000),
    kind: r.field.kind,
    required: r.field.required,
    options: r.field.options?.slice(0, 300).map((o) => o.slice(0, 300)),
    mappedTo: r.mapping.mappedTo,
    confidence: r.mapping.confidence,
    status: r.status,
    // Never echo file contents; values are the user's own data being sent to their own account.
    value: r.value?.slice(0, 5000) ?? null,
    reason: r.reason?.slice(0, 500),
  }));
}

/** Questions for the server, as an AnswerRequest payload. */
export function questionsPayload(fields: DetectedField[]) {
  return fields.slice(0, 40).map((f) => ({
    key: f.key,
    label: f.label,
    kind: f.kind,
    options: f.options,
    required: f.required,
    maxLength: f.maxLength ?? undefined,
  }));
}
