import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { camel, many, one, tx, type Db } from '../db';
import { AppError, notFound } from '../lib/errors';
import type { StorageDriver } from '../lib/storage';
import { MAX_UPLOAD_BYTES, extractText, safeFileName, sha256, sniffType } from './resume';

export interface StoreInput {
  userId: string;
  kind: 'resume' | 'cover_letter';
  title: string;
  fileName: string;
  bytes: Buffer;
  origin: 'upload' | 'tailored' | 'generated';
  rootDocumentId?: string | null;
  makeDefault?: boolean;
}

export async function storeDocument(db: Db, storage: StorageDriver, input: StoreInput) {
  if (input.bytes.length === 0) throw new AppError('BAD_REQUEST', 'File is empty');
  if (input.bytes.length > MAX_UPLOAD_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'Files must be 10 MB or smaller');
  const mime = sniffType(input.bytes, input.fileName);
  const id = randomUUID();
  const fileName = safeFileName(input.fileName);
  const path = `${input.userId}/${id}/${fileName}`;
  let parsedText: string | null = null;
  let parseStatus: 'parsed' | 'failed' | 'not_applicable' = 'not_applicable';
  let parseError: string | null = null;
  if (input.kind === 'resume') {
    try {
      parsedText = await extractText(input.bytes, mime);
      parseStatus = parsedText.length > 50 ? 'parsed' : 'failed';
      if (parseStatus === 'failed') parseError = 'No readable text found. If this is a scanned PDF, upload a text-based PDF or DOCX.';
    } catch (e) {
      parseStatus = 'failed';
      parseError = `Could not read this file (${e instanceof Error ? e.message.slice(0, 120) : 'error'})`;
    }
  }
  await storage.put(path, input.bytes, mime);
  try {
    return await tx(db, async (c) => {
      let version = 1;
      let root: string | null = null;
      if (input.rootDocumentId) {
        const r = await one<{ id: string; root_document_id: string | null }>(c, 'select id, root_document_id from documents where id=$1 and user_id=$2', [input.rootDocumentId, input.userId]);
        if (!r) throw notFound('Document');
        root = r.root_document_id ?? r.id;
        const v = await one<{ v: number }>(c, 'select coalesce(max(version),1) as v from documents where id=$1 or root_document_id=$1', [root]);
        version = Number(v!.v) + 1;
      }
      const hasDefault = await one(c, `select 1 from documents where user_id=$1 and kind='resume' and is_default`, [input.userId]);
      const makeDefault = input.kind === 'resume' && (input.makeDefault || !hasDefault);
      if (makeDefault) await c.query(`update documents set is_default=false where user_id=$1 and kind='resume'`, [input.userId]);
      const row = await one(
        c,
        `insert into documents (id, user_id, kind, title, file_name, storage_path, mime_type, size_bytes, sha256, root_document_id, version, is_default, origin, parsed_text, parse_status, parse_error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
        [id, input.userId, input.kind, input.title.slice(0, 200), fileName, path, mime, input.bytes.length, sha256(input.bytes), root, version, makeDefault, input.origin, parsedText, parseStatus, parseError],
      );
      return publicDoc(row!);
    });
  } catch (e) {
    await storage.remove([path]).catch(() => {});
    throw e;
  }
}

export function publicDoc(row: Record<string, unknown>) {
  const d = camel<Record<string, unknown>>(row);
  delete d.storagePath;
  delete d.parsedText;
  delete d.userId;
  return d;
}

export async function listDocuments(db: Db, userId: string, kind?: string) {
  const rows = await many(db, `select * from documents where user_id=$1 ${kind ? 'and kind=$2' : ''} order by coalesce(root_document_id, id), version desc`, kind ? [userId, kind] : [userId]);
  return rows.map(publicDoc);
}

export async function getDocumentFile(db: Db, storage: StorageDriver, userId: string, id: string) {
  const d = await one<Record<string, any>>(db, 'select * from documents where id=$1 and user_id=$2', [id, userId]);
  if (!d) throw notFound('Document');
  return { bytes: await storage.get(d.storage_path), mime: d.mime_type as string, fileName: d.file_name as string };
}

export async function deleteDocument(db: Db, storage: StorageDriver, userId: string, id: string) {
  const rows = await many<{ id: string; storage_path: string; is_default: boolean }>(
    db,
    `delete from documents where user_id=$1 and (id=$2 or root_document_id=$2) returning id, storage_path, is_default`,
    [userId, id],
  );
  if (!rows.length) throw notFound('Document');
  await storage.remove(rows.map((r) => r.storage_path));
  if (rows.some((r) => r.is_default)) {
    await db.query(
      `update documents set is_default=true where id = (select id from documents where user_id=$1 and kind='resume' order by created_at desc limit 1)`,
      [userId],
    );
  }
}

/* ------------------------------------------------------------------ */
/* PDF rendering for generated documents                               */
/* ------------------------------------------------------------------ */

function wrapLines(text: string, font: import('pdf-lib').PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) > width && line) {
        out.push(line);
        line = word;
      } else line = test;
    }
    if (line) out.push(line);
  }
  return out;
}

/** WinAnsi-safe text for the standard fonts. */
function ansi(s: string) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•▪◦]/g, '-')
    .replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, '');
}

export interface RenderBlock {
  heading?: string;
  text?: string;
  bullets?: string[];
}

export async function renderPdf(title: string, subtitle: string | null, blocks: RenderBlock[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(ansi(title));
  pdf.setProducer('ApplyFlux');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 56;
  let page = pdf.addPage([595.28, 841.89]);
  const width = page.getWidth() - margin * 2;
  let y = page.getHeight() - margin;
  const ensure = (h: number) => {
    if (y - h < margin) {
      page = pdf.addPage([595.28, 841.89]);
      y = page.getHeight() - margin;
    }
  };
  const draw = (s: string, f = regular, size = 10.5, color = rgb(0.12, 0.13, 0.16), indent = 0) => {
    for (const line of wrapLines(ansi(s), f, size, width - indent)) {
      ensure(size * 1.45);
      if (line) page.drawText(line, { x: margin + indent, y: y - size, size, font: f, color });
      y -= size * 1.45;
    }
  };
  draw(title, bold, 18);
  if (subtitle) draw(subtitle, regular, 10, rgb(0.35, 0.37, 0.42));
  y -= 8;
  for (const b of blocks) {
    if (b.heading) {
      y -= 6;
      draw(b.heading.toUpperCase(), bold, 10, rgb(0.27, 0.22, 0.75));
      y -= 2;
    }
    if (b.text) draw(b.text);
    for (const bullet of b.bullets ?? []) draw(`-  ${bullet}`, regular, 10.5, rgb(0.12, 0.13, 0.16), 8);
    y -= 4;
  }
  return Buffer.from(await pdf.save());
}
