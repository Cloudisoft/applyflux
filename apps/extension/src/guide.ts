/**
 * On-page guidance for moments that need the person: a banner at the top of the tab and a highlight
 * ring around the verification widget. Purely visual: it never clicks, types into or alters a challenge.
 * Rendered in a closed shadow root so the site's CSS cannot break it (and it cannot affect the site).
 */
let host: HTMLDivElement | null = null;
let ring: HTMLDivElement | null = null;
let timer: number | undefined;

function target(): Element | null {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 20 && r.height > 20 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const candidates = [
    ...Array.from(document.querySelectorAll('iframe[src*="/recaptcha/"][src*="bframe"], iframe[src*="hcaptcha"][src*="challenge"]')),
    ...Array.from(document.querySelectorAll('[data-applyflux-captcha-popup]')),
    ...Array.from(document.querySelectorAll('iframe[src*="/recaptcha/"][src*="anchor"], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"]')),
    ...Array.from(document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [data-applyflux-captcha]')),
  ];
  return candidates.find(visible) ?? null;
}

export function showGuide(title: string, detail: string, opts: { highlightCaptcha?: boolean } = {}) {
  hideGuide();
  host = document.createElement('div');
  host.setAttribute('data-applyflux-guide', '');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .bar { position: fixed; z-index: 2147483647; top: 12px; left: 50%; transform: translateX(-50%); max-width: min(560px, calc(100vw - 24px));
        display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-radius: 14px; background: #1e1b4b; color: #fff;
        font: 14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.25); animation: in .25s ease-out; }
      .dot { flex: none; width: 10px; height: 10px; margin-top: 5px; border-radius: 50%; background: #f43f5e; box-shadow: 0 0 0 0 rgba(244,63,94,.7); animation: pulse 1.6s infinite; }
      b { display: block; font-weight: 600; } span { opacity: .85; }
      button { margin-left: auto; flex: none; background: transparent; border: 0; color: #c7d2fe; cursor: pointer; font: inherit; }
      .ring { position: fixed; z-index: 2147483646; pointer-events: none; border: 3px solid #f43f5e; border-radius: 12px; box-shadow: 0 0 0 6px rgba(244,63,94,.25); transition: all .2s; }
      @keyframes pulse { 70% { box-shadow: 0 0 0 10px rgba(244,63,94,0); } 100% { box-shadow: 0 0 0 0 rgba(244,63,94,0); } }
      @keyframes in { from { opacity: 0; transform: translate(-50%, -8px); } }
    </style>
    <div class="bar" role="status" aria-live="polite"><div class="dot"></div><div><b></b><span></span></div><button type="button" aria-label="Hide">Hide</button></div>`;
  root.querySelector('b')!.textContent = `ApplyFlux · ${title}`;
  root.querySelector('span')!.textContent = detail;
  root.querySelector('button')!.addEventListener('click', hideGuide);
  if (opts.highlightCaptcha) {
    ring = document.createElement('div');
    ring.className = 'ring';
    ring.hidden = true;
    root.appendChild(ring);
    const t = target();
    t?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const place = () => {
      const el = target();
      if (!ring) return;
      if (!el) return void (ring.hidden = true);
      const r = el.getBoundingClientRect();
      Object.assign(ring.style, { left: `${r.left - 8}px`, top: `${r.top - 8}px`, width: `${r.width + 16}px`, height: `${r.height + 16}px` });
      ring.hidden = false;
    };
    place();
    timer = window.setInterval(place, 400);
  }
  document.documentElement.appendChild(host);
}

export function hideGuide() {
  if (timer) window.clearInterval(timer);
  timer = undefined;
  host?.remove();
  host = null;
  ring = null;
}
