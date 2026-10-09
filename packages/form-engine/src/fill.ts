import { matchOption, normalizeText, pickBooleanOption } from '@applyflux/shared';
import { click, isVisible, setNativeValue, sleep, waitFor, cleanText } from './dom';
import { optionLabel } from './detect';
import type { DetectedField, FileAttachment } from './types';

export interface FillOutcome {
  ok: boolean;
  value: string | null;
  reason?: string;
}

const truthy = (v: string) => /^(true|yes|y|1|on)$/i.test(v.trim());

/** Fill one field with a resolved value. Option-based fields only accept confident option matches. */
export async function fillField(field: DetectedField, value: string): Promise<FillOutcome> {
  const el = field.element;
  try {
    switch (field.kind) {
      case 'select': {
        const select = el as HTMLSelectElement;
        const opts = Array.from(select.options);
        const labels = opts.map((o) => cleanText(o.textContent));
        let m = matchOption(labels, value);
        if (!m && /^(yes|no|true|false)$/i.test(value)) {
          const b = pickBooleanOption(labels, truthy(value));
          if (b) m = { option: b, confidence: 0.9 };
        }
        if (!m) {
          const byValue = opts.find((o) => normalizeText(o.value) === normalizeText(value));
          if (byValue) m = { option: cleanText(byValue.textContent), confidence: 0.9 };
        }
        if (!m) return { ok: false, value: null, reason: `No option matches "${value}"` };
        const opt = opts[labels.indexOf(m.option)];
        setNativeValue(select, opt.value);
        return { ok: select.value === opt.value, value: m.option };
      }
      case 'radio': {
        const group = field.group ?? [el as HTMLInputElement];
        const labels = group.map(optionLabel);
        let chosen = matchOption(labels, value)?.option ?? null;
        if (!chosen && /^(yes|no|true|false)$/i.test(value)) chosen = pickBooleanOption(labels, truthy(value));
        if (!chosen) return { ok: false, value: null, reason: `No option matches "${value}"` };
        const input = group[labels.indexOf(chosen)];
        if (!input.checked) click(input);
        if (!input.checked) {
          input.checked = true;
          input.dispatchEvent(new (input.ownerDocument.defaultView!.Event)('change', { bubbles: true }));
        }
        return { ok: input.checked, value: chosen };
      }
      case 'checkbox': {
        const input = el as HTMLInputElement;
        const want = truthy(value);
        if (input.checked !== want) click(input);
        return { ok: input.checked === want, value: String(want) };
      }
      case 'checkbox_group': {
        const group = field.group ?? [];
        const labels = group.map(optionLabel);
        const wanted = value.split(/\s*[;|]\s*|\s*,\s*(?=[A-Z])/).filter(Boolean);
        const picked: string[] = [];
        for (const w of wanted) {
          const m = matchOption(labels, w);
          if (!m) return { ok: false, value: null, reason: `No option matches "${w}"` };
          const input = group[labels.indexOf(m.option)];
          if (!input.checked) click(input);
          picked.push(m.option);
        }
        return { ok: true, value: picked.join(', ') };
      }
      case 'combobox':
        return await fillCombobox(field, value);
      case 'file':
        return { ok: false, value: null, reason: 'Use attachFile for file inputs' };
      default: {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        let v = value;
        if (field.maxLength && v.length > field.maxLength) {
          return { ok: false, value: null, reason: `Answer exceeds the ${field.maxLength}-character limit` };
        }
        if (field.kind === 'number') v = v.replace(/[^\d.]/g, '');
        setNativeValue(input, v);
        return { ok: input.value === v, value: v, reason: input.value === v ? undefined : 'The page rejected the value' };
      }
    }
  } catch (e) {
    return { ok: false, value: null, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Searchable select: type to filter, then click the confident option match. */
async function fillCombobox(field: DetectedField, value: string): Promise<FillOutcome> {
  const input = field.element as HTMLInputElement;
  const doc = input.ownerDocument;
  click(input);
  setNativeValue(input, value);
  const listFor = () => {
    const id = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
    const list = id ? doc.getElementById(id) : null;
    const scope: ParentNode = list ?? doc;
    const opts = Array.from(scope.querySelectorAll<HTMLElement>('[role="option"]')).filter(isVisible);
    return opts.length ? opts : null;
  };
  const options = await waitFor(listFor, 2000);
  if (!options) return { ok: false, value: null, reason: 'No options appeared for this searchable field' };
  const labels = options.map((o) => cleanText(o.textContent));
  const m = matchOption(labels, value);
  if (!m) return { ok: false, value: null, reason: `No option matches "${value}"` };
  click(options[labels.indexOf(m.option)]);
  await sleep(50);
  return { ok: true, value: m.option };
}

/** Attach a file to an <input type=file> the way a user drop would. */
export function attachFile(field: DetectedField, file: FileAttachment): FillOutcome {
  const input = field.element as HTMLInputElement;
  const win = input.ownerDocument.defaultView! as Window & typeof globalThis;
  const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
  if (field.accept) {
    const ext = '.' + (file.fileName.split('.').pop() ?? '').toLowerCase();
    const accepted = field.accept.split(',').map((a) => a.trim().toLowerCase());
    const ok = accepted.some((a) => a === ext || a === file.mimeType || (a.endsWith('/*') && file.mimeType.startsWith(a.slice(0, -1))));
    if (!ok) return { ok: false, value: null, reason: `This field does not accept ${ext} files` };
  }
  const f = new win.File([bytes], file.fileName, { type: file.mimeType });
  try {
    const dt = new win.DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
  } catch {
    // jsdom has no DataTransfer; define a FileList-like for tests.
    Object.defineProperty(input, 'files', { configurable: true, value: Object.assign([f], { item: (i: number) => (i === 0 ? f : null) }) });
  }
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  return { ok: (input.files?.length ?? 0) > 0, value: file.fileName };
}
