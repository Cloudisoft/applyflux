import { BOT_CHALLENGE_PATTERNS } from '@applyflux/shared';
import { isVisible, visibleText } from './dom';

/**
 * Human-verification detection. ApplyFlux NEVER solves, bypasses or outsources
 * a challenge: detection exists only so automation can stop, preserve state,
 * and hand the tab to the person. "Resolved" requires positive evidence from
 * the page (a response token present and no visible challenge), never a click.
 */

export interface ChallengeState {
  present: boolean;
  /** A challenge UI (checkbox widget, image grid, interstitial) is currently visible. */
  challengeVisible: boolean;
  /** The provider's response token is populated (the person completed it). */
  tokenPresent: boolean;
  provider: 'recaptcha' | 'hcaptcha' | 'turnstile' | 'interstitial' | 'generic' | null;
  /** True when the widget is the invisible kind that only appears on submit. */
  invisible: boolean;
}

const IFRAME_PROVIDERS: Array<{ provider: ChallengeState['provider']; re: RegExp; popup?: RegExp }> = [
  { provider: 'recaptcha', re: /\/recaptcha\/(api2|enterprise)\/anchor|google\.com\/recaptcha/i, popup: /\/recaptcha\/(api2|enterprise)\/bframe/i },
  { provider: 'hcaptcha', re: /hcaptcha\.com/i, popup: /hcaptcha\.com.*(challenge|frame=challenge)/i },
  { provider: 'turnstile', re: /challenges\.cloudflare\.com/i },
];

export function detectChallenge(doc: Document): ChallengeState {
  const none: ChallengeState = { present: false, challengeVisible: false, tokenPresent: false, provider: null, invisible: false };

  // Full-page interstitials ("Just a moment...", "Verify you are human").
  const text = visibleText(doc.body).slice(0, 4000);
  const formless = doc.querySelectorAll('input:not([type=hidden]), select, textarea').length < 2;
  if (formless && BOT_CHALLENGE_PATTERNS.some((re) => re.test(text))) {
    return { present: true, challengeVisible: true, tokenPresent: false, provider: 'interstitial', invisible: false };
  }

  const iframes = Array.from(doc.querySelectorAll('iframe'));
  let provider: ChallengeState['provider'] = null;
  let challengeVisible = false;
  let widgetVisible = false;
  for (const f of iframes) {
    const src = f.getAttribute('src') ?? '';
    for (const p of IFRAME_PROVIDERS) {
      if (p.popup?.test(src)) {
        provider = p.provider;
        if (isVisible(f) && !isOffscreen(f)) challengeVisible = true;
      } else if (p.re.test(src)) {
        provider = provider ?? p.provider;
        if (isVisible(f)) widgetVisible = true;
      }
    }
  }
  // Widget containers (present even before the iframe loads). data-applyflux-captcha marks sandbox mocks.
  const widget = doc.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], [data-applyflux-captcha]');
  if (widget) {
    provider =
      provider ??
      (widget.classList.contains('h-captcha') ? 'hcaptcha'
        : widget.classList.contains('cf-turnstile') ? 'turnstile'
        : widget.classList.contains('g-recaptcha') ? 'recaptcha'
        : (widget.getAttribute('data-applyflux-captcha') as ChallengeState['provider']) || 'generic');
    if (isVisible(widget)) widgetVisible = true;
    const popup = doc.querySelector('[data-applyflux-captcha-popup]');
    if (popup && isVisible(popup)) challengeVisible = true;
  }
  if (!provider) return none;

  const tokenFields = Array.from(
    doc.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
      'textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"], [name="applyflux-captcha-response"]',
    ),
  );
  const tokenPresent = tokenFields.some((t) => (t.value ?? '').trim().length > 0);
  const invisible = widget?.getAttribute('data-size') === 'invisible';

  return {
    present: true,
    challengeVisible: challengeVisible || (widgetVisible && !invisible && !tokenPresent),
    tokenPresent,
    provider,
    invisible,
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

/** The challenge blocks progress right now and a person must act. */
export function challengeBlocking(c: ChallengeState): boolean {
  return c.present && !c.tokenPresent && (c.challengeVisible || !c.invisible);
}

/** Positive evidence the person finished verification. */
export function challengeResolved(c: ChallengeState): boolean {
  return !c.present || (c.tokenPresent && !c.challengeVisible);
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
