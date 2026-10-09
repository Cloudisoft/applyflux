import { Router } from 'express';
import { z } from 'zod';
import { SavedAnswerInput, classifyQuestion, computeMatch, extractSkills, isSensitive, matchesAnyVariant, questionKey } from '@applyflux/shared';
import type { AppContext } from '../context';
import { camel, many, one } from '../db';
import { AppError, ah, notFound } from '../lib/errors';
import type { AuthedRequest } from '../lib/auth';
import { coverLetterPrompt, tailoringPrompt } from '../ai/prompts';
import { groundingIssues } from '../ai/grounding';
import { factSheet, loadFullProfile } from '../services/profile';
import { matchProfileFrom } from '../services/jobs';
import { renderPdf, storeDocument } from '../services/documents';

export function contentRoutes(ctx: AppContext) {
  const r = Router();

  /* Saved answers ------------------------------------------------------ */

  r.get(
    '/answers',
    ah<AuthedRequest>(async (req, res) => {
      const rows = await many(ctx.db, 'select * from saved_answers where user_id=$1 order by approved asc, updated_at desc', [req.user.id]);
      res.json({ data: rows.map((x) => camel(x)) });
    }),
  );

  r.post(
    '/answers',
    ah<AuthedRequest>(async (req, res) => {
      const b = SavedAnswerInput.parse(req.body);
      const category = b.category ?? classifyQuestion(b.question);
      const row = await one(
        ctx.db,
        `insert into saved_answers (user_id, question, question_key, category, answer, is_sensitive, approved, source)
         values ($1,$2,$3,$4,$5,$6,$7,'user')
         on conflict (user_id, question_key) do update set answer=excluded.answer, approved=excluded.approved, category=excluded.category, source='user'
         returning *`,
        [req.user.id, b.question, questionKey(b.question), category, b.answer, isSensitive(category), b.approved],
      );
      res.status(201).json({ data: camel(row) });
    }),
  );

  r.patch(
    '/answers/:id',
    ah<AuthedRequest>(async (req, res) => {
      const b = z.object({ answer: z.string().trim().min(1).max(5000).optional(), approved: z.boolean().optional() }).parse(req.body);
      const row = await one(
        ctx.db,
        `update saved_answers set answer=coalesce($3, answer), approved=coalesce($4, approved), source = case when $3 is not null then 'user' else source end
          where id=$1 and user_id=$2 returning *`,
        [z.string().uuid().parse(req.params.id), req.user.id, b.answer ?? null, b.approved ?? null],
      );
      if (!row) throw notFound('Answer');
      if (row.approved && !String(row.answer).trim()) throw new AppError('VALIDATION_FAILED', 'Write an answer before approving it');
      res.json({ data: camel(row) });
    }),
  );

  r.delete(
    '/answers/:id',
    ah<AuthedRequest>(async (req, res) => {
      await ctx.db.query('delete from saved_answers where id=$1 and user_id=$2', [z.string().uuid().parse(req.params.id), req.user.id]);
      res.json({ data: { ok: true } });
    }),
  );

  /* Cover letters ------------------------------------------------------ */

  r.get(
    '/cover-letters',
    ah<AuthedRequest>(async (req, res) => {
      const rows = await many(ctx.db, `select c.*, j.title as job_title, j.company as job_company from cover_letters c left join jobs j on j.id=c.job_id where c.user_id=$1 order by c.updated_at desc`, [req.user.id]);
      res.json({ data: rows.map((x) => camel(x)) });
    }),
  );

  r.post(
    '/cover-letters',
    ah<AuthedRequest>(async (req, res) => {
      const b = z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20000), jobId: z.string().uuid().nullish(), length: z.enum(['concise', 'detailed']).default('concise') }).parse(req.body);
      if (b.jobId && !(await one(ctx.db, 'select 1 from jobs where id=$1 and user_id=$2', [b.jobId, req.user.id]))) throw notFound('Job');
      const row = await one(ctx.db, `insert into cover_letters (user_id, job_id, title, body, length) values ($1,$2,$3,$4,$5) returning *`, [req.user.id, b.jobId ?? null, b.title, b.body, b.length]);
      res.status(201).json({ data: camel(row) });
    }),
  );

  r.post(
    '/cover-letters/generate',
    ah<AuthedRequest>(async (req, res) => {
      const b = z.object({ jobId: z.string().uuid(), length: z.enum(['concise', 'detailed']).default('concise') }).parse(req.body);
      const job = await one<{ title: string; company: string; description: string | null }>(ctx.db, 'select title, company, description from jobs where id=$1 and user_id=$2', [b.jobId, req.user.id]);
      if (!job) throw notFound('Job');
      if (!ctx.ai.configured) throw new AppError('AI_NOT_CONFIGURED', 'AI is not configured on this server. Write the cover letter manually.');
      const profile = await loadFullProfile(ctx.db, req.user.id);
      const name = [profile.profile.firstName, profile.profile.lastName].filter(Boolean).join(' ');
      if (!name || !profile.experiences.length) throw new AppError('PROFILE_INCOMPLETE', 'Add your name and work history before generating a cover letter');
      const facts = factSheet(profile);
      const text = (await ctx.ai.text(coverLetterPrompt(facts, job, b.length, name), { maxTokens: 900, temperature: 0.4 })).trim();
      const warnings = groundingIssues(text, facts);
      const row = await one(
        ctx.db,
        `insert into cover_letters (user_id, job_id, title, body, length, generated, status) values ($1,$2,$3,$4,$5,true,'draft') returning *`,
        [req.user.id, b.jobId, `${job.company} — ${job.title}`.slice(0, 200), text, b.length],
      );
      res.status(201).json({ data: { ...camel(row), warnings } });
    }),
  );

  r.patch(
    '/cover-letters/:id',
    ah<AuthedRequest>(async (req, res) => {
      const b = z.object({ title: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(20000).optional(), status: z.enum(['draft', 'approved']).optional() }).parse(req.body);
      const row = await one(
        ctx.db,
        `update cover_letters set title=coalesce($3,title), body=coalesce($4,body), status=coalesce($5,status),
           document_id = case when $4 is not null then null else document_id end where id=$1 and user_id=$2 returning *`,
        [z.string().uuid().parse(req.params.id), req.user.id, b.title ?? null, b.body ?? null, b.status ?? null],
      );
      if (!row) throw notFound('Cover letter');
      res.json({ data: camel(row) });
    }),
  );

  /** Render an approved letter to PDF so it can be attached to applications that require a file. */
  r.post(
    '/cover-letters/:id/render',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const cl = await one<Record<string, any>>(ctx.db, 'select * from cover_letters where id=$1 and user_id=$2', [id, req.user.id]);
      if (!cl) throw notFound('Cover letter');
      const profile = await loadFullProfile(ctx.db, req.user.id);
      const name = [profile.profile.firstName, profile.profile.lastName].filter(Boolean).join(' ') || 'Cover Letter';
      const contact = [profile.profile.email, profile.profile.phone, profile.profile.city].filter(Boolean).join('  ·  ');
      const pdf = await renderPdf(name, contact || null, [{ text: cl.body }]);
      // Verify the render before it can be attached: it must parse back as a PDF.
      if (pdf.subarray(0, 5).toString() !== '%PDF-' || pdf.length < 500) throw new AppError('INTERNAL', 'Rendered PDF failed verification');
      const doc = await storeDocument(ctx.db, ctx.storage, { userId: req.user.id, kind: 'cover_letter', title: cl.title, fileName: `Cover_Letter_${name.replace(/\s+/g, '_')}.pdf`, bytes: pdf, origin: 'generated' });
      await ctx.db.query('update cover_letters set document_id=$2 where id=$1', [id, doc.id]);
      res.json({ data: doc });
    }),
  );

  r.delete(
    '/cover-letters/:id',
    ah<AuthedRequest>(async (req, res) => {
      await ctx.db.query('delete from cover_letters where id=$1 and user_id=$2', [z.string().uuid().parse(req.params.id), req.user.id]);
      res.json({ data: { ok: true } });
    }),
  );

  /* Resume studio ------------------------------------------------------ */

  /** Deterministic gap analysis: which of the job's skills the resume and profile actually show. */
  r.post(
    '/studio/analyze',
    ah<AuthedRequest>(async (req, res) => {
      const b = z.object({ documentId: z.string().uuid(), jobId: z.string().uuid() }).parse(req.body);
      const doc = await one<{ parsed_text: string | null }>(ctx.db, `select parsed_text from documents where id=$1 and user_id=$2 and kind='resume'`, [b.documentId, req.user.id]);
      const job = await one<Record<string, any>>(ctx.db, 'select * from jobs where id=$1 and user_id=$2', [b.jobId, req.user.id]);
      if (!doc || !job) throw notFound('Resume or job');
      const profile = await loadFullProfile(ctx.db, req.user.id);
      const jobSkills = extractSkills(`${job.title}\n${job.description ?? ''}`);
      const resumeText = doc.parsed_text ?? '';
      const inResume = jobSkills.filter((s) => matchesAnyVariant(resumeText, s));
      const inProfileOnly = jobSkills.filter((s) => !inResume.includes(s) && profile.profile.skills.some((p) => matchesAnyVariant(p, s)));
      const missing = jobSkills.filter((s) => !inResume.includes(s) && !inProfileOnly.includes(s));
      const match = computeMatch(matchProfileFrom(profile), { title: job.title, company: job.company, description: job.description, location: job.location, workplaceType: job.workplace_type, employmentType: job.employment_type, salaryMin: job.salary_min, salaryMax: job.salary_max });
      const analysis = {
        jobSkills,
        inResume,
        inProfileOnly,
        missing,
        coverage: jobSkills.length ? Math.round((inResume.length / jobSkills.length) * 100) : null,
        match,
        suggestions: [
          ...inProfileOnly.map((s) => `Your profile lists "${s}" but this resume doesn't mention it — add it where you genuinely used it.`),
          ...(missing.length ? [`Not evidenced anywhere in your profile: ${missing.join(', ')}. Don't add these unless you have real experience.`] : []),
        ],
      };
      const row = await one(ctx.db, `insert into resume_tailorings (user_id, document_id, job_id, analysis) values ($1,$2,$3,$4) returning *`, [req.user.id, b.documentId, b.jobId, JSON.stringify(analysis)]);
      res.json({ data: camel(row) });
    }),
  );

  /** AI-tailored resume content (grounded) rendered as a new version of the resume. */
  r.post(
    '/studio/:id/tailor',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const t = await one<Record<string, any>>(ctx.db, 'select * from resume_tailorings where id=$1 and user_id=$2', [id, req.user.id]);
      if (!t) throw notFound('Tailoring');
      if (!ctx.ai.configured) throw new AppError('AI_NOT_CONFIGURED', 'AI is not configured on this server');
      const job = await one<{ title: string; company: string; description: string | null }>(ctx.db, 'select title, company, description from jobs where id=$1', [t.job_id]);
      const profile = await loadFullProfile(ctx.db, req.user.id);
      const verified = { ...profile, experiences: profile.experiences };
      const facts = factSheet(verified);
      const out = await ctx.ai.json<{ headline: string; summary: string; experiences: Array<{ index: number; bullets: string[] }>; skillsOrder: string[] }>(
        tailoringPrompt(facts, job!, t.analysis.missing ?? []),
        { maxTokens: 2500 },
      );
      const warnings = groundingIssues(`${out.summary}\n${(out.experiences ?? []).flatMap((e) => e.bullets).join('\n')}`, facts);
      // Only the candidate's own skills may appear, in the suggested order.
      const ownSkills = new Set(profile.profile.skills.map((s) => s.toLowerCase()));
      const skills = [...new Set([...(out.skillsOrder ?? []).filter((s) => ownSkills.has(s.toLowerCase())), ...profile.profile.skills])];
      await ctx.db.query('update resume_tailorings set tailored=$2 where id=$1', [id, JSON.stringify({ ...out, skillsOrder: skills, warnings })]);
      res.json({ data: { ...out, skillsOrder: skills, warnings } });
    }),
  );

  /** Save the (person-edited) tailored content as a new resume version PDF. */
  r.post(
    '/studio/:id/save',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const b = z
        .object({
          headline: z.string().max(300).default(''),
          summary: z.string().max(3000).default(''),
          experiences: z.array(z.object({ index: z.number().int().min(0), bullets: z.array(z.string().max(500)).max(10) })).max(30).default([]),
          skillsOrder: z.array(z.string().max(60)).max(100).default([]),
        })
        .parse(req.body);
      const t = await one<Record<string, any>>(ctx.db, 'select * from resume_tailorings where id=$1 and user_id=$2', [id, req.user.id]);
      if (!t) throw notFound('Tailoring');
      const job = await one<{ title: string; company: string }>(ctx.db, 'select title, company from jobs where id=$1', [t.job_id]);
      const p = await loadFullProfile(ctx.db, req.user.id);
      const name = [p.profile.firstName, p.profile.lastName].filter(Boolean).join(' ');
      if (!name) throw new AppError('PROFILE_INCOMPLETE', 'Add your name to your profile first');
      const blocks = [
        ...(b.summary ? [{ heading: 'Summary', text: b.summary }] : []),
        {
          heading: 'Experience',
          bullets: [],
        },
        ...p.experiences.map((e, i) => ({
          text: `${e.title} — ${e.company}${e.location ? `, ${e.location}` : ''}   (${e.startDate ?? ''} – ${e.isCurrent ? 'Present' : e.endDate ?? ''})`,
          bullets: b.experiences.find((x) => x.index === i)?.bullets ?? e.achievements,
        })),
        { heading: 'Education', bullets: p.educations.map((e) => `${[e.degree, e.fieldOfStudy].filter(Boolean).join(', ')}${e.degree ? ' — ' : ''}${e.institution}${e.endDate ? ` (${e.endDate})` : ''}`) },
        ...(p.certifications.length ? [{ heading: 'Certifications', bullets: p.certifications.map((c) => `${c.name}${c.issuer ? ` — ${c.issuer}` : ''}`) }] : []),
        { heading: 'Skills', text: (b.skillsOrder.length ? b.skillsOrder : p.profile.skills).join(' · ') },
      ];
      const contact = [p.profile.email, p.profile.phone, [p.profile.city, p.profile.country].filter(Boolean).join(', '), p.profile.linkedinUrl].filter(Boolean).join('  ·  ');
      const pdf = await renderPdf(name, [b.headline, contact].filter(Boolean).join('\n'), blocks);
      if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new AppError('INTERNAL', 'Rendered PDF failed verification');
      const doc = await storeDocument(ctx.db, ctx.storage, {
        userId: req.user.id,
        kind: 'resume',
        title: `${name} — ${job?.company ?? 'tailored'}`.slice(0, 200),
        fileName: `${name.replace(/\s+/g, '_')}_${(job?.company ?? 'tailored').replace(/\W+/g, '_')}.pdf`,
        bytes: pdf,
        origin: 'tailored',
        rootDocumentId: t.document_id,
      });
      await ctx.db.query('update resume_tailorings set output_document_id=$2 where id=$1', [id, doc.id]);
      res.status(201).json({ data: doc });
    }),
  );

  return r;
}
