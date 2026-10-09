import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ExternalLink, Inbox, Search, X } from 'lucide-react';
import { STATE_LABELS, type ApplicationState } from '@applyflux/shared';
import { Badge, Card, EmptyState, ErrorState, Input, PageHeader, Progress, Skeleton, Tabs, TabsList, TabsTrigger, Textarea, Button } from '@/components/ui';
import { ApplicationActions, ApplicationRow, InterventionCard } from '@/components/applications';
import { StateBadge } from '@/components/brand';
import { api } from '@/lib/api';
import { useAction, useApplication, useApplications } from '@/lib/queries';
import { formatDate, timeAgo } from '@/lib/utils';

const VIEWS: Record<string, { label: string; states?: ApplicationState[] }> = {
  all: { label: 'All' },
  attention: { label: 'Needs you', states: ['AWAITING_HUMAN_VERIFICATION', 'AWAITING_REVIEW', 'NEEDS_ATTENTION'] },
  queue: { label: 'Queue', states: ['QUEUED', 'IN_PROGRESS'] },
  submitted: { label: 'Submitted', states: ['SUBMITTED', 'SUBMISSION_UNVERIFIED'] },
  outcomes: { label: 'Outcomes', states: ['INTERVIEW', 'REJECTED', 'WITHDRAWN'] },
  closed: { label: 'Failed & skipped', states: ['FAILED', 'SKIPPED'] },
  saved: { label: 'Shortlisted', states: ['SHORTLISTED', 'DISCOVERED'] },
};

export function ApplicationsPage() {
  const [params, setParams] = useSearchParams();
  const stateParam = params.get('state') as ApplicationState | null;
  const view = params.get('view') ?? (stateParam ? 'custom' : 'all');
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const states = stateParam ? [stateParam] : VIEWS[view]?.states;
  const { data, isLoading, error, refetch } = useApplications({ state: states, q: debounced || undefined });
  const openId = params.get('id');

  return (
    <div>
      <PageHeader eyebrow="Tracking" title="Application history" description="Every application, its current state, and the evidence behind it." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={view} onValueChange={(v) => setParams({ view: v })}>
          <TabsList>
            {Object.entries(VIEWS).map(([k, v]) => (
              <TabsTrigger key={k} value={k}>
                {v.label}
              </TabsTrigger>
            ))}
            {stateParam && <TabsTrigger value="custom">{STATE_LABELS[stateParam]}</TabsTrigger>}
          </TabsList>
        </Tabs>
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Search title or company" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search applications" />
        </div>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <Card className="overflow-hidden">
          {isLoading && (
            <div className="space-y-3 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          )}
          {data && !data.items.length && <EmptyState className="m-5 border-0" icon={<Inbox className="h-5 w-5" />} title="No applications here" description="Queue jobs from Job Discovery or Smart Match and they'll appear here." />}
          <div className="divide-y divide-line">
            {data?.items.map((a) => (
              <ApplicationRow key={a.id} app={a} onOpen={() => setParams((p) => { p.set('id', a.id); return p; })} />
            ))}
          </div>
          {data && data.total > data.items.length && <div className="border-t border-line px-5 py-3 text-xs text-muted">Showing {data.items.length} of {data.total}</div>}
        </Card>
      )}
      <ApplicationDrawer id={openId} onClose={() => setParams((p) => { p.delete('id'); return p; })} />
    </div>
  );
}

function ApplicationDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: a, isLoading } = useApplication(id);
  const [notes, setNotes] = React.useState<string | null>(null);
  const saveNotes = useAction((n: string) => api.patch(`/applications/${id}`, { notes: n }), { success: 'Notes saved', invalidate: [['application']] });
  React.useEffect(() => setNotes(null), [id]);
  return (
    <DialogPrimitive.Root open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-2xl animate-fade-up focus:outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-line p-5">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate font-display text-lg font-bold">{a?.title ?? 'Application'}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="truncate text-sm text-muted">{a?.company}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="rounded-lg p-1 text-muted hover:bg-elevated" aria-label="Close">
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 space-y-6 overflow-y-auto p-5">
            {isLoading || !a ? (
              <Skeleton className="h-40" />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <StateBadge state={a.state} />
                  {a.mode && <Badge tone="neutral" className="capitalize">{a.mode} mode</Badge>}
                  {a.atsVendor && <Badge tone="neutral" className="capitalize">{a.atsVendor}</Badge>}
                  {a.score != null && <Badge tone="info">Match {a.score}</Badge>}
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-brand-ink hover:underline">
                    Job posting <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
                {a.state === 'IN_PROGRESS' && (
                  <div>
                    <Progress value={a.progress} label="Progress" />
                    <div className="mt-1.5 text-sm text-muted">{a.currentStep}</div>
                  </div>
                )}
                {a.intervention ? <InterventionCard app={a} /> : <ApplicationActions app={a} compact />}
                {a.lastError && (
                  <div className="rounded-xl bg-danger/5 p-3 text-sm">
                    <span className="font-semibold text-danger">Last error:</span> {a.lastError.message}
                  </div>
                )}
                {a.submissionEvidence && (
                  <section>
                    <h3 className="mb-2 text-sm font-semibold">Submission evidence</h3>
                    <div className="rounded-xl border border-line bg-elevated p-3 text-xs text-muted">
                      {'userAttested' in a.submissionEvidence ? (
                        <p>Marked as submitted by you{a.submissionEvidence.note ? `: “${String(a.submissionEvidence.note)}”` : ''}.</p>
                      ) : (
                        <>
                          <p>
                            <b className="text-ink">Final page:</b> {String(a.submissionEvidence.finalUrl ?? '—')}
                          </p>
                          {a.submissionEvidence.confirmationText ? (
                            <p className="mt-1">
                              <b className="text-ink">Confirmation:</b> “{String(a.submissionEvidence.confirmationText)}”
                            </p>
                          ) : (
                            <p className="mt-1">No confirmation message was detected.</p>
                          )}
                          {'userConfirmed' in a.submissionEvidence && <p className="mt-1 text-success">Confirmed by you.</p>}
                        </>
                      )}
                    </div>
                  </section>
                )}
                {!!a.fields?.length && (
                  <section>
                    <h3 className="mb-2 text-sm font-semibold">Fields ({a.fields.filter((f) => f.status === 'filled').length} filled)</h3>
                    <div className="max-h-72 overflow-y-auto rounded-xl border border-line">
                      <table className="w-full text-xs">
                        <tbody>
                          {a.fields.map((f) => (
                            <tr key={f.key} className="border-b border-line/60 last:border-0">
                              <td className="px-3 py-2 align-top">
                                <div className="font-medium text-ink">{f.label}{f.required && <span className="text-danger"> *</span>}</div>
                                {f.reason && <div className="text-muted">{f.reason}</div>}
                              </td>
                              <td className="max-w-[12rem] truncate px-3 py-2 align-top text-muted">{f.value ?? '—'}</td>
                              <td className="px-3 py-2 align-top">
                                <Badge tone={f.status === 'filled' ? 'success' : f.status === 'uncertain' ? 'warning' : f.status === 'skipped' ? 'neutral' : 'danger'}>{f.status.replace('_', ' ')}</Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Notes</h3>
                  <Textarea value={notes ?? a.notes ?? ''} onChange={(e) => setNotes(e.target.value)} placeholder="Recruiter name, follow-up dates, interview notes…" />
                  {notes !== null && notes !== (a.notes ?? '') && (
                    <Button size="sm" className="mt-2" loading={saveNotes.isPending} onClick={() => saveNotes.mutate(notes)}>
                      Save notes
                    </Button>
                  )}
                </section>
                <section>
                  <h3 className="mb-3 text-sm font-semibold">Timeline</h3>
                  <ol className="relative space-y-4 border-l border-line pl-5">
                    {a.events?.filter((e) => e.type !== 'progress').map((e) => (
                      <li key={e.id} className="relative">
                        <span className="absolute -left-[26px] top-1 h-3 w-3 rounded-full border-2 border-surface bg-brand" />
                        <div className="text-sm font-medium">{e.message ?? (e.toState ? STATE_LABELS[e.toState as ApplicationState] : e.type.replace(/_/g, ' '))}</div>
                        <div className="text-xs text-muted">
                          {formatDate(e.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {e.actor} · {timeAgo(e.createdAt)}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
