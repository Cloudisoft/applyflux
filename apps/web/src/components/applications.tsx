import * as React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ExternalLink, Hand, RotateCcw, SkipForward, Send, ShieldAlert, XCircle } from 'lucide-react';
import { STATE_LABELS, type ApplicationState } from '@applyflux/shared';
import { Badge, Button, ConfirmDialog, Dialog, Progress, Select, Textarea, buttonVariants } from './ui';
import { focusExtensionTab } from '@/lib/extension';
import { StateBadge } from './brand';
import { api } from '@/lib/api';
import { qk, useAction } from '@/lib/queries';
import type { Application } from '@/lib/types';
import { timeAgo } from '@/lib/utils';

const INVALIDATE = [['applications'], ['application'], qk.dashboard, qk.automation, qk.usage];

export function useAppAction(id: string) {
  return useAction((body: Record<string, unknown>) => api.post<Application>(`/applications/${id}/actions`, body), {
    invalidate: INVALIDATE,
    success: (a) => `Application ${STATE_LABELS[a.state as ApplicationState].toLowerCase()}`,
  });
}

/** Actions available for an application in its current state. Every button calls the API. */
export function ApplicationActions({ app, compact }: { app: Application; compact?: boolean }) {
  const act = useAppAction(app.id);
  const [confirm, setConfirm] = React.useState<null | 'manual' | 'approve' | 'skip'>(null);
  const [note, setNote] = React.useState('');
  const size = compact ? 'sm' : 'md';
  const s = app.state;
  return (
    <div className="flex flex-wrap gap-2">
      {s === 'AWAITING_REVIEW' && (
        <Button size={size} onClick={() => setConfirm('approve')}>
          <Send className="h-4 w-4" /> Approve & submit
        </Button>
      )}
      {(s === 'AWAITING_REVIEW' || s === 'AWAITING_HUMAN_VERIFICATION') && app.url && (
        <Button
          size={size}
          variant={s === 'AWAITING_HUMAN_VERIFICATION' ? 'primary' : 'secondary'}
          onClick={async () => {
            // The extension holds this tab: verifying in a fresh tab would not count, so bring that tab forward.
            if (!(await focusExtensionTab(app.id))) window.open(app.intervention?.pageUrl || app.url, '_blank', 'noopener,noreferrer');
          }}
        >
          <ExternalLink className="h-4 w-4" /> Go to the tab
        </Button>
      )}
      {s === 'NEEDS_ATTENTION' && app.url && (
        <a href={app.intervention?.pageUrl || app.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size, variant: 'secondary' })}>
          <ExternalLink className="h-4 w-4" /> Open application
        </a>
      )}
      {(s === 'NEEDS_ATTENTION' || s === 'FAILED' || s === 'SKIPPED') && !app.submitAttemptedAt && (
        <Button size={size} variant="secondary" loading={act.isPending} onClick={() => act.mutate({ action: 'retry' })}>
          <RotateCcw className="h-4 w-4" /> Retry
        </Button>
      )}
      {['NEEDS_ATTENTION', 'AWAITING_REVIEW', 'QUEUED', 'SHORTLISTED', 'DISCOVERED'].includes(s) && (
        <Button size={size} variant="secondary" onClick={() => setConfirm('manual')}>
          <CheckCircle2 className="h-4 w-4" /> I applied manually
        </Button>
      )}
      {s === 'SUBMISSION_UNVERIFIED' && (
        <Button size={size} variant="secondary" loading={act.isPending} onClick={() => act.mutate({ action: 'confirm_submitted' })}>
          <CheckCircle2 className="h-4 w-4" /> Confirm received
        </Button>
      )}
      {s === 'QUEUED' && (
        <Button size={size} variant="ghost" loading={act.isPending} onClick={() => act.mutate({ action: 'dequeue' })}>
          Remove from queue
        </Button>
      )}
      {s === 'IN_PROGRESS' && (
        <Button size={size} variant="secondary" loading={act.isPending} onClick={() => act.mutate({ action: 'stop' })}>
          <XCircle className="h-4 w-4" /> Stop
        </Button>
      )}
      {['SUBMITTED', 'SUBMISSION_UNVERIFIED', 'INTERVIEW'].includes(s) && (
        <Select aria-label="Record outcome" className="h-9 w-auto" value="" onChange={(e) => e.target.value && act.mutate({ action: 'set_outcome', outcome: e.target.value })}>
          <option value="">Record outcome…</option>
          {s !== 'INTERVIEW' && <option value="INTERVIEW">Interview</option>}
          <option value="REJECTED">Rejected</option>
          <option value="WITHDRAWN">Withdrawn</option>
        </Select>
      )}
      {['NEEDS_ATTENTION', 'AWAITING_REVIEW', 'AWAITING_HUMAN_VERIFICATION', 'QUEUED', 'FAILED', 'DISCOVERED', 'SHORTLISTED'].includes(s) && (
        <Button size={size} variant="ghost" onClick={() => setConfirm('skip')}>
          <SkipForward className="h-4 w-4" /> Skip
        </Button>
      )}

      <ConfirmDialog
        open={confirm === 'approve'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Submit this application?"
        description="ApplyFlux will submit the form exactly as it is filled in the open tab and verify the confirmation. Check the tab first if you haven't."
        confirmLabel="Approve & submit"
        loading={act.isPending}
        onConfirm={() => act.mutate({ action: 'approve_submit' }, { onSuccess: () => setConfirm(null) })}
      />
      <ConfirmDialog
        open={confirm === 'skip'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Skip this application?"
        description="It won't be retried automatically. You can re-queue it later."
        confirmLabel="Skip"
        loading={act.isPending}
        onConfirm={() => act.mutate({ action: 'skip' }, { onSuccess: () => setConfirm(null) })}
      />
      <Dialog
        open={confirm === 'manual'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Mark as applied manually"
        description="Use this when you completed the application yourself. It's recorded as unverified until you confirm the employer received it, and it doesn't count toward your daily limit."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button loading={act.isPending} onClick={() => act.mutate({ action: 'mark_submitted_manually', note: note || undefined }, { onSuccess: () => setConfirm(null) })}>
              Mark as applied
            </Button>
          </>
        }
      >
        <Textarea placeholder="Optional note (e.g. applied via company site on Monday)" value={note} onChange={(e) => setNote(e.target.value)} />
      </Dialog>
    </div>
  );
}

export function InterventionCard({ app }: { app: Application }) {
  const i = app.intervention;
  if (!i) return null;
  const isCaptcha = i.type === 'captcha';
  return (
    <div className={`rounded-2xl border p-4 ${isCaptcha ? 'border-warning/40 bg-warning/5' : app.state === 'AWAITING_REVIEW' ? 'border-brand/30 bg-brand-soft/40' : 'border-danger/30 bg-danger/5'}`}>
      <div className="flex items-start gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${isCaptcha ? 'bg-warning/15 text-warning' : app.state === 'AWAITING_REVIEW' ? 'bg-brand-soft text-brand-ink' : 'bg-danger/10 text-danger'}`}>
          {isCaptcha ? <ShieldAlert className="h-5 w-5" /> : app.state === 'AWAITING_REVIEW' ? <Hand className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{i.title}</span>
            <span className="text-xs text-muted">{timeAgo(i.since)}</span>
          </div>
          <p className="mt-1 text-sm text-ink/90">{i.message}</p>
          <p className="mt-1 text-sm text-muted">{i.action}</p>
          {isCaptcha && app.state === 'AWAITING_HUMAN_VERIFICATION' && (
            <p className="mt-2 text-xs text-muted">Click "Go to the tab", tick the highlighted check, and ApplyFlux carries on by itself. Other applications keep going meanwhile.</p>
          )}
        </div>
      </div>
      <div className="mt-4">
        <ApplicationActions app={app} compact />
      </div>
    </div>
  );
}

export function ApplicationRow({ app, onOpen }: { app: Application; onOpen?: () => void }) {
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-elevated/60">
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{app.title}</div>
        <div className="truncate text-sm text-muted">
          {app.company}
          {app.location ? ` · ${app.location}` : ''}
        </div>
      </div>
      {app.state === 'IN_PROGRESS' && (
        <div className="hidden w-40 md:block">
          <Progress value={app.progress} label="Application progress" />
          <div className="mt-1 truncate text-xs text-muted">{app.currentStep}</div>
        </div>
      )}
      <div className="hidden text-right text-xs text-muted sm:block">{timeAgo(app.updatedAt)}</div>
      <StateBadge state={app.state} />
    </button>
  );
}

export function PlatformBadge({ vendor }: { vendor: string | null }) {
  if (!vendor) return null;
  return <Badge tone="neutral" className="capitalize">{vendor}</Badge>;
}

export function JobLink({ id, children }: { id: string; children: React.ReactNode }) {
  return <Link to={`/app/jobs/${id}`} className="hover:underline">{children}</Link>;
}
