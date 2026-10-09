import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BadgeCheck,
  Bot,
  Check,
  ChevronDown,
  FileSearch,
  FileText,
  Fingerprint,
  Hand,
  Layers,
  Lock,
  PauseCircle,
  ScanText,
  ShieldCheck,
  Sparkles,
  Target,
  Upload,
  Wand2,
} from 'lucide-react';
import { buttonVariants, Card, Badge, Skeleton } from '@/components/ui';
import { usePlans, usePlatforms } from '@/lib/queries';
import { cn, money } from '@/lib/utils';
import { STATE_LABELS } from '@applyflux/shared';

function Section({ id, eyebrow, title, intro, children, className }: { id?: string; eyebrow: string; title: React.ReactNode; intro?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={cn('scroll-mt-20 px-4 py-20 sm:px-6 sm:py-24', className)}>
      <div className="mx-auto max-w-7xl">
        <div className="mx-auto max-w-2xl text-center">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-ink">{eyebrow}</div>
          <h2 className="mt-3 text-3xl font-extrabold sm:text-4xl">{title}</h2>
          {intro && <p className="mt-4 text-base text-muted sm:text-lg">{intro}</p>}
        </div>
        <div className="mt-14">{children}</div>
      </div>
    </section>
  );
}

/** A static product illustration built from real UI states (no invented numbers). */
function HeroPreview() {
  const rows: Array<{ company: string; title: string; state: keyof typeof STATE_LABELS; step: string; p: number }> = [
    { company: 'Your next employer', title: 'Senior Product Designer', state: 'IN_PROGRESS', step: 'Filling step 2 of 3', p: 62 },
    { company: 'A company you shortlisted', title: 'Frontend Engineer', state: 'AWAITING_HUMAN_VERIFICATION', step: 'Waiting for you to complete a CAPTCHA', p: 80 },
    { company: 'A remote-first startup', title: 'Data Analyst', state: 'SUBMITTED', step: 'Confirmation page detected', p: 100 },
  ];
  const tone: Record<string, string> = { IN_PROGRESS: 'progress', AWAITING_HUMAN_VERIFICATION: 'warning', SUBMITTED: 'success' };
  return (
    <div className="relative mx-auto mt-16 max-w-5xl">
      <div className="absolute -inset-x-10 -top-10 bottom-0 -z-10 rounded-[40px] gradient-brand opacity-20 blur-3xl" />
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line bg-elevated px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-danger/70" />
          <span className="h-3 w-3 rounded-full bg-warning/70" />
          <span className="h-3 w-3 rounded-full bg-success/70" />
          <span className="ml-3 text-xs text-muted">Auto Apply Control Center — illustration</span>
        </div>
        <div className="grid gap-4 p-5 md:grid-cols-[1fr_1.4fr]">
          <div className="space-y-3">
            <div className="rounded-2xl border border-line p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">Mode</div>
              <div className="mt-2 flex gap-2">
                {['Review', 'Assisted', 'Auto'].map((m, i) => (
                  <span key={m} className={cn('rounded-lg px-3 py-1.5 text-xs font-semibold', i === 1 ? 'gradient-brand text-white' : 'bg-elevated text-muted')}>
                    {m}
                  </span>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-line p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Hand className="h-4 w-4 text-warning" /> Needs you
              </div>
              <p className="mt-1 text-xs text-muted">ApplyFlux pauses for CAPTCHAs, sign-ins and any question it can't answer from your verified profile.</p>
            </div>
            <div className="rounded-2xl border border-line p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <BadgeCheck className="h-4 w-4 text-success" /> Verified submissions
              </div>
              <p className="mt-1 text-xs text-muted">"Submitted" only when a confirmation is detected. Everything else is labelled unverified.</p>
            </div>
          </div>
          <div className="space-y-3">
            {rows.map((r) => (
              <div key={r.title} className="rounded-2xl border border-line p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{r.title}</div>
                    <div className="truncate text-xs text-muted">{r.company}</div>
                  </div>
                  <Badge tone={tone[r.state] as 'progress'}>{STATE_LABELS[r.state]}</Badge>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full gradient-brand" style={{ width: `${r.p}%` }} />
                </div>
                <div className="mt-2 text-xs text-muted">{r.step}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

const FAQ = [
  ['Does ApplyFlux bypass CAPTCHAs or bot protection?', 'No. ApplyFlux never solves, bypasses or outsources a CAPTCHA. When one appears, the application pauses, your filled-in progress is preserved, and you complete the check yourself in the tab. ApplyFlux resumes only when the page shows the check is actually complete.'],
  ['Will it make things up on my applications?', 'No. Answers come from facts you have verified in your profile and answers you have approved. Questions about work authorisation, sponsorship, demographics and similar topics are never answered by AI — they need your saved answer. AI drafts for open-ended questions are checked for unsupported claims and flagged for your review.'],
  ['Which sites does it work on?', 'See the Platforms page for the honest compatibility matrix. Greenhouse, Lever, Ashby, Workday and iCIMS forms are supported for filling; automatic submission is enabled per platform only after it has been validated. LinkedIn is not automated because its terms prohibit it — ApplyFlux tracks those applications and you apply manually.'],
  ['What do Review, Assisted and Auto modes mean?', 'Review fills the form and leaves it for you to inspect and submit. Assisted automates supported steps and pauses for anything missing, ambiguous or that needs confirmation. Auto submits eligible applications on supported platforms after you have given explicit authorisation and verified your profile.'],
  ['How do you count my usage?', 'An application counts only when ApplyFlux actually submits it. Failed, skipped and cancelled attempts are never charged, and retries can never charge twice.'],
  ['Can I export or delete my data?', 'Yes. Account & Privacy lets you download everything as JSON and permanently delete your account, documents and history.'],
];

export function Landing() {
  const { data: plans, isLoading: plansLoading } = usePlans();
  const { data: platforms } = usePlatforms();
  const [open, setOpen] = React.useState<number | null>(0);
  return (
    <main>
      {/* Hero */}
      <section className="relative overflow-hidden px-4 pb-20 pt-16 sm:px-6 sm:pt-24">
        <div className="grid-bg absolute inset-0 -z-10 opacity-60 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
        <div className="mx-auto max-w-4xl text-center animate-fade-up">
          <Badge tone="info" className="px-3 py-1">
            <Sparkles className="h-3.5 w-3.5" /> AI job applications, with you in control
          </Badge>
          <h1 className="mt-6 text-4xl font-extrabold leading-[1.05] sm:text-6xl">
            One profile. Every opportunity.
            <br />
            <span className="gradient-text">Applications on autopilot.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted">
            Upload your resume once. ApplyFlux builds a verified candidate profile, finds roles that fit, fills application forms accurately, and tracks every outcome — pausing for you whenever a human should decide.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/signup" className={buttonVariants({ size: 'lg' })}>
              Get started <ArrowRight className="h-4 w-4" />
            </Link>
            <a href="#how" className={buttonVariants({ size: 'lg', variant: 'secondary' })}>
              See how it works
            </a>
          </div>
          <p className="mt-4 text-xs text-muted">No credit card needed for the Starter plan.</p>
        </div>
        <HeroPreview />
      </section>

      {/* How it works */}
      <Section id="how" eyebrow="How it works" title="From resume to submitted — in four steps" intro="ApplyFlux turns the repetitive parts of job hunting into a reliable workflow you supervise.">
        <div className="grid gap-5 md:grid-cols-4">
          {[
            { icon: Upload, t: 'Upload once', d: 'PDF or DOCX. ApplyFlux extracts your history, education and skills into an editable profile.' },
            { icon: Fingerprint, t: 'Verify your facts', d: 'Confirm what is true. Only verified facts and approved answers are ever typed into a form.' },
            { icon: Target, t: 'Match & queue', d: 'Pull roles from company job boards, see a transparent match score, and queue the ones you want.' },
            { icon: Bot, t: 'Apply & track', d: 'The ApplyFlux Agent fills each form in your browser, pauses when needed and records proof of submission.' },
          ].map((s, i) => (
            <Card key={s.t} className="relative p-6">
              <div className="absolute right-5 top-5 font-display text-4xl font-extrabold text-line">{i + 1}</div>
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-soft text-brand-ink">
                <s.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-5 text-lg font-bold">{s.t}</h3>
              <p className="mt-2 text-sm text-muted">{s.d}</p>
            </Card>
          ))}
        </div>
      </Section>

      {/* Features */}
      <Section id="features" eyebrow="Features" title="Everything an application needs — nothing invented" className="bg-surface">
        <div className="grid gap-5 md:grid-cols-3">
          {[
            { icon: ScanText, t: 'Resume intelligence', d: 'Extracts contact details, roles, dates, education and skills, flags contradictions and gaps, and keeps resume-sourced facts separate from what you confirmed.' },
            { icon: Layers, t: 'Universal form intelligence', d: 'Understands labels, ARIA, autocomplete hints and structure — text, selects, searchable dropdowns, radios, checkboxes, uploads, repeating work history and multi-step flows.' },
            { icon: Target, t: 'Smart Match', d: 'A transparent score with matching skills, missing requirements and concerns like sponsorship statements, seniority gaps or salary below your floor.' },
            { icon: Wand2, t: 'Resume & cover letter studio', d: 'Gap analysis against each job, grounded tailoring that never adds skills you lack, and cover letters you edit and approve before use.' },
            { icon: PauseCircle, t: 'Human verification built in', d: 'CAPTCHAs, sign-ins and MFA pause only the affected application, preserve progress, and resume on real evidence — with bounded retries.' },
            { icon: BadgeCheck, t: 'Proof, not guesses', d: 'Every application has a timeline. "Submitted" requires confirmation evidence; otherwise it is clearly marked unverified for you to check.' },
          ].map((f) => (
            <div key={f.t} className="rounded-2xl border border-line bg-bg/40 p-6 transition hover:-translate-y-0.5 hover:shadow-card">
              <f.icon className="h-6 w-6 text-brand-ink" />
              <h3 className="mt-4 text-lg font-bold">{f.t}</h3>
              <p className="mt-2 text-sm text-muted">{f.d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Modes */}
      <Section eyebrow="Automation modes" title="You decide how much ApplyFlux does" intro="Switch modes any time. Start, pause, resume or stop automation instantly — even mid-application.">
        <div className="grid gap-5 md:grid-cols-3">
          {[
            { t: 'Review', d: 'ApplyFlux fills the form and stops. You inspect every field and click submit yourself.', b: 'Most control' },
            { t: 'Assisted', d: 'Supported steps are automated; anything missing, ambiguous or needing confirmation waits for you.', b: 'Recommended' },
            { t: 'Auto', d: 'With your explicit authorisation and a verified profile, eligible applications on validated platforms are submitted for you.', b: 'Most automated' },
          ].map((m, i) => (
            <Card key={m.t} className={cn('p-6', i === 1 && 'ring-2 ring-brand/40')}>
              <Badge tone={i === 1 ? 'info' : 'neutral'}>{m.b}</Badge>
              <h3 className="mt-4 text-xl font-bold">{m.t} Mode</h3>
              <p className="mt-2 text-sm text-muted">{m.d}</p>
            </Card>
          ))}
        </div>
      </Section>

      {/* Platforms */}
      <Section id="platforms" eyebrow="Supported platforms" title="Honest about where automation works" intro="Each platform has its own adapter. Automatic submission is switched on per platform only after validation." className="bg-surface">
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="px-5 py-3">Platform</th>
                <th className="px-5 py-3">Form filling</th>
                <th className="px-5 py-3">Multi-step</th>
                <th className="px-5 py-3">Auto-submit</th>
                <th className="px-5 py-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {(platforms ?? []).filter((p) => p.id !== 'sandbox').map((p) => (
                <tr key={p.id} className="border-b border-line/60 last:border-0">
                  <td className="px-5 py-3 font-semibold">{p.name}</td>
                  <td className="px-5 py-3">{p.autofill ? <Check className="h-4 w-4 text-success" aria-label="Yes" /> : <span className="text-muted">Manual</span>}</td>
                  <td className="px-5 py-3">{p.multiStep ? <Check className="h-4 w-4 text-success" aria-label="Yes" /> : <span className="text-muted">—</span>}</td>
                  <td className="px-5 py-3">{p.autoSubmit ? <Check className="h-4 w-4 text-success" aria-label="Yes" /> : <span className="text-muted">You submit</span>}</td>
                  <td className="px-5 py-3 text-xs text-muted">{p.restriction ?? (p.testStatus === 'tested_fixture' ? 'Validated against representative form markup' : '')}</td>
                </tr>
              ))}
              {!platforms && (
                <tr>
                  <td colSpan={5} className="p-5">
                    <Skeleton className="h-24" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
        <p className="mt-4 text-center text-sm text-muted">
          <Link to="/platforms" className="font-semibold text-brand-ink hover:underline">
            Full compatibility details →
          </Link>
        </p>
      </Section>

      {/* Security */}
      <Section eyebrow="Security & privacy" title="Built to be trusted with your career">
        <div className="grid gap-5 md:grid-cols-4">
          {[
            { icon: Lock, t: 'Your data, isolated', d: 'Row-level security on every table and private document storage scoped to your account.' },
            { icon: ShieldCheck, t: 'No bypassing', d: 'No CAPTCHA solving, no stealth, no evasion. Restricted platforms get a manual path.' },
            { icon: FileSearch, t: 'Minimal access', d: 'The extension only opens pages you queued and asks for site access when you choose.' },
            { icon: FileText, t: 'Export & delete', d: 'Download everything or delete your account and files permanently, any time.' },
          ].map((s) => (
            <div key={s.t} className="text-center">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand-soft text-brand-ink">
                <s.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 font-bold">{s.t}</h3>
              <p className="mt-2 text-sm text-muted">{s.d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Pricing */}
      <Section id="pricing" eyebrow="Pricing" title="Plans" intro="Limits shown are the plans configured on this ApplyFlux deployment." className="bg-surface">
        <div className="mx-auto grid max-w-4xl gap-5 md:grid-cols-2">
          {plansLoading && [0, 1].map((i) => <Skeleton key={i} className="h-80 rounded-3xl" />)}
          {(plans ?? []).map((p, i) => (
            <Card key={p.id} className={cn('flex flex-col p-7', i === 1 && 'ring-2 ring-brand/40')}>
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold">{p.name}</h3>
                {p.auto_mode_allowed && <Badge tone="info">Auto Mode</Badge>}
              </div>
              <p className="mt-2 text-sm text-muted">{p.description}</p>
              <div className="mt-5 font-display text-3xl font-extrabold">
                {p.price_cents == null ? <span className="text-xl text-muted">Pricing not yet published</span> : <>{money(p.price_cents / 100, p.currency)}<span className="text-base font-medium text-muted">/{p.billing_interval}</span></>}
              </div>
              <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-success" /> {p.monthly_application_limit} applications / month ({p.daily_application_limit}/day)</li>
                <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-success" /> {p.monthly_ai_generations} AI drafts / month</li>
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-success" /> {f}</li>
                ))}
              </ul>
              <Link to="/signup" className={cn(buttonVariants({ variant: i === 1 ? 'primary' : 'secondary' }), 'mt-7')}>
                Get started
              </Link>
            </Card>
          ))}
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq" eyebrow="FAQ" title="Questions, answered plainly">
        <div className="mx-auto max-w-3xl divide-y divide-line rounded-3xl border border-line bg-surface">
          {FAQ.map(([q, a], i) => (
            <div key={q}>
              <button className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left font-semibold" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                {q}
                <ChevronDown className={cn('h-5 w-5 shrink-0 text-muted transition', open === i && 'rotate-180')} />
              </button>
              {open === i && <p className="px-6 pb-5 text-sm leading-relaxed text-muted">{a}</p>}
            </div>
          ))}
        </div>
      </Section>

      <section className="px-4 pb-24 sm:px-6">
        <div className="mx-auto max-w-5xl overflow-hidden rounded-[32px] gradient-brand p-10 text-center text-white shadow-glow sm:p-14">
          <h2 className="text-3xl font-extrabold sm:text-4xl">Spend your time on interviews, not forms.</h2>
          <p className="mx-auto mt-3 max-w-xl text-white/85">Set up your profile in minutes and run a safe test application in the ApplyFlux Sandbox before anything goes to a real employer.</p>
          <Link to="/signup" className={cn(buttonVariants({ size: 'lg', variant: 'secondary' }), 'mt-8 border-0 bg-white text-[#2b2370] hover:bg-white/90')}>
            Create your free account <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </main>
  );
}
