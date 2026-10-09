import { Link, useNavigate } from 'react-router-dom';
import { Activity, BadgeCheck, Briefcase, CalendarCheck, CircleAlert, ListChecks, Pause, Play, Send, Settings, Square, Target, Trophy, UserCheck } from 'lucide-react';
import { STATE_LABELS } from '@applyflux/shared';
import { Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, Progress, Skeleton, StatCard, buttonVariants } from '@/components/ui';
import { InterventionCard } from '@/components/applications';
import { api } from '@/lib/api';
import { qk, useAction, useDashboard, useMe } from '@/lib/queries';
import { cn, timeAgo } from '@/lib/utils';

export function DashboardPage() {
  const { data, isLoading, error, refetch } = useDashboard();
  const { data: me } = useMe();
  const nav = useNavigate();
  const inv = [qk.dashboard, qk.automation];
  const start = useAction(() => api.post('/automation/start'), { success: 'Auto Apply started', invalidate: inv });
  const pause = useAction(() => api.post('/automation/pause'), { success: 'Auto Apply paused', invalidate: inv });
  const stop = useAction(() => api.post('/automation/stop'), { success: 'Auto Apply stopped', invalidate: inv });

  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const d = data;
  const run = d?.run?.status;
  const u = d?.usage.applications;
  const remaining = u ? Math.max(0, u.dailyLimit - u.usedToday - u.reserved) : 0;
  const name = me?.account.displayName?.split(' ')[0];

  return (
    <div>
      <PageHeader
        eyebrow="Dashboard"
        title={name ? `Welcome back, ${name}` : 'Welcome back'}
        description="Everything below comes from your saved application records."
        actions={
          <>
            {run === 'running' ? (
              <Button variant="secondary" onClick={() => pause.mutate(undefined)} loading={pause.isPending}>
                <Pause className="h-4 w-4" /> Pause
              </Button>
            ) : (
              <Button onClick={() => start.mutate(undefined)} loading={start.isPending}>
                <Play className="h-4 w-4" /> {run === 'paused' ? 'Resume' : 'Start Auto Apply'}
              </Button>
            )}
            {run && (
              <Button variant="ghost" onClick={() => stop.mutate(undefined)} loading={stop.isPending}>
                <Square className="h-4 w-4" /> Stop
              </Button>
            )}
            <Link to="/app/settings/automation" className={buttonVariants({ variant: 'secondary' })}>
              <Settings className="h-4 w-4" /> Configure
            </Link>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Submitted today" value={d?.submittedToday ?? 0} hint={`${d?.submittedThisWeek ?? 0} this week`} icon={<Send className="h-4 w-4" />} loading={isLoading} />
        <StatCard label="Confirmed submissions" value={d?.confirmedSubmissions ?? 0} hint={`${d?.unverifiedSubmissions ?? 0} unverified`} icon={<BadgeCheck className="h-4 w-4" />} tone="success" loading={isLoading} />
        <StatCard label="Jobs discovered" value={d?.jobsDiscovered ?? 0} hint={`${d?.jobsDiscoveredThisWeek ?? 0} new this week · ${d?.byState.SHORTLISTED ?? 0} shortlisted`} icon={<Briefcase className="h-4 w-4" />} tone="accent" loading={isLoading} />
        <StatCard label="Interviews" value={d?.interviews ?? 0} hint={`${d?.responses ?? 0} responses recorded`} icon={<Trophy className="h-4 w-4" />} tone="warning" loading={isLoading} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader
              title="Needs your attention"
              description="Verification, reviews and anything ApplyFlux couldn't finish safely."
              action={
                <Link to="/app/applications?view=attention" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  View all
                </Link>
              }
            />
            <div className="space-y-3 p-5">
              {isLoading && <Skeleton className="h-24" />}
              {d && !d.attention.length && <EmptyState icon={<UserCheck className="h-5 w-5" />} title="Nothing needs you right now" description="When an application needs a CAPTCHA, a sign-in, an answer or your review, it shows up here." />}
              {d?.attention.slice(0, 4).map((a) => (
                <div key={a.id}>
                  <button className="mb-2 text-left text-sm font-semibold hover:underline" onClick={() => nav(`/app/applications?id=${a.id}`)}>
                    {a.title} <span className="font-normal text-muted">· {a.company}</span>
                  </button>
                  <InterventionCard app={a} />
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Pipeline" description="Where your applications are right now." />
            <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
              {(['QUEUED', 'IN_PROGRESS', 'AWAITING_REVIEW', 'NEEDS_ATTENTION', 'SUBMITTED', 'SUBMISSION_UNVERIFIED', 'FAILED', 'SKIPPED'] as const).map((s) => (
                <Link key={s} to={`/app/applications?state=${s}`} className="rounded-xl border border-line p-3 transition hover:border-brand/40 hover:bg-elevated">
                  <div className="text-xs text-muted">{STATE_LABELS[s]}</div>
                  <div className="mt-1 font-display text-2xl font-bold tabular-nums">{isLoading ? '–' : d?.byState[s] ?? 0}</div>
                </Link>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Profile completeness</h3>
              <span className="font-display text-xl font-bold">{d?.profileCompleteness ?? 0}%</span>
            </div>
            <Progress value={d?.profileCompleteness ?? 0} className="mt-3" label="Profile completeness" />
            {me?.assessment.missing.slice(0, 3).map((m) => (
              <div key={m.field} className="mt-2 flex items-center gap-2 text-sm text-muted">
                <CircleAlert className={cn('h-4 w-4', m.requiredForAutomation ? 'text-warning' : 'text-muted')} /> {m.label}
              </div>
            ))}
            <Link to="/app/profile" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-4 w-full')}>
              Improve profile
            </Link>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Today</h3>
              <Link to="/app/settings/automation" className="text-xs font-semibold text-brand-ink hover:underline">
                Change limit
              </Link>
            </div>
            <div className="mt-3 flex items-baseline gap-1">
              <span className="font-display text-2xl font-bold">{remaining}</span>
              <span className="text-sm text-muted">applications left today</span>
            </div>
            <Progress value={u ? ((u.usedToday + u.reserved) / Math.max(1, u.dailyLimit)) * 100 : 0} className="mt-3" label="Daily usage" />
            <div className="mt-2 text-xs text-muted">
              {u?.usedToday ?? 0} of {u?.dailyLimit ?? 0} used today{u?.reserved ? ` · ${u.reserved} in progress` : ''}
            </div>
          </Card>

          <Card>
            <CardHeader title="Recent activity" />
            <ul className="divide-y divide-line">
              {isLoading && (
                <li className="p-5">
                  <Skeleton className="h-16" />
                </li>
              )}
              {d && !d.recentActivity.length && (
                <li className="p-5 text-sm text-muted">
                  No activity yet. <Link to="/app/jobs" className="font-semibold text-brand-ink hover:underline">Find jobs</Link> to get started.
                </li>
              )}
              {d?.recentActivity.map((e) => (
                <li key={e.id}>
                  <Link to={`/app/applications?id=${e.applicationId}`} className="flex gap-3 px-5 py-3 hover:bg-elevated/60">
                    <Activity className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                    <div className="min-w-0 text-sm">
                      <div className="truncate font-medium">{e.message ?? (e.toState ? STATE_LABELS[e.toState as keyof typeof STATE_LABELS] : e.type.replace(/_/g, ' '))}</div>
                      <div className="truncate text-xs text-muted">
                        {e.title} · {e.company} · {timeAgo(e.createdAt)}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-5">
            <h3 className="font-semibold">Quick actions</h3>
            <div className="mt-3 grid gap-2">
              <Link to="/app/applications?state=QUEUED" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                <ListChecks className="h-4 w-4" /> View queue
              </Link>
              <Link to="/app/match" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                <Target className="h-4 w-4" /> Review top matches
              </Link>
              <Link to="/app/applications?state=AWAITING_REVIEW" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                <CalendarCheck className="h-4 w-4" /> Review pending applications
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
