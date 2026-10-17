import {
  answerFromProfile,
  buildAutofillProfile,
  classifyQuestion,
  isSensitive,
  matchOption,
  pickOption,
  questionSimilarity,
  questionKey,
  type AnswerRequest,
  type ResolvedAnswer,
} from '@applyflux/shared';
import type { AiClient } from '../ai/provider';
import { answerPrompt } from '../ai/prompts';
import { groundingIssues } from '../ai/grounding';
import { many, one, type Db } from '../db';
import { factSheet, loadFullProfile } from './profile';

/**
 * Resolution order per question:
 *   1. The user's approved saved answer for the same normalised question.
 *   2. Deterministic answer from verified profile facts.
 *   3. Sensitive categories stop here: the person must answer.
 *   4. A grounded AI draft (non-sensitive only), checked for fabrication.
 * AI drafts are stored as unapproved saved answers so the person can review
 * and approve them for reuse.
 */
export async function resolveAnswers(db: Db, ai: AiClient, userId: string, req: AnswerRequest): Promise<ResolvedAnswer[]> {
  const profile = await loadFullProfile(db, userId);
  const autofill = buildAutofillProfile(profile);
  const saved = new Map(
    (await many<{ question_key: string; answer: string; approved: boolean }>(db, 'select question_key, answer, approved from saved_answers where user_id=$1', [userId])).map((r) => [r.question_key, r]),
  );
  const approved = [...saved.values()].filter((s) => s.approved && s.answer);
  /**
   * The person's own answer to a differently-worded version of the same question (same kind of question only).
   * A choice question accepts a looser wording match, because the answer must also be one of its options.
   */
  const similarSaved = (label: string, category: string, options?: string[]) => {
    const key = questionKey(label);
    let best: { answer: string; score: number } | null = null;
    for (const s of approved) {
      if (classifyQuestion(s.question_key) !== category) continue;
      const score = questionSimilarity(key, s.question_key);
      const enough = options?.length ? score >= 0.7 && !!pickOption(options, s.answer) : score >= 0.75;
      if (enough && (!best || score > best.score)) best = { answer: s.answer, score };
    }
    return best;
  };
  const job = await one<{ title: string; company: string; description: string | null }>(
    db,
    `select j.title, j.company, j.description from applications a join jobs j on j.id=a.job_id where a.id=$1 and a.user_id=$2`,
    [req.applicationId, userId],
  );

  const out: ResolvedAnswer[] = [];
  const forAi: AnswerRequest['questions'] = [];
  for (const q of req.questions) {
    const key = questionKey(q.label);
    const category = classifyQuestion(q.label);
    const s = saved.get(key);
    if (s?.approved) {
      const opt = q.options?.length ? (pickOption(q.options, s.answer) ?? matchOption(q.options, s.answer))?.option : s.answer;
      if (opt) {
        out.push({ key: q.key, answer: opt, source: 'saved', confidence: 0.98, needsUser: false });
        await db.query(`update saved_answers set usage_count = usage_count + 1, last_used_at = now() where user_id=$1 and question_key=$2`, [userId, key]);
        continue;
      }
    }
    // Answered before on another form, in different words.
    const similar = s?.approved ? null : similarSaved(q.label, category, q.options);
    if (similar) {
      const opt = q.options?.length ? pickOption(q.options, similar.answer)?.option ?? null : similar.answer;
      if (opt) {
        out.push({ key: q.key, answer: opt, source: 'saved', confidence: Math.min(0.95, similar.score), needsUser: false });
        continue;
      }
    }
    // Optional diversity questions: filled only once the person has given their answers, otherwise left blank.
    const eeo = ['demographic', 'disability', 'veteran'].includes(category);
    if (!q.required && eeo && autofill.screening.eeo !== 'answer') {
      out.push({ key: q.key, answer: null, source: 'none', confidence: 0, needsUser: false, reason: 'Optional diversity question: left blank' });
      continue;
    }
    const fromProfile = answerFromProfile(q.label, q.options, autofill);
    if (fromProfile.answer && !fromProfile.needsUser) {
      out.push({ key: q.key, answer: fromProfile.answer, source: 'profile', confidence: fromProfile.confidence, needsUser: false });
      continue;
    }
    // Optional questions are only filled when the answer is already known; no AI drafting, no prompts to the person.
    if (!q.required) {
      out.push({ key: q.key, answer: null, source: 'none', confidence: 0, needsUser: false, reason: 'Optional question: skipped' });
      continue;
    }
    if (isSensitive(category)) {
      out.push({ key: q.key, answer: null, source: 'none', confidence: 0, needsUser: true, reason: fromProfile.reason ?? 'This question needs your own answer' });
      await rememberQuestion(db, userId, q.label, category);
      continue;
    }
    forAi.push(q);
  }

  if (forAi.length && ai.configured && job) {
    try {
      const facts = factSheet(profile);
      const res = await ai.json<{ answers: Array<{ key: string; answer: string | null; supported: boolean; confidence: number }> }>(answerPrompt(facts, job, forAi), { maxTokens: 2000 });
      for (const q of forAi) {
        const r = res.answers?.find((x) => x.key === q.key);
        if (!r || !r.supported || !r.answer) {
          out.push({ key: q.key, answer: null, source: 'none', confidence: 0, needsUser: true, reason: 'Your profile does not contain enough information to answer this' });
          await rememberQuestion(db, userId, q.label, classifyQuestion(q.label));
          continue;
        }
        let answer = r.answer.trim();
        if (q.options?.length) {
          const m = matchOption(q.options, answer, 0.9);
          if (!m) {
            out.push({ key: q.key, answer: null, source: 'none', confidence: 0, needsUser: true, reason: 'Could not choose an option confidently' });
            continue;
          }
          answer = m.option;
        }
        if (q.maxLength && answer.length > q.maxLength) answer = answer.slice(0, q.maxLength).replace(/\s+\S*$/, '');
        const issues = groundingIssues(answer, facts);
        const confidence = Math.max(0, Math.min(1, Number(r.confidence) || 0)) * (issues.length ? 0.4 : 1);
        out.push({ key: q.key, answer, source: 'ai', confidence, needsUser: issues.length > 0, reason: issues.length ? `Possible unsupported detail: ${issues.join('; ')}` : undefined });
        // Keep the draft for review and approval; never auto-approved.
        await db.query(
          `insert into saved_answers (user_id, question, question_key, category, answer, is_sensitive, approved, source)
           values ($1,$2,$3,$4,$5,false,false,'ai_draft') on conflict (user_id, question_key) do nothing`,
          [userId, q.label.slice(0, 1000), questionKey(q.label), classifyQuestion(q.label), answer],
        );
      }
    } catch (e) {
      for (const q of forAi) if (!out.find((o) => o.key === q.key)) out.push({ key: q.key, answer: null, source: 'none', confidence: 0, needsUser: true, reason: e instanceof Error ? e.message : 'AI unavailable' });
    }
  } else {
    for (const q of forAi) {
      out.push({ key: q.key, answer: null, source: 'none', confidence: 0, needsUser: true, reason: ai.configured ? 'Needs your answer' : 'AI drafting is not configured; please answer' });
      await rememberQuestion(db, userId, q.label, classifyQuestion(q.label));
    }
  }
  return out;
}

/** Record an unanswered question so it appears in Saved Answers for the person to fill in once. */
async function rememberQuestion(db: Db, userId: string, label: string, category: string) {
  await db.query(
    `insert into saved_answers (user_id, question, question_key, category, answer, is_sensitive, approved, source)
     values ($1,$2,$3,$4,'',$5,false,'extension') on conflict (user_id, question_key) do nothing`,
    [userId, label.slice(0, 1000), questionKey(label), category, isSensitive(category as never)],
  );
}
