import * as React from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {
  Bell,
  Bot,
  Briefcase,
  ChevronDown,
  FileText,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  Menu,
  MessageSquareText,
  PenSquare,
  Puzzle,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  User,
  Wand2,
  X,
} from 'lucide-react';
import { Logo, ThemeToggle } from '@/components/brand';
import { Badge, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useApplications, useAutomation, useMe, useNotifications, useRealtime } from '@/lib/queries';
import { focusExtensionTab } from '@/lib/extension';
import { cn, initials } from '@/lib/utils';

const NAV: Array<{ group: string; items: Array<{ to: string; label: string; icon: React.ElementType; end?: boolean }> }> = [
  {
    group: 'Workspace',
    items: [
      { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/app/automation', label: 'Control Center', icon: Bot },
      { to: '/app/applications', label: 'Applications', icon: ListChecks },
    ],
  },
  {
    group: 'Opportunities',
    items: [
      { to: '/app/jobs', label: 'Job Discovery', icon: Briefcase },
      { to: '/app/match', label: 'Smart Match', icon: Target },
    ],
  },
  {
    group: 'Your materials',
    items: [
      { to: '/app/profile', label: 'Candidate Profile', icon: User },
      { to: '/app/resumes', label: 'Resume Library', icon: FileText },
      { to: '/app/studio', label: 'Resume Studio', icon: Wand2 },
      { to: '/app/cover-letters', label: 'Cover Letters', icon: PenSquare },
      { to: '/app/answers', label: 'Saved Answers', icon: MessageSquareText },
    ],
  },
  {
    group: 'Settings',
    items: [
      { to: '/app/extension', label: 'Browser Extension', icon: Puzzle },
      { to: '/app/settings/automation', label: 'Automation Settings', icon: Settings },
      { to: '/app/settings/account', label: 'Account & Privacy', icon: ShieldCheck },
    ],
  },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data: me } = useMe();
  const setupDone = !!me?.account.onboardingCompletedAt;
  return (
    <nav className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-5" aria-label="Main">
      <Link to="/app" className="px-2" onClick={onNavigate}>
        <Logo />
      </Link>
      {!setupDone && (
        <Link to="/app/setup" onClick={onNavigate} className="mx-1 rounded-2xl gradient-brand p-4 text-white shadow-glow transition hover:brightness-110">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4" /> Finish setup
          </div>
          <p className="mt-1 text-xs text-white/80">A few steps until ApplyFlux can apply for you.</p>
        </Link>
      )}
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted/80">{g.group}</div>
          <ul className="space-y-0.5">
            {g.items.map((it) => (
              <li key={it.to}>
                <NavLink
                  to={it.to}
                  end={it.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn('flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition', isActive ? 'bg-brand-soft text-brand-ink' : 'text-muted hover:bg-elevated hover:text-ink')
                  }
                >
                  <it.icon className="h-[18px] w-[18px]" aria-hidden />
                  {it.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function RunPill() {
  const { data } = useAutomation();
  const status = data?.run?.status;
  if (!status) return null;
  return (
    <Link to="/app/automation" className={cn('hidden items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold sm:inline-flex', status === 'running' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning')}>
      <span className={cn('h-2 w-2 rounded-full bg-current', status === 'running' && 'animate-pulse-dot')} />
      {status === 'running' ? `Auto Apply running · ${data?.active.length ?? 0} active` : 'Auto Apply paused'}
    </Link>
  );
}

export function AppLayout() {
  const { session, loading, signOut } = useAuth();
  const [open, setOpen] = React.useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useRealtime();
  const { data: notes } = useNotifications();
  const { data: me } = useMe();

  if (loading)
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  if (!session) return <Navigate to={`/signin?next=${encodeURIComponent(loc.pathname)}`} replace />;
  const email = session.user.email ?? '';

  return (
    <div className="min-h-screen bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-surface lg:block">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-line bg-surface animate-fade-up">
            <button className="absolute right-3 top-4 rounded-lg p-1 text-muted" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="glass sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line px-4 sm:px-6">
          <button className="rounded-lg p-2 text-muted hover:bg-elevated lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex-1" />
          <RunPill />
          <ThemeToggle />
          <Link to="/app/notifications" className="relative grid h-9 w-9 place-items-center rounded-xl text-muted hover:bg-elevated hover:text-ink" aria-label={`Notifications${notes?.unread ? `, ${notes.unread} unread` : ''}`}>
            <Bell className="h-[18px] w-[18px]" />
            {!!notes?.unread && <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">{notes.unread > 9 ? '9+' : notes.unread}</span>}
          </Link>
          <Dropdown.Root>
            <Dropdown.Trigger className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-elevated" aria-label="Account menu">
              <span className="grid h-8 w-8 place-items-center rounded-full gradient-brand text-xs font-bold text-white">{initials(me?.account.displayName ?? email)}</span>
              <ChevronDown className="hidden h-4 w-4 text-muted sm:block" />
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content align="end" sideOffset={8} className="z-50 w-60 rounded-2xl border border-line bg-surface p-1.5 shadow-xl">
                <div className="px-3 py-2">
                  <div className="truncate text-sm font-semibold">{me?.account.displayName ?? 'Your account'}</div>
                  <div className="truncate text-xs text-muted">{email}</div>
                </div>
                <Dropdown.Separator className="my-1 h-px bg-line" />
                {[
                  { to: '/app/profile', label: 'Candidate profile', icon: User },
                  { to: '/app/settings/account', label: 'Account & privacy', icon: ShieldCheck },
                  { to: '/app/notifications', label: 'Notifications', icon: Mail },
                ].map((i) => (
                  <Dropdown.Item key={i.to} onSelect={() => nav(i.to)} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-elevated">
                    <i.icon className="h-4 w-4 text-muted" /> {i.label}
                  </Dropdown.Item>
                ))}
                <Dropdown.Separator className="my-1 h-px bg-line" />
                <Dropdown.Item
                  onSelect={async () => {
                    await signOut();
                    nav('/');
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger outline-none data-[highlighted]:bg-danger/10"
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
          {me && !me.aiConfigured && loc.pathname === '/app' && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-line bg-elevated px-4 py-2.5 text-xs text-muted">
              <Badge tone="neutral">Note</Badge> AI drafting isn't configured on this server, so cover letters and open-ended answers need your input. Everything else works.
            </div>
          )}
          <NeedsYouBanner />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Shown on every page while an application waits for a quick check from the person. */
function NeedsYouBanner() {
  const { data } = useApplications({ state: ['AWAITING_HUMAN_VERIFICATION'] });
  const waiting = data?.items ?? [];
  const nav = useNavigate();
  if (!waiting.length) return null;
  const first = waiting[0];
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
      <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warning" /></span>
      <span className="min-w-0 flex-1">
        <b>{waiting.length === 1 ? `${first.company} needs a quick check` : `${waiting.length} applications need a quick check`}</b>
        <span className="text-muted"> · tick the highlighted box in the tab and ApplyFlux carries on. Everything else keeps running.</span>
      </span>
      <button
        type="button"
        className="rounded-xl bg-warning px-3 py-1.5 font-semibold text-black hover:opacity-90"
        onClick={async () => {
          if (!(await focusExtensionTab(first.id))) nav(`/app/applications?id=${first.id}`);
        }}
      >
        Go to the tab
      </button>
    </div>
  );
}
