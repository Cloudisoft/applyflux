/** DOM helpers that work identically in Chrome content scripts and jsdom. */

export type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function cleanText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').replace(/\s*[*✱]+\s*$/, '').trim();
}

/** Rendered text only (innerText skips hidden helper copy in real browsers; textContent elsewhere). */
export function renderedText(el: Element): string {
  const inner = (el as HTMLElement).innerText;
  return cleanText(typeof inner === 'string' && hasLayout(el.ownerDocument) ? inner.split('\n')[0] : el.textContent);
}

function hasLayout(doc: Document): boolean {
  const r = doc.documentElement.getBoundingClientRect?.();
  return !!r && (r.width > 0 || r.height > 0);
}

export function isVisible(el: Element): boolean {
  if (!(el instanceof el.ownerDocument.defaultView!.HTMLElement)) return true;
  const html = el as HTMLElement;
  if (html.hidden || (html instanceof el.ownerDocument.defaultView!.HTMLInputElement && html.type === 'hidden')) return false;
  const win = el.ownerDocument.defaultView!;
  for (let n: Element | null = el; n; n = n.parentElement) {
    if ((n as HTMLElement).hidden) return false;
    if (n.getAttribute('aria-hidden') === 'true') return false;
    const cs = win.getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  }
  if (hasLayout(el.ownerDocument)) {
    const rects = html.getClientRects();
    // File inputs are commonly visually hidden behind a styled button; they still count.
    if (rects.length === 0 && !(html instanceof win.HTMLInputElement && html.type === 'file')) return false;
  }
  return true;
}

function textOfIds(doc: Document, ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent ?? '')
    .join(' ');
}

/** Button-ish captions that name an action, not the field ("Attach", "Choose file"). */
const GENERIC_LABEL = /^(attach|upload|choose( a)? file|browse|select file|drop files? here|or|enter manually)$/i;

/** The human label of a control, using accessible-name rules first and DOM context last. */
export function labelOf(el: Element): string {
  const raw = rawLabelOf(el);
  if (!GENERIC_LABEL.test(raw)) return raw;
  const group = el.closest('[role="group"][aria-labelledby], fieldset');
  if (group) {
    const ids = group.getAttribute('aria-labelledby');
    const t = cleanText(ids ? textOfIds(el.ownerDocument, ids) : group.querySelector('legend')?.textContent);
    if (t) return t;
  }
  return humanize(el.getAttribute('name') || el.getAttribute('id') || raw);
}

function rawLabelOf(el: Element): string {
  const doc = el.ownerDocument;
  const aria = el.getAttribute('aria-labelledby');
  if (aria) {
    const t = cleanText(textOfIds(doc, aria));
    if (t) return t;
  }
  const al = el.getAttribute('aria-label');
  if (al && cleanText(al)) return cleanText(al);
  const id = el.getAttribute('id');
  if (id) {
    const lab = doc.querySelector(`label[for="${cssEscape(id)}"]`);
    if (lab) {
      const t = labelText(lab);
      if (t) return t;
    }
  }
  const wrapping = el.closest('label');
  if (wrapping) {
    const t = labelText(wrapping, el);
    if (t) return t;
  }
  // Radio / checkbox groups: the fieldset legend or group label names the question.
  const group = el.closest('fieldset, [role="group"], [role="radiogroup"]');
  if (group) {
    const legend = group.querySelector('legend');
    const gl = group.getAttribute('aria-labelledby');
    const t = cleanText(legend?.textContent || (gl ? textOfIds(doc, gl) : '') || group.getAttribute('aria-label'));
    if (t) return t;
  }
  // Nearest text in a container that holds only this control (never a neighbour's label).
  const name = el.getAttribute('name');
  let node: Element | null = el.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const controls = Array.from(node.querySelectorAll('input:not([type="hidden"]), select, textarea')).filter(
      (c) => c === el || !name || c.getAttribute('name') !== name,
    );
    if (controls.length > 1) break;
    const heading = Array.from(node.querySelectorAll('label, legend, .label, .question, h3, h4, span, p, div')).find(
      (h) => !h.contains(el) && !h.querySelector('input, select, textarea') && cleanText(h.textContent).length > 1,
    );
    if (heading) {
      const t = renderedText(heading);
      if (t.length < 300) return t;
    }
  }
  const ph = el.getAttribute('placeholder');
  if (ph) return cleanText(ph);
  return humanize(name || id || '');
}

function labelText(label: Element, exclude?: Element): string {
  const clone = label.cloneNode(true) as Element;
  clone.querySelectorAll('input, select, textarea, [aria-hidden="true"], .visually-hidden-required').forEach((n) => {
    if (!exclude || n !== exclude) n.remove();
  });
  return cleanText(clone.textContent);
}

export function humanize(name: string): string {
  return name
    .replace(/\[\]$/, '')
    .replace(/[\[\]_.-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

export function cssEscape(s: string): string {
  const w = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (w?.escape) return w.escape(s);
  return s.replace(/["\\\]\[#.:>+~*^$|=()' ]/g, '\\$&');
}

export function isRequired(el: Element): boolean {
  if ((el as HTMLInputElement).required) return true;
  if (el.getAttribute('aria-required') === 'true') return true;
  const group = el.closest('fieldset, [role="radiogroup"], [role="group"]');
  if (group?.getAttribute('aria-required') === 'true' || group?.hasAttribute('data-required')) return true;
  const id = el.getAttribute('id');
  const lab = id ? el.ownerDocument.querySelector(`label[for="${cssEscape(id)}"]`) : el.closest('label');
  const text = lab?.textContent ?? '';
  return /\*\s*$/.test(text.trim()) || !!lab?.querySelector('.required, abbr[title="required"]');
}

/** Set a value on a (possibly framework-controlled) input and fire the events frameworks listen for. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const win = el.ownerDocument.defaultView!;
  const proto =
    el instanceof win.HTMLTextAreaElement
      ? win.HTMLTextAreaElement.prototype
      : el instanceof win.HTMLSelectElement
        ? win.HTMLSelectElement.prototype
        : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  el.focus?.();
  if (setter) setter.call(el, value);
  else (el as HTMLInputElement).value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  el.dispatchEvent(new win.Event('blur', { bubbles: true }));
}

export function click(el: Element): void {
  const win = el.ownerDocument.defaultView!;
  (el as HTMLElement).focus?.();
  el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
  (el as HTMLElement).click();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 3000, intervalMs = 50): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(intervalMs);
  }
}

export function visibleText(root: ParentNode): string {
  const el = root as HTMLElement;
  const raw = (el as HTMLElement).innerText ?? (el as Element).textContent ?? '';
  return raw.replace(/\s+/g, ' ').trim();
}

/** Find a visible button-like element whose text matches. */
export function findButton(root: ParentNode, patterns: RegExp[], exclude: RegExp[] = []): HTMLElement | null {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"], a.button, a.btn'),
  );
  for (const re of patterns) {
    const hit = candidates.find((b) => {
      const t = cleanText(b.textContent || (b as HTMLInputElement).value || b.getAttribute('aria-label'));
      return re.test(t) && !exclude.some((x) => x.test(t)) && isVisible(b) && !(b as HTMLButtonElement).disabled;
    });
    if (hit) return hit;
  }
  return null;
}
