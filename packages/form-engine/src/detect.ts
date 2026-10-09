import type { FieldKind } from '@applyflux/shared';
import { cleanText, isRequired, isVisible, labelOf } from './dom';
import type { DetectedField } from './types';

const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'search', 'password']);

const CAPTCHA_FIELD = /recaptcha|hcaptcha|turnstile|captcha/i;

function inputKind(el: HTMLInputElement): FieldKind | null {
  const t = (el.getAttribute('type') || 'text').toLowerCase();
  if (SKIP_INPUT_TYPES.has(t)) return null;
  if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') return 'combobox';
  switch (t) {
    case 'email': return 'email';
    case 'tel': return 'tel';
    case 'url': return 'url';
    case 'number': return 'number';
    case 'date':
    case 'month': return 'date';
    case 'radio': return 'radio';
    case 'checkbox': return 'checkbox';
    case 'file': return 'file';
    default: return 'text';
  }
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

/** Section containers that repeat for each job / school. Adapters may add selectors. */
export const DEFAULT_GROUP_SELECTORS = ['[data-repeat-group]', '[data-automation-id*="workExperience"]', '[data-automation-id*="education"]', 'fieldset.repeat-group'];

function groupInfo(el: Element, selectors: string[]): { section: 'experience' | 'education' | null; index?: number } {
  const container = el.closest(selectors.join(','));
  if (!container) return { section: null };
  const hint = `${container.getAttribute('data-repeat-group') ?? ''} ${container.getAttribute('data-automation-id') ?? ''} ${container.className} ${cleanText(container.querySelector('legend, h3, h4')?.textContent)}`.toLowerCase();
  const section = /educat|school|degree/.test(hint) ? 'education' : /experien|employ|work|job/.test(hint) ? 'experience' : null;
  if (!section) return { section: null };
  const parent = container.parentElement;
  const siblings = parent
    ? Array.from(parent.children).filter((c) => c.matches(selectors.join(',')) && (c.getAttribute('data-repeat-group') ?? '') === (container.getAttribute('data-repeat-group') ?? ''))
    : [container];
  return { section, index: Math.max(0, siblings.indexOf(container)) };
}

export interface DetectOptions {
  groupSelectors?: string[];
  /** Restrict detection to a subtree (the application form). */
  root?: ParentNode;
}

/** Discover every visible, fillable control in the form. */
export function detectFields(doc: Document, opts: DetectOptions = {}): DetectedField[] {
  const root = opts.root ?? doc;
  const selectors = [...DEFAULT_GROUP_SELECTORS, ...(opts.groupSelectors ?? [])];
  const out: DetectedField[] = [];
  const seenGroups = new Set<string>();
  const usedKeys = new Map<string, number>();
  const uniqueKey = (k: string) => {
    const n = usedKeys.get(k) ?? 0;
    usedKeys.set(k, n + 1);
    return n ? `${k}#${n}` : k;
  };

  const controls = Array.from(root.querySelectorAll<HTMLElement>('input, select, textarea'));
  for (const el of controls) {
    const name = el.getAttribute('name') ?? '';
    const id = el.getAttribute('id') ?? '';
    if (CAPTCHA_FIELD.test(name) || CAPTCHA_FIELD.test(id)) continue;
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) continue;

    let kind: FieldKind | null;
    if (el.tagName === 'SELECT') kind = 'select';
    else if (el.tagName === 'TEXTAREA') kind = 'textarea';
    else kind = inputKind(el as HTMLInputElement);
    if (!kind) continue;
    if (!isVisible(el)) continue;

    const gi = groupInfo(el, selectors);
    const base: Omit<DetectedField, 'key' | 'kind' | 'label' | 'currentValue'> = {
      required: isRequired(el),
      element: el,
      name: name || undefined,
      autocomplete: el.getAttribute('autocomplete') ?? undefined,
      placeholder: el.getAttribute('placeholder') ?? undefined,
      pattern: el.getAttribute('pattern'),
      maxLength: (el as HTMLInputElement).maxLength > 0 ? (el as HTMLInputElement).maxLength : null,
      inputType: el.getAttribute('type') ?? undefined,
      section: gi.section,
      groupIndex: gi.index,
      accept: el.getAttribute('accept'),
    };

    if (kind === 'radio' || kind === 'checkbox') {
      const groupName = name || id;
      const scope = el.closest('form') ?? doc;
      const named = name
        ? Array.from(scope.querySelectorAll<HTMLInputElement>(`input[type="${kind}"][name="${name.replace(/"/g, '\\"')}"]`))
        : [];
      const group = named.length ? named : [el as HTMLInputElement];
      if (kind === 'checkbox' && group.length === 1) {
        const label = labelOf(el);
        out.push({ ...base, key: uniqueKey(id || name || slug(label)), kind: 'checkbox', label, currentValue: (el as HTMLInputElement).checked ? 'true' : 'false' });
        continue;
      }
      if (seenGroups.has(`${kind}:${groupName}`)) continue;
      seenGroups.add(`${kind}:${groupName}`);
      const label = groupLabelOf(group);
      const options = group.map((g) => optionLabel(g));
      const checked = group.filter((g) => g.checked).map(optionLabel);
      out.push({
        ...base,
        required: base.required || group.some((g) => g.required),
        key: uniqueKey(groupName || slug(label)),
        kind: kind === 'radio' ? 'radio' : 'checkbox_group',
        label,
        group,
        options,
        currentValue: checked.join(', '),
      });
      continue;
    }

    const label = labelOf(el);
    const field: DetectedField = {
      ...base,
      key: uniqueKey(id || name || slug(label) || `field_${out.length}`),
      kind,
      label,
      currentValue: kind === 'file' ? ((el as HTMLInputElement).files?.length ? (el as HTMLInputElement).files![0].name : '') : (el as HTMLInputElement).value ?? '',
    };
    if (kind === 'select') {
      field.options = Array.from((el as HTMLSelectElement).options)
        .map((o) => cleanText(o.textContent))
        .filter((t) => t.length > 0);
      const sel = (el as HTMLSelectElement).selectedOptions?.[0];
      field.currentValue = sel && sel.value ? cleanText(sel.textContent) : '';
    }
    if (kind === 'combobox') {
      const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      const list = listId ? doc.getElementById(listId) : null;
      if (list) field.options = Array.from(list.querySelectorAll('[role="option"]')).map((o) => cleanText(o.textContent));
    }
    out.push(field);
  }
  return out;
}

/** Label of one radio/checkbox option (not the question). */
export function optionLabel(input: HTMLInputElement): string {
  const doc = input.ownerDocument;
  if (input.id) {
    const lab = doc.querySelector(`label[for="${input.id.replace(/"/g, '\\"')}"]`);
    if (lab) return cleanText(lab.textContent);
  }
  const wrap = input.closest('label');
  if (wrap) return cleanText(wrap.textContent);
  const al = input.getAttribute('aria-label');
  if (al) return cleanText(al);
  const next = input.nextSibling;
  if (next && next.textContent?.trim()) return cleanText(next.textContent);
  return input.value;
}

/** The question text for a radio / checkbox group: legend, ARIA group name, or the smallest container's heading. */
export function groupLabelOf(group: HTMLInputElement[]): string {
  const first = group[0];
  const doc = first.ownerDocument;
  const fs = first.closest('fieldset, [role="radiogroup"], [role="group"]');
  if (fs) {
    const ids = fs.getAttribute('aria-labelledby');
    const t = cleanText(
      fs.querySelector(':scope > legend')?.textContent ||
        (ids ? ids.split(/\s+/).map((i) => doc.getElementById(i)?.textContent ?? '').join(' ') : '') ||
        fs.getAttribute('aria-label'),
    );
    if (t) return t;
  }
  let node: Element | null = first.parentElement;
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    if (!group.every((g) => node!.contains(g))) continue;
    const optionTexts = new Set(group.map(optionLabel));
    const heading = Array.from(node.querySelectorAll('label, legend, .label, .question, h3, h4, p, span, div')).find((h) => {
      if (h.querySelector('input')) return false;
      const t = cleanText(h.textContent);
      return t.length > 1 && !optionTexts.has(t) && !group.some((g) => h.contains(g));
    });
    if (heading) return cleanText(heading.textContent);
  }
  return labelOf(first);
}
