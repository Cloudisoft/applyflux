import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { AppContext } from '../context';
import { camel, many, one, tx } from '../db';
import { AppError, ah, notFound } from '../lib/errors';
import type { AuthedRequest } from '../lib/auth';
import { deleteDocument, getDocumentFile, listDocuments, storeDocument } from '../services/documents';
import { ExtractedResume, extractResume, MAX_UPLOAD_BYTES } from '../services/resume';
import { insertSectionItem, loadFullProfile, updateProfile } from '../services/profile';
import { refreshMatches } from '../services/jobs';
import { runDiscovery } from '../services/autodiscover';
import { audit } from '../services/notify';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

export function documentRoutes(ctx: AppContext) {
  const r = Router();

  r.get(
    '/documents',
    ah<AuthedRequest>(async (req, res) => {
      const kind = z.enum(['resume', 'cover_letter']).optional().parse(req.query.kind);
      res.json({ data: await listDocuments(ctx.db, req.user.id, kind) });
    }),
  );

  r.post(
    '/documents',
    (req, res, next) =>
      upload.single('file')(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(new AppError('PAYLOAD_TOO_LARGE', 'Files must be 10 MB or smaller'));
        next(err);
      }),
    ah<AuthedRequest>(async (req, res) => {
      if (!req.file) throw new AppError('BAD_REQUEST', 'Attach a file in the "file" field');
      const body = z
        .object({
          kind: z.enum(['resume', 'cover_letter']).default('resume'),
          title: z.string().trim().min(1).max(200).optional(),
          rootDocumentId: z.string().uuid().optional(),
          makeDefault: z.enum(['true', 'false']).optional(),
        })
        .parse(req.body);
      const doc = await storeDocument(ctx.db, ctx.storage, {
        userId: req.user.id,
        kind: body.kind,
        title: body.title ?? req.file.originalname.replace(/\.[^.]+$/, ''),
        fileName: req.file.originalname,
        bytes: req.file.buffer,
        origin: 'upload',
        rootDocumentId: body.rootDocumentId,
        makeDefault: body.makeDefault === 'true',
      });
      await audit(ctx.db, req.user.id, 'document.upload', { type: 'document', id: doc.id as string });
      res.status(201).json({ data: doc });
    }),
  );

  r.get(
    '/documents/:id/file',
    ah<AuthedRequest>(async (req, res) => {
      const f = await getDocumentFile(ctx.db, ctx.storage, req.user.id, z.string().uuid().parse(req.params.id));
      res.setHeader('content-type', f.mime);
      res.setHeader('content-disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${f.fileName.replace(/"/g, '')}"`);
      res.setHeader('cache-control', 'private, no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.send(f.bytes);
    }),
  );

  r.patch(
    '/documents/:id',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = z.object({ title: z.string().trim().min(1).max(200).optional(), isDefault: z.literal(true).optional() }).parse(req.body);
      await tx(ctx.db, async (c) => {
        const d = await one(c, 'select kind from documents where id=$1 and user_id=$2', [id, req.user.id]);
        if (!d) throw notFound('Document');
        if (body.isDefault) {
          if (d.kind !== 'resume') throw new AppError('BAD_REQUEST', 'Only resumes can be the default');
          await c.query(`update documents set is_default=false where user_id=$1 and kind='resume'`, [req.user.id]);
          await c.query(`update documents set is_default=true where id=$1`, [id]);
        }
        if (body.title) await c.query('update documents set title=$2 where id=$1', [id, body.title]);
      });
      res.json({ data: { ok: true } });
    }),
  );

  r.delete(
    '/documents/:id',
    ah<AuthedRequest>(async (req, res) => {
      await deleteDocument(ctx.db, ctx.storage, req.user.id, z.string().uuid().parse(req.params.id));
      res.json({ data: { ok: true } });
    }),
  );

  /** Parse a stored resume into a reviewable extraction (never written to the profile until applied). */
  r.post(
    '/documents/:id/parse',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const d = await one<{ parsed_text: string | null; parse_status: string; parse_error: string | null }>(
        ctx.db,
        `select parsed_text, parse_status, parse_error from documents where id=$1 and user_id=$2 and kind='resume'`,
        [id, req.user.id],
      );
      if (!d) throw notFound('Resume');
      if (!d.parsed_text) throw new AppError('UNSUPPORTED_FILE', d.parse_error ?? 'No text could be read from this file');
      const out = await extractResume(d.parsed_text, ctx.ai);
      const row = await one(
        ctx.db,
        `insert into resume_parses (user_id, document_id, method, extracted, warnings) values ($1,$2,$3,$4,$5) returning *`,
        [req.user.id, id, out.method, JSON.stringify(out.data), JSON.stringify(out.warnings)],
      );
      res.status(201).json({ data: camel(row) });
    }),
  );

  r.get(
    '/resume-parses/:id',
    ah<AuthedRequest>(async (req, res) => {
      const row = await one(ctx.db, 'select * from resume_parses where id=$1 and user_id=$2', [z.string().uuid().parse(req.params.id), req.user.id]);
      if (!row) throw notFound('Parse');
      res.json({ data: camel(row) });
    }),
  );

  /**
   * Apply a reviewed extraction to the profile. The client sends back the
   * (possibly edited) extraction; values land as resume-sourced and UNVERIFIED
   * unless the person ticked them as confirmed.
   */
  r.post(
    '/resume-parses/:id/apply',
    ah<AuthedRequest>(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = z
        .object({
          extracted: ExtractedResume,
          confirmedFields: z.array(z.string().max(60)).max(60).default([]),
          replaceHistory: z.boolean().default(false),
          confirmHistory: z.boolean().default(false),
        })
        .parse(req.body);
      const parse = await one(ctx.db, 'select id from resume_parses where id=$1 and user_id=$2', [id, req.user.id]);
      if (!parse) throw notFound('Parse');
      const e = body.extracted;
      await tx(ctx.db, async (c) => {
        const current = await loadFullProfile(c, req.user.id);
        const patch: Record<string, unknown> = {};
        const meta = { ...current.profile.fieldMeta };
        const simple = ['firstName', 'lastName', 'email', 'phone', 'city', 'region', 'country', 'linkedinUrl', 'githubUrl', 'portfolioUrl', 'headline', 'summary'] as const;
        for (const k of simple) {
          const v = e[k];
          if (!v) continue;
          // Never overwrite a value the person already verified.
          if (meta[k]?.verified && current.profile[k] && !body.confirmedFields.includes(k)) continue;
          patch[k] = v;
          meta[k] = { source: 'resume', verified: body.confirmedFields.includes(k) };
        }
        if (e.skills.length) {
          patch.skills = [...new Set([...current.profile.skills, ...e.skills])].slice(0, 200);
          meta.skills = { source: 'resume', verified: body.confirmedFields.includes('skills') };
        }
        if (e.languages.length && !current.profile.languages.length) patch.languages = e.languages;
        // No target titles yet: start from the most recent role on the resume so job discovery can begin at once.
        if (!current.profile.desiredTitles.length && e.experiences[0]?.title) patch.desiredTitles = [e.experiences[0].title];
        patch.fieldMeta = meta;
        await updateProfile(c, req.user.id, patch as never);
        if (body.replaceHistory) {
          for (const t of ['work_experiences', 'educations', 'certifications', 'projects']) await c.query(`delete from ${t} where user_id=$1 and source='resume'`, [req.user.id]);
        }
        const v = body.confirmHistory;
        const d = (s: string | null) => (s && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s) ? s : null);
        for (const [i, x] of e.experiences.entries())
          await insertSectionItem(c, req.user.id, 'experiences', { ...x, startDate: d(x.startDate), endDate: x.isCurrent ? null : d(x.endDate), source: 'resume', verified: v, sortOrder: i });
        for (const [i, x] of e.educations.entries())
          await insertSectionItem(c, req.user.id, 'educations', { ...x, startDate: d(x.startDate), endDate: d(x.endDate), source: 'resume', verified: v, sortOrder: i });
        for (const x of e.certifications) await insertSectionItem(c, req.user.id, 'certifications', { ...x, issuedOn: d(x.issuedOn), source: 'resume', verified: v });
        for (const x of e.projects) await insertSectionItem(c, req.user.id, 'projects', { ...x, url: x.url && /^https?:\/\//.test(x.url) ? x.url : null, source: 'resume', verified: v });
        await c.query('update resume_parses set applied_at=now() where id=$1', [id]);
      });
      const full = await loadFullProfile(ctx.db, req.user.id);
      await refreshMatches(ctx.db, req.user.id, full);
      void runDiscovery(ctx, req.user.id);
      res.json({ data: { ok: true } });
    }),
  );

  r.get(
    '/documents/:id/parses',
    ah<AuthedRequest>(async (req, res) => {
      const rows = await many(ctx.db, 'select * from resume_parses where document_id=$1 and user_id=$2 order by created_at desc', [z.string().uuid().parse(req.params.id), req.user.id]);
      res.json({ data: rows.map((x) => camel(x)) });
    }),
  );

  return r;
}
