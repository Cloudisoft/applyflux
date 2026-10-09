import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { getDocumentProxy } from 'unpdf';
import { extractSkills, parseLooseDate } from '@applyflux/shared';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import type { AiClient } from '../ai/provider';
import { resumeExtractionPrompt } from '../ai/prompts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md'],
  'application/rtf': ['.rtf'],
};

/** Validate by magic bytes as well as declared type; never trust the client's MIME. */
export function sniffType(bytes: Buffer, fileName: string): string {
  const ext = ('.' + (fileName.split('.').pop() ?? '')).toLowerCase();
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04 && ext === '.docx')
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (bytes.subarray(0, 5).toString('latin1') === '{\\rtf') return 'application/rtf';
  if (ext === '.txt' || ext === '.md') {
    const sample = bytes.subarray(0, 4096);
    if (sample.includes(0)) throw new AppError('UNSUPPORTED_FILE', 'Text file contains binary data');
    return ext === '.md' ? 'text/markdown' : 'text/plain';
  }
  if (ext === '.doc') throw new AppError('UNSUPPORTED_FILE', 'Legacy .doc files are not supported. Save as .docx or PDF and upload again.');
  throw new AppError('UNSUPPORTED_FILE', 'Upload a PDF, DOCX, TXT, MD or RTF file.');
}

export function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'document';
  return base.replace(/[^\w.\- ()]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'document';
}

/** Rebuild line structure from positioned text items (section parsing depends on line breaks). */
async function pdfTextWithLines(doc: Awaited<ReturnType<typeof getDocumentProxy>>): Promise<string> {
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let out = '';
    let lastY: number | null = null;
    for (const item of content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
      out += item.str;
      if (item.hasEOL) out += '\n';
      if (y !== null) lastY = y;
    }
    pages.push(out);
  }
  return pages.join('\n\n');
}

export async function extractText(bytes: Buffer, mime: string): Promise<string> {
  let text = '';
  if (mime === 'application/pdf') {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    if (doc.numPages > 20) throw new AppError('UNSUPPORTED_FILE', 'Resumes longer than 20 pages are not supported');
    text = await pdfTextWithLines(doc);
  } else if (mime.includes('wordprocessingml')) {
    const r = await mammoth.extractRawText({ buffer: bytes });
    text = r.value;
  } else if (mime === 'application/rtf') {
    text = bytes
      .toString('latin1')
      .replace(/\\par[d]?/g, '\n')
      .replace(/\{\\\*[^{}]*\}|\\[a-z]+-?\d* ?|[{}]/g, '');
  } else {
    text = bytes.toString('utf8');
  }
  text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, 100_000);
}

export const ExtractedResume = z.object({
  firstName: z.string().nullable().default(null),
  lastName: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
  linkedinUrl: z.string().nullable().default(null),
  githubUrl: z.string().nullable().default(null),
  portfolioUrl: z.string().nullable().default(null),
  headline: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  skills: z.array(z.string()).default([]),
  languages: z.array(z.object({ language: z.string(), proficiency: z.string().nullable().default(null) })).default([]),
  experiences: z
    .array(
      z.object({
        company: z.string(),
        title: z.string(),
        location: z.string().nullable().default(null),
        startDate: z.string().nullable().default(null),
        endDate: z.string().nullable().default(null),
        isCurrent: z.boolean().default(false),
        description: z.string().nullable().default(null),
        achievements: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  educations: z
    .array(
      z.object({
        institution: z.string(),
        degree: z.string().nullable().default(null),
        fieldOfStudy: z.string().nullable().default(null),
        startDate: z.string().nullable().default(null),
        endDate: z.string().nullable().default(null),
      }),
    )
    .default([]),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string().nullable().default(null), issuedOn: z.string().nullable().default(null) })).default([]),
  projects: z.array(z.object({ name: z.string(), url: z.string().nullable().default(null), description: z.string().nullable().default(null) })).default([]),
  uncertain: z.array(z.string()).default([]),
});
export type ExtractedResume = z.infer<typeof ExtractedResume>;

const SECTION_HEADS: Record<string, RegExp> = {
  experience: /^(work |professional |employment )?(experience|history|employment)( history)?:?$/i,
  education: /^(education|academic background|qualifications):?$/i,
  skills: /^(technical |core |key )?skills( & tools| and tools)?:?$|^technologies:?$/i,
  certifications: /^(certifications?|licenses?( & certifications)?):?$/i,
  projects: /^(projects|selected projects):?$/i,
  summary: /^(summary|profile|professional summary|about( me)?|objective):?$/i,
};

const DATE_TOKEN = String.raw`(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}/\d{4}|\d{4}-\d{2}|\d{4})`;
const RANGE = new RegExp(`(${DATE_TOKEN})\\s*(?:-|–|—|to)\\s*(${DATE_TOKEN}|present|current|now)`, 'i');

function normDate(s: string): string | null {
  const d = parseLooseDate(s.replace(/\bsept\b/i, 'sep'));
  return d === 'present' ? null : d;
}

/**
 * Deterministic extraction. Conservative by design: contact details by
 * pattern, sections by heading, roles only when a line carries a date range.
 * Everything it returns is "resume" sourced and unverified until the person
 * confirms it.
 */
export function heuristicExtract(text: string): ExtractedResume {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = ExtractedResume.parse({});
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) out.email = email[0];
  const phone = text.match(/(\+?\d[\d\s().-]{7,}\d)/);
  if (phone && phone[1].replace(/\D/g, '').length >= 9 && phone[1].replace(/\D/g, '').length <= 15) out.phone = phone[1].trim();
  const li = text.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+\/?/i);
  if (li) out.linkedinUrl = li[0].startsWith('http') ? li[0] : `https://${li[0]}`;
  const gh = text.match(/(?:https?:\/\/)?github\.com\/[A-Za-z0-9_-]+\/?/i);
  if (gh) out.githubUrl = gh[0].startsWith('http') ? gh[0] : `https://${gh[0]}`;

  // Name: first line that looks like 2-4 capitalised words and is not a heading/contact line.
  const nameLine = lines.slice(0, 5).find((l) => /^[A-Z][A-Za-z'’.-]+(\s+[A-Z][A-Za-z'’.-]+){1,3}$/.test(l) && !Object.values(SECTION_HEADS).some((r) => r.test(l)));
  if (nameLine) {
    const parts = nameLine.split(/\s+/);
    out.firstName = parts[0];
    out.lastName = parts.slice(1).join(' ');
  } else out.uncertain.push('name');

  // Sections
  const sections: Record<string, string[]> = {};
  let current = 'header';
  for (const l of lines) {
    const head = Object.entries(SECTION_HEADS).find(([, re]) => re.test(l));
    if (head) {
      current = head[0];
      continue;
    }
    (sections[current] ??= []).push(l);
  }
  if (sections.summary) out.summary = sections.summary.join(' ').slice(0, 2000);
  if (sections.skills) {
    out.skills = [
      ...new Set(
        sections.skills
          .join(',')
          .split(/[,;•|·]|\s{2,}/)
          .map((s) => s.replace(/^[-–*]\s*/, '').replace(/^[A-Za-z ]+:\s*/, '').trim())
          .filter((s) => s.length > 1 && s.length < 40),
      ),
    ].slice(0, 80);
  } else {
    out.skills = extractSkills(text);
    if (out.skills.length) out.uncertain.push('skills');
  }

  const exp = sections.experience ?? [];
  for (let i = 0; i < exp.length; i++) {
    const m = exp[i].match(RANGE);
    if (!m) continue;
    const head = exp[i].replace(RANGE, '').replace(/[|,–—-]\s*$/, '').trim();
    const prev = i > 0 && !exp[i - 1].match(RANGE) && !/^[•\-*]/.test(exp[i - 1]) ? exp[i - 1] : '';
    const pieces = (head || prev).split(/\s+(?:at|@|\||–|—|-)\s+|,\s+/).map((s) => s.trim()).filter(Boolean);
    const [title, company] = pieces.length >= 2 ? [pieces[0], pieces[1]] : [pieces[0] ?? 'Role', prev && head ? prev : ''];
    const bullets: string[] = [];
    for (let j = i + 1; j < exp.length && !exp[j].match(RANGE); j++) {
      if (/^[•\-*▪◦]/.test(exp[j])) bullets.push(exp[j].replace(/^[•\-*▪◦]\s*/, ''));
    }
    const isCurrent = /present|current|now/i.test(m[2]);
    out.experiences.push({
      title: title.slice(0, 200),
      company: (company || 'Unknown company').slice(0, 200),
      location: null,
      startDate: normDate(m[1]),
      endDate: isCurrent ? null : normDate(m[2]),
      isCurrent,
      description: null,
      achievements: bullets.slice(0, 15),
    });
  }
  if (exp.length && !out.experiences.length) out.uncertain.push('experiences');

  const edu = sections.education ?? [];
  for (let i = 0; i < edu.length; i++) {
    if (!/universit|college|school|institute|academy/i.test(edu[i])) continue;
    const years = edu.slice(i, i + 3).join(' ').match(/(\d{4})\s*(?:-|–|to)\s*(\d{4})|(\d{4})/);
    const degreeLine = [edu[i - 1], edu[i + 1]].find((l) => l && /bachelor|master|b\.?sc|m\.?sc|b\.?a\.?|m\.?a\.?|ph\.?d|mba|diploma|degree|associate/i.test(l));
    out.educations.push({
      institution: edu[i].replace(/,?\s*\d{4}.*$/, '').slice(0, 200),
      degree: degreeLine?.replace(/,?\s*\d{4}.*$/, '').slice(0, 200) ?? null,
      fieldOfStudy: null,
      startDate: years?.[1] ?? null,
      endDate: years?.[2] ?? years?.[3] ?? null,
    });
  }
  for (const l of sections.certifications ?? []) out.certifications.push({ name: l.replace(/^[•\-*]\s*/, '').slice(0, 200), issuer: null, issuedOn: null });
  return out;
}

export async function extractResume(text: string, ai: AiClient): Promise<{ method: 'heuristic' | 'ai'; data: ExtractedResume; warnings: string[] }> {
  const warnings: string[] = [];
  const heuristic = heuristicExtract(text);
  if (!ai.configured) {
    warnings.push('AI extraction is not configured; used rule-based extraction. Please review every section.');
    return { method: 'heuristic', data: heuristic, warnings };
  }
  try {
    const raw = await ai.json(resumeExtractionPrompt(text), { maxTokens: 3500, temperature: 0 });
    const data = ExtractedResume.parse(raw);
    // Cross-check: AI values that do not occur in the source text are dropped (they would be inventions).
    const lower = text.toLowerCase();
    const inText = (s: string | null) => !s || lower.includes(s.toLowerCase().slice(0, 40));
    for (const k of ['email', 'phone', 'linkedinUrl', 'githubUrl'] as const) {
      if (data[k] && !inText(data[k]!.replace(/^https?:\/\/(www\.)?/, ''))) {
        warnings.push(`Dropped ${k}: not found in resume text`);
        data[k] = heuristic[k];
      }
    }
    data.experiences = data.experiences.filter((e) => {
      const ok = inText(e.company.split(/\s+/)[0]) && inText(e.title.split(/\s+/)[0]);
      if (!ok) warnings.push(`Dropped role "${e.title} at ${e.company}": not found in resume text`);
      return ok;
    });
    data.educations = data.educations.filter((e) => inText(e.institution.split(/\s+/).slice(0, 2).join(' ')));
    data.experiences.forEach((e) => {
      e.startDate = e.startDate ? (normDate(e.startDate) ?? e.startDate.slice(0, 7)) : null;
      e.endDate = e.endDate ? (normDate(e.endDate) ?? e.endDate.slice(0, 7)) : null;
    });
    return { method: 'ai', data, warnings };
  } catch (e) {
    warnings.push(`AI extraction failed (${e instanceof Error ? e.message : 'error'}); used rule-based extraction.`);
    return { method: 'heuristic', data: heuristic, warnings };
  }
}
