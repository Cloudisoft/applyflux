/** Phone and date normalisation used when a form demands a particular shape. */

export function digitsOnly(s: string): string {
  return s.replace(/\D+/g, '');
}

/**
 * Best-effort E.164-like normalisation. Keeps an explicit leading "+" country
 * code; otherwise returns the national digits untouched (we never guess a
 * country code).
 */
export function normalizePhone(raw: string | null | undefined): { e164: string | null; national: string; raw: string } {
  const r = (raw ?? '').trim();
  const digits = digitsOnly(r);
  if (!digits) return { e164: null, national: '', raw: r };
  if (r.startsWith('+')) return { e164: `+${digits}`, national: digits, raw: r };
  if (r.startsWith('00') && digits.length > 10) return { e164: `+${digits.slice(2)}`, national: digits.slice(2), raw: r };
  return { e164: null, national: digits, raw: r };
}

/** Format a phone value for a field: tel inputs get the original, digit-only patterns get digits. */
export function formatPhoneForField(raw: string, pattern?: string | null, maxLength?: number | null): string {
  const n = normalizePhone(raw);
  if (pattern && /^\[?\\?d|^\[0-9\]/.test(pattern)) return n.national;
  if (maxLength && raw.length > maxLength) return n.national.slice(-maxLength);
  return raw.trim();
}

export type DateFormat = 'iso' | 'month' | 'slash_month' | 'us' | 'eu' | 'year';

/** Converts a YYYY / YYYY-MM / YYYY-MM-DD value into the format an input expects. */
export function formatDateForField(value: string, format: DateFormat = 'iso'): string {
  const [y, m = '01', d = '01'] = value.split('-');
  switch (format) {
    case 'month':
      return `${y}-${m}`;
    case 'slash_month':
      return `${m}/${y}`;
    case 'us':
      return `${m}/${d}/${y}`;
    case 'eu':
      return `${d}/${m}/${y}`;
    case 'year':
      return y;
    default:
      return `${y}-${m}-${d}`;
  }
}

/** Infer a date format from an input's type / placeholder. */
export function inferDateFormat(type: string, placeholder: string): DateFormat {
  if (type === 'month') return 'month';
  if (type === 'date') return 'iso';
  const p = placeholder.toLowerCase();
  if (/mm\s*\/\s*dd\s*\/\s*yyyy/.test(p)) return 'us';
  if (/dd\s*\/\s*mm\s*\/\s*yyyy/.test(p)) return 'eu';
  if (/^yyyy$/.test(p.trim())) return 'year';
  if (/^mm\s*\/\s*yyyy$/.test(p.trim())) return 'slash_month';
  if (/yyyy-mm$/.test(p)) return 'month';
  return 'iso';
}

/** Parse loose resume dates ("Jan 2020", "2019", "03/2021", "Present"). */
export function parseLooseDate(s: string): string | null | 'present' {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  if (/^(present|current|now|today|ongoing)$/.test(t)) return 'present';
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let m = t.match(/^([a-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const idx = months.indexOf(m[1].slice(0, 3));
    if (idx >= 0) return `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
  }
  m = t.match(/^(\d{1,2})\s*[/.-]\s*(\d{4})$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{4})\s*[/.-]\s*(\d{1,2})$/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = t.match(/^(\d{4})$/);
  if (m) return m[1];
  return null;
}
