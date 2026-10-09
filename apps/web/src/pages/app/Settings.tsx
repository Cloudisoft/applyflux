import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, CheckCircle2, Copy, Download, Lock, MessageSquareText, Plus, Puzzle, ShieldAlert, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { AUTO_SUBMIT_CONSENT_VERSION } from '@applyflux/shared';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Switch, TagInput, Tabs, TabsList, TabsTrigger, Textarea, buttonVariants } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { EXTENSION_STORE_URL, extensionConfigured, pairExtension, pingExtension } from '@/lib/extension';
import { qk, useAction, useAnswers, useAutomation, useConnections, useDocuments, useNotifications } from '@/lib/queries';
import type { AutomationPrefs, SavedAnswer } from '@/lib/types';
import { cn, formatDate, timeAgo } from '@/lib/utils';
import { toast } from 'sonner';

/* Saved answers --------------------------------------------------------------- */

export function AnswersPage() {
  const { data, isLoading, error, refetch } = useAnswers();
  const [tab, setTab] = React.useState('todo');
  const [editing, setEditing] = React.useState<Partial<SavedAnswer> | null>(null);
  const save = useAction(() => (editing?.id ? api.patch(`/answers/${editing.id}`, { answer: editing.answer, approved: true }) : api.post('/answers', { question: editing!.question, answer: editing!.answer, approved: true })), { success: 'Answer saved and approved', invalidate: [qk.answers], onSuccess: () => setEditing(null) });
  const approve = useAction((a: SavedAnswer) => api.patch(`/answers/${a.id}`, { approved: !a.approved }), { invalidate: [qk.answers] });
  const del = useAction((id: string) => api.del(`/answers/${id}`), { success: 'Deleted', invalidate: [qk.answers] });
  const items = (data ?? []).filter((a) => (tab === 'todo' ? !a.approved : tab === 'approved' ? a.approved : true));
  const todo = (data ?? []).filter((a) => !a.approved).length;
  return (
    <div>
      <PageHeader eyebrow="Your materials" title="Saved answers" description="Answer a screening question once and ApplyFlux reuses your approved answer everywhere the same question appears. Questions it couldn't answer land here." actions={<Button onClick={() => setEditing({ question: '', answer: '' })}><Plus className="h-4 w-4" /> Add answer</Button>} />
      <Tabs value={tab} onValueChange={setTab} className="mb-4">
        <TabsList><TabsTrigger value="todo">Needs your answer {todo ? `(${todo})` : ''}</TabsTrigger><TabsTrigger value="approved">Approved</TabsTrigger><TabsTrigger value="all">All</TabsTrigger></TabsList>
      </Tabs>
      {error && <ErrorState error={error} onRetry={refetch} />}
      {isLoading && <Skeleton className="h-40 rounded-3xl" />}
      {data && !items.length && <EmptyState icon={<MessageSquareText className="h-5 w-5" />} title={tab === 'todo' ? "You're all caught up" : 'No answers yet'} description="Common examples: consent checkboxes, “How did you hear about us?”, notice period, or why you want a particular kind of role." />}
      <div className="space-y-3">
        {items.map((a) => (
          <Card key={a.id} className="p-5">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{a.question}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge tone="neutral" className="capitalize">{a.category.replace(/_/g, ' ')}</Badge>
                  {a.isSensitive && <Badge tone="warning"><Lock className="h-3 w-3" /> Sensitive — never AI-answered</Badge>}
                  {a.source === 'ai_draft' && <Badge tone="info">AI draft</Badge>}
                  {a.approved ? <Badge tone="success">Approved · used {a.usageCount}×</Badge> : <Badge tone="warning">Not approved</Badge>}
                </div>
                {a.answer ? <p className="mt-3 whitespace-pre-line text-sm text-ink/90">{a.answer}</p> : <p className="mt-3 text-sm italic text-muted">No answer yet</p>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(a)}>{a.answer ? 'Edit' : 'Answer'}</Button>
                {a.answer && <Button size="sm" variant={a.approved ? 'ghost' : 'soft'} onClick={() => approve.mutate(a)}>{a.approved ? 'Unapprove' : 'Approve'}</Button>}
                <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => del.mutate(a.id)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={editing?.id ? 'Your answer' : 'New saved answer'} description="Saved answers are approved and reused automatically. Only write what is true." wide
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending} disabled={!editing?.answer?.trim() || !editing?.question?.trim()} onClick={() => save.mutate(undefined)}>Save & approve</Button></>}>
        {editing && <div className="space-y-4">
          <Field label="Question" htmlFor="sa-q"><Input id="sa-q" disabled={!!editing.id} value={editing.question ?? ''} onChange={(e) => setEditing({ ...editing, question: e.target.value })} /></Field>
          <Field label="Answer" htmlFor="sa-a" hint="For yes/no or multiple-choice questions, write the option exactly (e.g. “Yes”)."><Textarea id="sa-a" rows={5} value={editing.answer ?? ''} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} /></Field>
        </div>}
      </Dialog>
    </div>
  );
}

/* Extension ---------------------------------------------------------------------- */

export function ExtensionPage() {
  const { data: conns, isLoading } = useConnections();
  const [code, setCode] = React.useState<{ code: string; expiresAt: number } | null>(null);
  const [ext, setExt] = React.useState<{ connected: boolean; version: string } | null>(null);
  const gen = useAction(() => api.post<{ code: string; expiresInSeconds: number }>('/extension/pairing-code'), {
    onSuccess: async (r) => {
      setCode({ code: r.code, expiresAt: Date.now() + r.expiresInSeconds * 1000 });
      const res = await pairExtension(r.code);
      if (res?.ok) toast.success('Extension connected');
    },
  });
  const revoke = useAction((id: string) => api.del(`/extension/connections/${id}`), { success: 'Connection revoked', invalidate: [qk.connections] });
  React.useEffect(() => { pingExtension().then((r) => r && setExt(r)); }, [conns]);
  const active = conns?.filter((c) => !c.revokedAt && new Date(c.expiresAt) > new Date()) ?? [];
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Browser extension" description="The ApplyFlux Agent runs applications inside your own Chrome, so your sessions and sign-ins stay on your device." />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader title="Connect the ApplyFlux Agent" />
            <ol className="space-y-5 p-5 text-sm">
              <li className="flex gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-soft font-bold text-brand-ink">1</span><div><div className="font-semibold">Install the extension</div><p className="text-muted">{EXTENSION_STORE_URL ? <a href={EXTENSION_STORE_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-ink hover:underline">Install from the Chrome Web Store</a> : <>Your administrator distributes the ApplyFlux Agent build (<code className="rounded bg-elevated px-1">apps/extension/dist</code>). In Chrome open <code className="rounded bg-elevated px-1">chrome://extensions</code>, enable Developer mode, choose “Load unpacked” and select that folder.</>}</p>{ext && <Badge tone="success" className="mt-2">Detected · v{ext.version}</Badge>}</div></li>
              <li className="flex gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-soft font-bold text-brand-ink">2</span><div className="flex-1"><div className="font-semibold">Generate a pairing code</div><p className="text-muted">{extensionConfigured ? 'If the extension is installed, it connects automatically.' : 'Open the extension popup and enter the code.'} Codes expire after 10 minutes and work once.</p>
                {code && Date.now() < code.expiresAt ? (
                  <div className="mt-3 flex items-center gap-3"><span className="rounded-xl border border-line bg-elevated px-4 py-2 font-mono text-2xl font-bold tracking-[0.2em]">{code.code}</span><Button size="icon" variant="ghost" aria-label="Copy code" onClick={() => { navigator.clipboard.writeText(code.code); toast.success('Copied'); }}><Copy className="h-4 w-4" /></Button></div>
                ) : (
                  <Button className="mt-3" loading={gen.isPending} onClick={() => gen.mutate(undefined)}><Puzzle className="h-4 w-4" /> Connect extension</Button>
                )}</div></li>
              <li className="flex gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-soft font-bold text-brand-ink">3</span><div><div className="font-semibold">Allow job sites when asked</div><p className="text-muted">In the extension popup, choose “Allow job sites”. Chrome asks you to confirm. Without it, ApplyFlux can only use the built-in Sandbox.</p></div></li>
            </ol>
          </Card>
          <Card>
            <CardHeader title="Connected browsers" description="Each connection has its own revocable token. Revoking stops it immediately." />
            {isLoading ? <div className="p-5"><Skeleton className="h-16" /></div> : (
              <ul className="divide-y divide-line">
                {!active.length && <li className="p-5 text-sm text-muted">No browsers connected.</li>}
                {active.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                    <span className={cn('h-2.5 w-2.5 rounded-full', c.lastSeenAt && Date.now() - new Date(c.lastSeenAt).getTime() < 90_000 ? 'bg-success' : 'bg-muted/50')} />
                    <div className="min-w-0 flex-1"><div className="font-semibold">{c.name} {c.extensionVersion && <span className="text-xs font-normal text-muted">v{c.extensionVersion}</span>}</div><div className="text-xs text-muted">Connected {formatDate(c.createdAt)} · last seen {c.lastSeenAt ? timeAgo(c.lastSeenAt) : 'never'} · expires {formatDate(c.expiresAt)}</div></div>
                    <Button size="sm" variant="secondary" onClick={() => revoke.mutate(c.id)}>Revoke</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Card className="h-fit p-5">
          <h3 className="font-semibold">Troubleshooting</h3>
          <ul className="mt-3 space-y-3 text-sm text-muted">
            <li><b className="text-ink">Status shows “Not seen recently”.</b> Make sure Chrome is open; the agent checks in every 30 seconds.</li>
            <li><b className="text-ink">“Permission to access” error.</b> Open the popup and click “Allow job sites”, then retry the application.</li>
            <li><b className="text-ink">Session expired.</b> Revoke the old connection and pair again.</li>
            <li><b className="text-ink">Chrome restarted mid-application.</b> ApplyFlux returns unfinished work to the queue — or asks you to check, if a submit had already been clicked.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

/* Automation settings ---------------------------------------------------------- */

export function AutomationSettings() {
  const { data, isLoading, error, refetch } = useAutomation();
  const { data: docs } = useDocuments('resume');
  const [p, setP] = React.useState<AutomationPrefs | null>(null);
  const [consentOpen, setConsentOpen] = React.useState(false);
  const [agree, setAgree] = React.useState(false);
  React.useEffect(() => { if (data) setP(data.preferences); }, [data]);
  const save = useAction(() => api.put('/automation/preferences', p), { success: 'Automation settings saved', invalidate: [qk.automation, qk.dashboard] });
  const consent = useAction(() => api.post('/automation/consent', { version: AUTO_SUBMIT_CONSENT_VERSION, accepted: true }), { success: 'Authorisation recorded', invalidate: [qk.automation], onSuccess: () => setConsentOpen(false) });
  const revoke = useAction(() => api.del('/automation/consent'), { success: 'Authorisation withdrawn — Auto Mode disabled', invalidate: [qk.automation] });
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !p || !data) return <Skeleton className="h-96 rounded-3xl" />;
  const consented = !!data.preferences.autoSubmitConsentAt && data.preferences.autoSubmitConsentVersion === AUTO_SUBMIT_CONSENT_VERSION;
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Automation settings" description="Control how much ApplyFlux does, and the limits it works within." />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Execution mode" />
          <div className="grid gap-3 p-5 md:grid-cols-3">
            {([
              ['review', 'Review', 'Fill the form, then wait for you to inspect and submit.'],
              ['assisted', 'Assisted', 'Automate supported steps; pause for anything missing, ambiguous or that needs confirmation.'],
              ['auto', 'Auto', 'Submit eligible applications on validated platforms with your authorisation.'],
            ] as const).map(([v, l, d]) => {
              return (
                <button key={v} type="button" onClick={() => setP({ ...p, mode: v })} aria-pressed={p.mode === v} className={cn('rounded-2xl border p-4 text-left transition disabled:opacity-50', p.mode === v ? 'border-brand/60 bg-brand-soft/60 ring-2 ring-brand/20' : 'border-line hover:border-brand/30')}>
                  <div className="font-semibold">{l} Mode</div><p className="mt-1 text-sm text-muted">{d}</p>
                </button>
              );
            })}
          </div>
          {p.mode === 'auto' && (
            <div className={cn('mx-5 mb-5 rounded-2xl p-4', consented ? 'bg-success/10' : 'bg-warning/10')}>
              {consented ? (
                <div className="flex flex-wrap items-center gap-3 text-sm"><CheckCircle2 className="h-5 w-5 text-success" /> You authorised automatic submission on {formatDate(data.preferences.autoSubmitConsentAt)}.<Button size="sm" variant="ghost" className="ml-auto" onClick={() => revoke.mutate(undefined)}>Withdraw authorisation</Button></div>
              ) : (
                <div className="flex flex-wrap items-center gap-3 text-sm text-warning"><ShieldAlert className="h-5 w-5" /> Auto Mode needs your explicit authorisation before anything is submitted.<Button size="sm" className="ml-auto" onClick={() => setConsentOpen(true)}>Review & authorise</Button></div>
              )}
              <p className="mt-2 text-xs text-muted">Automatic submission is enabled on: {data.autoSubmitPlatforms.join(', ')}. Everywhere else, Auto Mode fills the form and asks you to submit.</p>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Limits & filters" />
          <div className="grid gap-5 p-5 sm:grid-cols-2">
            <Field label="Daily application limit" htmlFor="as-daily"><Input id="as-daily" type="number" min={1} max={200} value={p.dailyLimit} onChange={(e) => setP({ ...p, dailyLimit: Number(e.target.value) })} /></Field>
            <Field label="Applications at once" htmlFor="as-conc"><Input id="as-conc" type="number" min={1} max={5} value={p.maxConcurrency} onChange={(e) => setP({ ...p, maxConcurrency: Number(e.target.value) })} /></Field>
            <Field label={`Minimum match score: ${p.minMatchScore}`} htmlFor="as-score" hint="Used to suggest jobs for your queue."><input id="as-score" type="range" min={0} max={100} step={5} value={p.minMatchScore} onChange={(e) => setP({ ...p, minMatchScore: Number(e.target.value) })} className="w-full accent-[rgb(var(--brand))]" /></Field>
            <Field label="Default resume" htmlFor="as-resume"><Select id="as-resume" value={p.defaultResumeId ?? ''} onChange={(e) => setP({ ...p, defaultResumeId: e.target.value || null })}><option value="">Library default</option>{docs?.map((d) => <option key={d.id} value={d.id}>{d.title} (v{d.version})</option>)}</Select></Field>
            <Field label="Cover letters" htmlFor="as-cl"><Select id="as-cl" value={p.coverLetterPolicy} onChange={(e) => setP({ ...p, coverLetterPolicy: e.target.value as AutomationPrefs['coverLetterPolicy'] })}><option value="when_requested">Attach an approved letter for the job when the form asks</option><option value="always">Always attach the approved letter for the job</option><option value="never">Never attach cover letters</option></Select></Field>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-3"><div><div className="text-sm font-medium">Skip jobs that say they don't sponsor visas</div><div className="text-xs text-muted">Detected from the job description.</div></div><Switch checked={p.requireSponsorshipFriendly} onCheckedChange={(v) => setP({ ...p, requireSponsorshipFriendly: v })} label="Skip no-sponsorship jobs" /></div>
            <Field label="Excluded companies" htmlFor="as-exc" className="sm:col-span-2"><TagInput id="as-exc" value={p.excludedCompanies} onChange={(v) => setP({ ...p, excludedCompanies: v })} placeholder="Current employer, companies you've applied to elsewhere…" /></Field>
            <Field label="Excluded keywords" htmlFor="as-kw" className="sm:col-span-2"><TagInput id="as-kw" value={p.excludedKeywords} onChange={(v) => setP({ ...p, excludedKeywords: v })} placeholder="clearance, commission only…" /></Field>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 sm:col-span-2"><div className="flex items-center gap-3"><Bell className="h-4 w-4 text-muted" /><div><div className="text-sm font-medium">Browser notifications</div><div className="text-xs text-muted">Enable in the extension popup too — Chrome asks for permission there.</div></div></div><Switch checked={p.notifyBrowser} onCheckedChange={(v) => setP({ ...p, notifyBrowser: v })} label="Browser notifications" /></div>
          </div>
        </Card>
        <div className="flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save settings</Button></div>
      </div>
      <Dialog open={consentOpen} onOpenChange={setConsentOpen} title="Authorise automatic submission" description={`Consent version ${data.consent.version}`}
        footer={<><Button variant="secondary" onClick={() => setConsentOpen(false)}>Cancel</Button><Button disabled={!agree} loading={consent.isPending} onClick={() => consent.mutate(undefined)}>I authorise</Button></>}>
        <p className="rounded-xl border border-line bg-elevated p-4 text-sm leading-relaxed">{data.consent.text}</p>
        <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--brand))]" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I have read and agree to the above.</label>
      </Dialog>
    </div>
  );
}

/* Notifications ------------------------------------------------------------------- */

export function NotificationsPage() {
  const { data, isLoading } = useNotifications();
  const nav = useNavigate();
  const read = useAction((ids?: string[]) => api.post('/notifications/read', ids ? { ids } : {}), { invalidate: [qk.notifications] });
  return (
    <div>
      <PageHeader eyebrow="Inbox" title="Notifications" actions={!!data?.unread && <Button variant="secondary" onClick={() => read.mutate(undefined)}>Mark all as read</Button>} />
      {isLoading && <Skeleton className="h-40 rounded-3xl" />}
      {data && !data.items.length && <EmptyState icon={<Bell className="h-5 w-5" />} title="No notifications" description="You'll hear from ApplyFlux when an application is submitted or needs you." />}
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line">
          {data?.items.map((n) => (
            <li key={n.id}>
              <button className={cn('flex w-full items-start gap-3 px-5 py-4 text-left hover:bg-elevated/60', !n.readAt && 'bg-brand-soft/30')} onClick={() => { if (!n.readAt) read.mutate([n.id]); if (n.applicationId) nav(`/app/applications?id=${n.applicationId}`); }}>
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.severity === 'danger' ? 'bg-danger' : n.severity === 'warning' ? 'bg-warning' : n.severity === 'success' ? 'bg-success' : 'bg-brand', n.readAt && 'opacity-30')} />
                <div className="min-w-0 flex-1"><div className="font-semibold">{n.title}</div>{n.body && <div className="text-sm text-muted">{n.body}</div>}</div>
                <span className="shrink-0 text-xs text-muted">{timeAgo(n.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/* Account & privacy ---------------------------------------------------------------- */

export function AccountPage() {
  const { session, signOut } = useAuth();
  const nav = useNavigate();
  const [confirm, setConfirm] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const del = useAction(() => api.del('/account', { confirm: 'DELETE' }), { success: 'Your account and data were deleted', onSuccess: async () => { await signOut(); nav('/'); } });
  const exportData = async () => {
    setExporting(true);
    try {
      const data = await api.get<unknown>('/account/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `applyflux-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Account & privacy" />
      <div className="space-y-6">
        <Card><CardHeader title="Account" /><div className="space-y-3 p-5 text-sm"><div><span className="text-muted">Email:</span> {session?.user.email}</div><div><span className="text-muted">Member since:</span> {formatDate(session?.user.created_at)}</div><Link to="/forgot-password" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Change password</Link></div></Card>
        <Card><CardHeader title="Your data" description="Everything ApplyFlux stores about you, in one JSON file." /><div className="p-5"><Button variant="secondary" loading={exporting} onClick={exportData}><Download className="h-4 w-4" /> Export my data</Button></div></Card>
        <Card className="border-danger/30"><CardHeader title={<span className="inline-flex items-center gap-2 text-danger"><TriangleAlert className="h-4 w-4" /> Delete account</span>} description="Permanently deletes your profile, resumes, cover letters, answers, jobs, application history and sign-in. This cannot be undone." /><div className="p-5"><Button variant="danger" onClick={() => setOpen(true)}><Trash2 className="h-4 w-4" /> Delete my account</Button></div></Card>
        <Card className="p-5 text-sm text-muted"><div className="flex items-center gap-2 font-semibold text-ink"><ShieldCheck className="h-4 w-4 text-brand" /> Privacy commitments</div><p className="mt-2">ApplyFlux logs minimal personal data, keeps secrets server-side, and never shares your information with employers except through applications you authorise. <Link to="/security" className="font-semibold text-brand-ink hover:underline">Read more</Link></p></Card>
      </div>
      <ConfirmDialog open={open} onOpenChange={setOpen} danger title="Delete your account?" description="Type DELETE to confirm." confirmLabel="Delete everything" loading={del.isPending} onConfirm={() => confirm === 'DELETE' && del.mutate(undefined)}>
        <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="DELETE" aria-label="Type DELETE to confirm" />
      </ConfirmDialog>
    </div>
  );
}
