import { BOT_CHALLENGE_PATTERNS } from '@applyflux/shared';
import { hasLayout, isVisible, visibleText } from './dom';

/**
 * Human-verification detection. ApplyFlux NEVER solves, bypasses or outsources
 * a challenge: detection exists only so automation can stop, preserve state,
 * and hand the tab to the person. "Resolved" requires positive evidence from
 * the page (a response token present and no visible challenge), never a click.
 */

export interface ChallengeState {
  present: boolean;
  /** Something the person must act on is on screen: an interstitial, an open image/puzzle challenge, or an unticked checkbox widget. */
  challengeVisible: boolean;
  /** An image/puzzle challenge (or full-page interstitial) is open right now. */
  popupVisible: boolean;
  /** A visible "I'm not a robot"-style checkbox widget is on the page. */
  widgetVisible: boolean;
  /** The provider's response token is populated (the person completed it, or an invisible check passed). */
  tokenPresent: boolean;
  provider: 'recaptcha' | 'hcaptcha' | 'turnstile' | 'interstitial' | 'generic' | null;
  /** The invisible kind (reCAPTCHA v3/Enterprise, invisible v2, hCaptcha invisible): it only shows a challenge, if ever, after submit. */
  invisible: boolean;
}

const IFRAME_PROVIDERS: Array<{ provider: ChallengeState['provider']; re: RegExp; popup?: RegExp }> = [
  { provider: 'recaptcha', re: /\/recaptcha\/(api2|enterprise)\/anchor|google\.com\/recaptcha/i, popup: /\/recaptcha\/(api2|enterprise)\/bframe/i },
  { provider: 'hcaptcha', re: /hcaptcha\.com/i, popup: /hcaptcha\.com.*(frame=challenge|#.*challenge)/i },
  { provider: 'turnstile', re: /challenges\.cloudflare\.com/i },
];
/** Iframe URLs of widgets that never show a checkbox (v3, Enterprise score-based, invisible v2, hCaptcha invisible). */
const INVISIBLE_SRC = /[?&#](size=invisible|frame=checkbox-invisible)|checkbox-invisible/i;

export function detectChallenge(doc: Document): ChallengeState {
  const none: ChallengeState = { present: false, challengeVisible: false, popupVisible: false, widgetVisible: false, tokenPresent: false, provider: null, invisible: false };

  // Full-page interstitials ("Just a moment...", "Verify you are human").
  const text = visibleText(doc.body).slice(0, 4000);
  const formless = doc.querySelectorAll('input:not([type=hidden]), select, textarea').length < 2;
  // "Just a moment..." is also ordinary loading text; only count it with a real Cloudflare signal.
  const cloudflare = /just a moment/i.test(doc.title) || !!doc.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, script[src*="/cdn-cgi/challenge-platform/"]');
  const matched = BOT_CHALLENGE_PATTERNS.filter((re) => re.test(text));
  const interstitial = matched.some((re) => !/just a moment/i.test(re.source)) || (matched.length > 0 && cloudflare);
  if (formless && interstitial && text.length < 1500) {
    return { present: true, challengeVisible: true, popupVisible: true, widgetVisible: false, tokenPresent: false, provider: 'interstitial', invisible: false };
  }

  let provider: ChallengeState['provider'] = null;
  let popupVisible = false;
  let widgetVisible = false;
  let invisible = false;
  for (const f of Array.from(doc.querySelectorAll('iframe'))) {
    const src = f.getAttribute('src') ?? '';
    for (const p of IFRAME_PROVIDERS) {
      if (p.popup?.test(src)) {
        provider = p.provider;
        if (isVisible(f) && !isOffscreen(f) && hasRealSize(f)) popupVisible = true;
      } else if (p.re.test(src)) {
        provider = provider ?? p.provider;
        if (INVISIBLE_SRC.test(src)) invisible = true;
        else if (isVisible(f) && !isOffscreen(f) && hasRealSize(f)) widgetVisible = true;
      }
    }
  }
  // The reCAPTCHA badge only exists for v3 and invisible v2.
  if (doc.querySelector('.grecaptcha-badge')) {
    provider = provider ?? 'recaptcha';
    invisible = true;
  }
  // Widget containers (present even before the iframe loads). data-applyflux-captcha marks sandbox mocks.
  for (const widget of Array.from(doc.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], [data-applyflux-captcha]'))) {
    provider =
      provider ??
      (widget.classList.contains('h-captcha') ? 'hcaptcha'
        : widget.classList.contains('cf-turnstile') ? 'turnstile'
        : widget.classList.contains('g-recaptcha') ? 'recaptcha'
        : (widget.getAttribute('data-applyflux-captcha') as ChallengeState['provider']) || 'generic');
    // Bound to a button (<button class="g-recaptcha" data-sitekey data-callback>) or declared invisible: runs on submit, shows nothing now.
    const boundToButton = widget.matches('button, input[type=submit], input[type=button], a');
    if (boundToButton || widget.getAttribute('data-size') === 'invisible') {
      invisible = true;
      continue;
    }
    // A container only counts as a checkbox when it is visible and actually renders something.
    if (isVisible(widget) && (widget.hasAttribute('data-applyflux-captcha') || widget.querySelector('iframe:not([src*="invisible"])'))) widgetVisible = true;
  }
  const popup = doc.querySelector('[data-applyflux-captcha-popup]');
  if (popup && isVisible(popup)) popupVisible = true;
  if (!provider) return none;

  const tokenFields = Array.from(
    doc.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
      'textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"], [name="applyflux-captcha-response"]',
    ),
  );
  const tokenPresent = tokenFields.some((t) => (t.value ?? '').trim().length > 0);

  return {
    present: true,
    challengeVisible: popupVisible || (widgetVisible && !tokenPresent),
    popupVisible,
    widgetVisible,
    tokenPresent,
    provider,
    invisible: invisible && !widgetVisible,
  };
}

function isOffscreen(el: Element): boolean {
  // reCAPTCHA parks its bframe container at top:-10000px when no challenge is shown.
  for (let n: Element | null = el; n; n = n.parentElement) {
    const style = (n as HTMLElement).style;
    if (style && (parseInt(style.top || '0', 10) < -1000 || parseInt(style.left || '0', 10) < -1000)) return true;
    if (style?.opacity === '0') return true;
  }
  return false;
}

/** Zero-size or tiny iframes are plumbing, not something a person can see. Without layout (tests), trust the size attributes. */
function hasRealSize(el: Element): boolean {
  if (!hasLayout(el.ownerDocument)) {
    const w = parseInt(el.getAttribute('width') ?? '', 10);
    const h = parseInt(el.getAttribute('height') ?? '', 10);
    return !((!Number.isNaN(w) && w < 30) || (!Number.isNaN(h) && h < 30));
  }
  const r = el.getBoundingClientRect();
  return r.width >= 30 && r.height >= 30;
}

/** A person must act on the page right now (the run pauses and asks them). Invisible checks never count until they open a challenge. */
export function challengeBlocking(c: ChallengeState): boolean {
  return c.present && (c.popupVisible || (c.widgetVisible && !c.tokenPresent));
}

/**
 * Whether the challenge stops ApplyFlux from filling the form at all. Only an open challenge/interstitial, or a checkbox
 * that locks the form (no fillable fields visible yet). Otherwise the form is filled first and the person ticks the
 * checkbox at submit time.
 */
export function challengeBlocksFilling(c: ChallengeState, formUsable: boolean): boolean {
  if (!c.present || (c.tokenPresent && !c.popupVisible)) return false;
  return c.popupVisible || (c.widgetVisible && !formUsable);
}

/** Positive evidence the person finished verification. */
export function challengeResolved(c: ChallengeState): boolean {
  return !c.present || (c.tokenPresent && !c.popupVisible);
}

export type WallKind = 'login_required' | 'mfa' | 'session_expired' | null;

/** Sign-in walls and MFA prompts: also handed to the person, never automated. */
export function detectAuthWall(doc: Document): WallKind {
  const text = visibleText(doc.body).toLowerCase().slice(0, 5000);
  const otp = doc.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="verification_code" i]');
  if ((otp && isVisible(otp)) || /enter (the )?(verification|security|6-digit) code|two-factor|2-step verification|multi-factor/.test(text)) return 'mfa';
  if (/session (has )?expired|you have been (signed|logged) out|please (sign|log) in again/.test(text)) return 'session_expired';
  const pwd = Array.from(doc.querySelectorAll('input[type="password"]')).filter(isVisible);
  const appFields = doc.querySelectorAll('input[type="file"], textarea').length;
  if (pwd.length && appFields === 0 && /sign in|log in|login|create (an )?account/.test(text)) return 'login_required';
  return null;
}
