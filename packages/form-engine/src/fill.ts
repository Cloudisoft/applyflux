import { normalizeText, pickOption } from '@applyflux/shared';
import { click, isVisible, setNativeValue, sleep, waitFor, cleanText } from './dom';
import { comboboxValue, optionLabel } from './detect';
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
        let m = pickOption(labels, value);
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
        if (field.choices?.length) {
          const labels = field.choices.map((b) => cleanText(b.textContent));
          const chosen = pickOption(labels, value)?.option ?? null;
          if (!chosen) return { ok: false, value: null, reason: `No option matches "${value}"` };
          click(field.choices[labels.indexOf(chosen)]);
          await sleep(50);
          return { ok: true, value: chosen };
        }
        const group = field.group ?? [el as HTMLInputElement];
        const labels = group.map(optionLabel);
        const chosen = pickOption(labels, value)?.option ?? null;
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
          const m = pickOption(labels, w);
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

const OPTION_SELECTOR = '[role="option"], [id*="-option-"], .select__option, [class*="__option" i]';

/** Options currently shown for a searchable select (react-select, ARIA listbox, Greenhouse/Ashby/Lever widgets). */
function menuOptions(input: HTMLInputElement): HTMLElement[] | null {
  const doc = input.ownerDocument;
  const id = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
  const scope: ParentNode = (id && doc.getElementById(id)) || doc;
  const opts = Array.from(scope.querySelectorAll<HTMLElement>(OPTION_SELECTOR)).filter(
    (o) => isVisible(o) && !o.querySelector(OPTION_SELECTOR) && !/(^|_)(no-options|loading)/i.test(o.className) && cleanText(o.textContent).length > 0,
  );
  return opts.length ? opts : null;
}

/** Open the menu the way a person does: react-select listens for mousedown on its control, others for focus/ArrowDown. */
function openMenu(input: HTMLInputElement) {
  const win = input.ownerDocument.defaultView!;
  const control = input.closest<HTMLElement>('[class*="control" i]') ?? input.parentElement;
  input.focus();
  for (const t of [control, input]) t?.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
}

function closeMenu(input: HTMLInputElement) {
  const win = input.ownerDocument.defaultView!;
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  input.blur();
}

/** Searchable select: open it, pick the option that means the answer; type to filter only for long or async lists. */
async function fillCombobox(field: DetectedField, value: string): Promise<FillOutcome> {
  const input = field.element as HTMLInputElement;
  // Already answered (by the person, a moment ago): never reopen it or type over their choice.
  const existing = comboboxValue(input).trim();
  if (existing && !/^(select|choose|please select|--)/i.test(existing)) return { ok: true, value: existing, reason: 'Kept the value already on the page' };
  const labelsOf = (opts: HTMLElement[]) => opts.map((o) => cleanText(o.textContent));
  openMenu(input);
  let options = await waitFor(() => menuOptions(input), 1500);
  let m = options ? pickOption(labelsOf(options), value) : null;
  if (!m) {
    // Long lists (countries, schools) and lists loaded as you type: filter by the answer's leading words.
    setNativeValue(input, value.split(/[,(]/)[0].trim().slice(0, 40));
    await sleep(150);
    options = await waitFor(() => menuOptions(input), 2500);
    m = options ? pickOption(labelsOf(options), value) : null;
  }
  if (!options || !m) {
    if (input.value) setNativeValue(input, '');
    closeMenu(input);
    return { ok: false, value: null, reason: options ? `No option matches "${value}"` : 'No options appeared for this searchable field' };
  }
  click(options[labelsOf(options).indexOf(m.option)]);
  await sleep(80);
  closeMenu(input);
  const shown = comboboxValue(input);
  return { ok: true, value: shown || m.option };
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
