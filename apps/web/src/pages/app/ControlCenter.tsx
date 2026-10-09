import { Link } from 'react-router-dom';
import { Bot, Gauge, Pause, Play, Puzzle, Square, Timer } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, Progress, Skeleton, StatCard, buttonVariants } from '@/components/ui';
import { InterventionCard } from '@/components/applications';
import { StateBadge } from '@/components/brand';
import { api } from '@/lib/api';
import { qk, useAction, useAutomation, useConnections, useUsage } from '@/lib/queries';
import { timeAgo } from '@/lib/utils';

export function ControlCenter() {
  const { data, isLoading, error, refetch } = useAutomation();
  const { data: usage } = useUsage();
  const { data: conns } = useConnections();
  const inv = [qk.automation, qk.dashboard, ['applications']];
  const start = useAction(() => api.post('/automation/start'), { success: 'Auto Apply started', invalidate: inv });
  const pause = useAction(() => api.post('/automation/pause'), { success: 'Paused — in-flight applications stop at the next safe step', invalidate: inv });
  const stop = useAction(() => api.post('/automation/stop'), { success: 'Stopped', invalidate: inv });
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const run = data?.run;
  const c = data?.runCounts ?? {};
  const active = data?.active ?? [];
  const working = active.find((a) => a.state === 'IN_PROGRESS');
  const liveConn = conns?.find((x) => !x.revokedAt && x.lastSeenAt && Date.now() - new Date(x.lastSeenAt).getTime() < 90_000);
  const done = (c.SUBMITTED ?? 0) + (c.SUBMISSION_UNVERIFIED ?? 0);
  const total = Object.values(c).reduce((a, b) => a + (b ?? 0), 0);

  return (
    <div>
      <PageHeader
        eyebrow="Auto Apply"
        title="Control Center"
        description="Live view of the automation running in your browser. You can pause or stop at any moment — a failure in one application never blocks the rest."
        actions={
          <>
            {run?.status === 'running' ? (
              <Button variant="secondary" onClick={() => pause.mutate(undefined)} loading={pause.isPending}>
                <Pause className="h-4 w-4" /> Pause
              </Button>
            ) : (
              <Button onClick={() => start.mutate(undefined)} loading={start.isPending}>
                <Play className="h-4 w-4" /> {run?.status === 'paused' ? 'Resume' : 'Start'}
              </Button>
            )}
            <Button variant="danger" disabled={!run} onClick={() => stop.mutate(undefined)} loading={stop.isPending}>
              <Square className="h-4 w-4" /> Stop
            </Button>
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4">
        <span className="inline-flex items-center gap-2 text-sm font-semibold">
          <Bot className="h-4 w-4 text-brand" /> Status:
        </span>
        {isLoading ? <Skeleton className="h-5 w-24" /> : <Badge tone={run?.status === 'running' ? 'success' : run?.status === 'paused' ? 'warning' : 'neutral'}>{run ? run.status : 'Off'}</Badge>}
        <span className="text-sm text-muted">Mode: <b className="capitalize text-ink">{data?.preferences.mode ?? '—'}</b></span>
        <span className="text-sm text-muted">Started {run ? timeAgo(run.startedAt) : '—'}</span>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted">
          <Puzzle className="h-4 w-4" /> Extension: {liveConn ? <Badge tone="success">Online</Badge> : conns?.some((x) => !x.revokedAt) ? <Badge tone="warning">Not seen recently</Badge> : <Link to="/app/extension" className="font-semibold text-brand-ink hover:underline">Connect</Link>}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Submitted (this run)" value={done} hint={`${c.SUBMISSION_UNVERIFIED ?? 0} unverified`} tone="success" loading={isLoading} />
        <StatCard label="Pending in queue" value={(c.QUEUED ?? 0) + active.length} hint={`${active.length} active now`} loading={isLoading} />
        <StatCard label="Needs attention" value={(c.NEEDS_ATTENTION ?? 0) + (c.AWAITING_HUMAN_VERIFICATION ?? 0) + (c.AWAITING_REVIEW ?? 0)} tone="warning" loading={isLoading} />
        <StatCard label="Failed / skipped" value={(c.FAILED ?? 0) + (c.SKIPPED ?? 0)} tone="danger" loading={isLoading} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader title="Current application" description={total ? `${done} of ${total} in this run completed` : undefined} />
            <div className="p-5">
              {total > 0 && <Progress value={(done / total) * 100} className="mb-5" label="Run progress" />}
              {working ? (
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-lg font-bold">{working.title}</div>
                      <div className="text-sm text-muted">
                        {working.company} · attempt {working.attempts} of {working.maxAttempts}
                        {working.adapter ? ` · ${working.adapter} adapter` : ''}
                      </div>
                    </div>
                    <StateBadge state={working.state} />
                  </div>
                  <Progress value={working.progress} className="mt-4" label="Current application progress" />
                  <div className="mt-2 text-sm text-muted">{working.currentStep ?? 'Starting…'}</div>
                </div>
              ) : (
                <EmptyState
                  icon={<Timer className="h-5 w-5" />}
                  title={run?.status === 'running' ? 'Waiting for the next application' : 'Automation is not running'}
                  description={run?.status === 'running' ? 'The extension checks for new work every few seconds.' : 'Queue jobs from Job Discovery, then start Auto Apply.'}
                  action={!run && <Link to="/app/jobs" className={buttonVariants({ variant: 'secondary' })}>Find jobs to queue</Link>}
                />
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Alerts & interventions" description="CAPTCHAs, sign-ins and reviews pause only the affected application." />
            <div className="space-y-4 p-5">
              {active.filter((a) => a.state !== 'IN_PROGRESS').length === 0 && <p className="text-sm text-muted">No active interventions.</p>}
              {active
                .filter((a) => a.state !== 'IN_PROGRESS')
                .map((a) => (
                  <div key={a.id}>
                    <div className="mb-2 text-sm font-semibold">
                      {a.title} <span className="font-normal text-muted">· {a.company}</span>
                    </div>
                    <InterventionCard app={a} />
                  </div>
                ))}
              <Link to="/app/applications?view=attention" className="inline-block text-sm font-semibold text-brand-ink hover:underline">
                See everything that needs attention →
              </Link>
            </div>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Limits" action={<Link to="/app/settings/automation" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>Edit</Link>} />
          <dl className="divide-y divide-line text-sm">
            {[
              ['Daily limit', data ? `${data.preferences.dailyLimit}` : '—'],
              ['Used today', `${usage?.applications.usedToday ?? 0}`],
              ['Concurrency', data ? `${data.preferences.maxConcurrency}` : '—'],
              ['Minimum match score', `${data?.preferences.minMatchScore ?? '—'}`],
              ['In progress', `${usage?.applications.reserved ?? 0}`],
              ['Auto-submit platforms', data?.autoSubmitPlatforms.join(', ') ?? '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 px-5 py-3">
                <dt className="flex items-center gap-2 text-muted">
                  <Gauge className="h-4 w-4" /> {k}
                </dt>
                <dd className="text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}
