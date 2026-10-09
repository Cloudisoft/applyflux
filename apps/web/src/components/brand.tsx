import * as React from 'react';
import { Moon, Sun } from 'lucide-react';
import { STATE_LABELS, STATE_TONES, type ApplicationState } from '@applyflux/shared';
import { Badge } from './ui';
import { cn } from '@/lib/utils';

/** ApplyFlux product mark. (Cloudisoft is shown as the parent brand in text; no Cloudisoft logo asset is bundled.) */
export function Logo({ className, withText = true, size = 32 }: { className?: string; withText?: boolean; size?: number }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <img src="/brand/applyflux-mark.svg" alt="" width={size} height={size} className="rounded-xl shadow-glow" />
      {withText && (
        <span className="leading-none">
          <span className="block font-display text-[17px] font-extrabold tracking-tight">ApplyFlux</span>
          <span className="mt-1 block text-[10px] font-medium uppercase tracking-[0.14em] text-muted">by Cloudisoft</span>
        </span>
      )}
    </span>
  );
}

export function StateBadge({ state, className }: { state: ApplicationState; className?: string }) {
  const tone = STATE_TONES[state];
  return (
    <Badge tone={tone} className={className}>
      {(state === 'IN_PROGRESS' || state === 'AWAITING_HUMAN_VERIFICATION') && <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-current" />}
      {STATE_LABELS[state]}
    </Badge>
  );
}

export function ScoreRing({ score, size = 44 }: { score: number | null | undefined; size?: number }) {
  const s = score ?? 0;
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const color = s >= 75 ? 'rgb(var(--success))' : s >= 50 ? 'rgb(var(--brand))' : s >= 30 ? 'rgb(var(--warning))' : 'rgb(var(--danger))';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-label={score == null ? 'Not scored' : `Match score ${s} of 100`} role="img">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgb(var(--line))" strokeWidth={5} fill="none" />
        {score != null && <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={5} fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - s / 100)} className="transition-all duration-700" />}
      </svg>
      <span className="absolute inset-0 grid place-items-center text-xs font-bold tabular-nums">{score == null ? '–' : s}</span>
    </div>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = React.useState(() => document.documentElement.classList.contains('dark'));
  return (
    <button
      type="button"
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle('dark', next);
        try {
          localStorage.setItem('af-theme', next ? 'dark' : 'light');
        } catch {
          /* storage unavailable */
        }
      }}
      className="grid h-9 w-9 place-items-center rounded-xl text-muted transition hover:bg-elevated hover:text-ink"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </button>
  );
}
