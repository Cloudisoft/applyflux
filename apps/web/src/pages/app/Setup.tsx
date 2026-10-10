import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, CheckCircle2, CircleAlert, FlaskConical, Loader2, Puzzle, Rocket } from 'lucide-react';
import { Badge, Button, Card, Field, Input, Progress, Skeleton, buttonVariants } from '@/components/ui';
import { StateBadge } from '@/components/brand';
import { api } from '@/lib/api';
import { pairExtension } from '@/lib/extension';
import { qk, useAction, useApplication, useAutomation, useConnections, useMe, useProfile } from '@/lib/queries';
import type { Doc } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ProfileForm } from './Profile';
import { ParseReview, UploadZone } from './Resumes';
import { DiscoveryPanel } from '@/components/discovery';
import { toast } from 'sonner';

const STEPS = [
  { key: 'account', title: 'Create account' },
  { key: 'resume', title: 'Upload resume' },
  { key: 'review', title: 'Review details' },
  { key: 'details', title: 'Complete profile' },
  { key: 'preferences', title: 'Job preferences' },
  { key: 'automation', title: 'Automation' },
  { key: 'extension', title: 'Connect extension' },
  { key: 'test', title: 'Test run' },
  { key: 'discover', title: 'Discover jobs' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

export function SetupWizard() {
  const { data: me, isLoading } = useMe();
  const { data: profile } = useProfile();
  const [step, setStep] = React.useState<StepKey | null>(null);
  const [parseId, setParseId] = React.useState<string | null>(null);
  const nav = useNavigate();
  const persist = useAction((s: string) => api.patch('/me', { onboardingStep: s }), { invalidate: [qk.me] });
  React.useEffect(() => {
    if (me && !step) {
      const saved = STEPS.find((s) => s.key === me.account.onboardingStep)?.key;
      setStep(!saved || saved === 'account' ? 'resume' : saved);
    }
  }, [me, step]);
  if (isLoading || !me || !step) return <Skeleton className="h-96 rounded-3xl" />;
  const idx = STEPS.findIndex((s) => s.key === step);
  const go = (k: StepKey) => {
    setStep(k);
    persist.mutate(k);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const next = () => go(STEPS[Math.min(idx + 1, STEPS.length - 1)].key);
  const finish = () => {
    persist.mutate('done', { onSuccess: () => nav('/app/jobs') });
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        <div className="text-xs font-semibold uppercase tracking-wider text-brand-ink">Setup · step {idx + 1} of {STEPS.length}</div>
        <h1 className="mt-1 text-3xl font-bold">{STEPS[idx].title}</h1>
        <Progress value={((idx + 1) / STEPS.length) * 100} className="mt-4" label="Setup progress" />
        <ol className="mt-4 hidden flex-wrap gap-2 md:flex">
          {STEPS.map((s, i) => (
            <li key={s.key}>
              <button disabled={i === 0} onClick={() => go(s.key)} className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition', i === idx ? 'bg-brand text-white' : i < idx ? 'bg-brand-soft text-brand-ink' : 'bg-elevated text-muted hover:text-ink')}>
                {i < idx || i === 0 ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>} {s.title}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className="animate-fade-up" key={step}>
        {step === 'resume' && (
          <Card className="p-6">
            <p className="mb-5 text-muted">Upload the resume you use most. ApplyFlux reads it and suggests profile details — you'll confirm everything on the next step.</p>
            <UploadZone
              onUploaded={async (d: Doc) => {
                if (d.parseStatus !== 'parsed') return toast.error(d.parseError ?? 'We could not read this file. Try a text-based PDF or DOCX.');
                try {
                  const p = await api.post<{ id: string }>(`/documents/${d.id}/parse`);
                  setParseId(p.id);
                  go('review');
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            />
            <div className="mt-5 flex justify-between">
              <span className="text-sm text-muted">{me.setup.hasResume ? 'You already have a resume uploaded.' : ''}</span>
              <Button variant="ghost" onClick={() => go('details')}>{me.setup.hasResume ? 'Continue' : 'Skip — I\'ll enter details manually'}</Button>
            </div>
          </Card>
        )}
        {step === 'review' && (parseId ? <ParseReview parseId={parseId} onDone={next} /> : <Card className="p-6 text-sm text-muted">No new extraction to review. <Button variant="link" onClick={() => go('resume')}>Upload a resume</Button> or <Button variant="link" onClick={next}>continue</Button>.</Card>)}
        {step === 'details' && profile && <ProfileForm profile={profile.profile} sections={['personal', 'links', 'authorization']} submitLabel="Save & continue" onSaved={next} />}
        {step === 'preferences' && profile && <ProfileForm profile={profile.profile} sections={['professional', 'preferences']} submitLabel="Save & continue" onSaved={next} />}
        {step === 'automation' && <AutomationStep onNext={next} />}
        {step === 'extension' && <ExtensionStep onNext={next} />}
        {step === 'test' && <TestRunStep onNext={next} />}
        {step === 'discover' && <DiscoverStep onFinish={finish} />}
      </div>
    </div>
  );
}

function AutomationStep({ onNext }: { onNext: () => void }) {
  const { data } = useAutomation();
  const { data: me } = useMe();
  const [mode, setMode] = React.useState<'review' | 'assisted' | 'auto'>('assisted');
  const [daily, setDaily] = React.useState(5);
  React.useEffect(() => { if (data) { setMode(data.preferences.mode === 'auto' ? 'assisted' : data.preferences.mode); setDaily(data.preferences.dailyLimit); } }, [data]);
  const save = useAction(() => api.put('/automation/preferences', { ...data!.preferences, mode, dailyLimit: daily }), { invalidate: [qk.automation], onSuccess: onNext });
  const a = me?.assessment;
  return (
    <Card className="space-y-6 p-6">
      <div className="grid gap-3 md:grid-cols-2">
        {([['review', 'Review', 'ApplyFlux fills; you check every field and click submit.'], ['assisted', 'Assisted (recommended)', 'Automates what it can, pauses for anything missing or uncertain.']] as const).map(([v, l, d]) => (
          <button key={v} onClick={() => setMode(v)} aria-pressed={mode === v} className={cn('rounded-2xl border p-4 text-left', mode === v ? 'border-brand/60 bg-brand-soft/60' : 'border-line')}>
            <div className="font-semibold">{l}</div><p className="mt-1 text-sm text-muted">{d}</p>
          </button>
        ))}
      </div>
      <Field label="Daily application limit" htmlFor="su-daily" hint="You can change this any time."><Input id="su-daily" type="number" min={1} max={200} value={daily} onChange={(e) => setDaily(Number(e.target.value))} className="w-32" /></Field>
      <div className="rounded-2xl border border-line p-4">
        <div className="font-semibold">Before unattended (Auto) applications can run</div>
        <ul className="mt-2 space-y-1.5 text-sm">
          {a?.missing.filter((m) => m.requiredForAutomation).map((m) => <li key={m.field} className="flex items-center gap-2 text-warning"><CircleAlert className="h-4 w-4" /> Add: {m.label}</li>)}
          {a?.unverified.filter((f) => !f.includes('.')).map((f) => <li key={f} className="flex items-center gap-2 text-warning"><CircleAlert className="h-4 w-4" /> Confirm: {f}</li>)}
          {a?.issues.filter((i) => i.severity === 'error').map((i, n) => <li key={n} className="flex items-center gap-2 text-danger"><CircleAlert className="h-4 w-4" /> {i.message}</li>)}
          {a?.readyForAutomation && <li className="flex items-center gap-2 text-success"><CheckCircle2 className="h-4 w-4" /> Your profile is ready for automation.</li>}
          <li className="text-muted">Auto Mode also requires your explicit authorisation in Automation Settings.</li>
        </ul>
      </div>
      <div className="flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save & continue</Button></div>
    </Card>
  );
}

function ExtensionStep({ onNext }: { onNext: () => void }) {
  const { data: conns } = useConnections();
  const [code, setCode] = React.useState<string | null>(null);
  const connected = conns?.some((c) => !c.revokedAt);
  const gen = useAction(() => api.post<{ code: string }>('/extension/pairing-code'), { onSuccess: async (r) => { setCode(r.code); const ok = await pairExtension(r.code); if (ok?.ok) toast.success('Extension connected'); } });
  return (
    <Card className="space-y-5 p-6">
      <p className="text-muted">Applications run in your own Chrome through the ApplyFlux Agent extension. Install it, then pair it with this code.</p>
      {connected ? (
        <div className="flex items-center gap-2 rounded-xl bg-success/10 p-4 text-success"><CheckCircle2 className="h-5 w-5" /> Extension connected.</div>
      ) : code ? (
        <div><div className="text-sm text-muted">Enter this code in the extension popup:</div><div className="mt-2 inline-block rounded-xl border border-line bg-elevated px-5 py-3 font-mono text-3xl font-bold tracking-[0.2em]">{code}</div><div className="mt-2 flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Waiting for the extension…</div></div>
      ) : (
        <Button onClick={() => gen.mutate(undefined)} loading={gen.isPending}><Puzzle className="h-4 w-4" /> Generate pairing code</Button>
      )}
      <p className="text-sm text-muted">Need the extension? See <Link to="/app/extension" className="font-semibold text-brand-ink hover:underline">installation instructions</Link>.</p>
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onNext}>Skip for now</Button><Button disabled={!connected} onClick={onNext}>Continue</Button></div>
    </Card>
  );
}

function TestRunStep({ onNext }: { onNext: () => void }) {
  const [appId, setAppId] = React.useState<string | null>(null);
  const { data: app } = useApplication(appId);
  const { data: conns } = useConnections();
  const run = useAction(
    async () => {
      const job = await api.post<{ jobId: string }>('/sandbox/jobs', { scenario: 'standard' });
      const [q] = await api.post<Array<{ applicationId: string; status: string; reason?: string }>>('/applications/enqueue', { jobIds: [job.jobId], priority: 10 });
      if (!q.applicationId) throw new Error(q.reason ?? 'Could not queue the test');
      await api.post('/automation/start');
      return q.applicationId;
    },
    { onSuccess: setAppId, invalidate: [qk.automation] },
  );
  const connected = conns?.some((c) => !c.revokedAt);
  const done = app && ['SUBMITTED', 'SUBMISSION_UNVERIFIED', 'AWAITING_REVIEW'].includes(app.state);
  return (
    <Card className="space-y-5 p-6">
      <div className="flex items-start gap-4">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-soft text-brand-ink"><FlaskConical className="h-6 w-6" /></div>
        <div><p className="font-semibold">Practise on a mock application</p><p className="text-sm text-muted">The ApplyFlux Sandbox is a fictional employer. Nothing is sent to a real company. Watch the extension open the form, fill it with your verified details, and either wait for your review or submit it, depending on your mode.</p></div>
      </div>
      {!connected && <div className="rounded-xl bg-warning/10 p-3 text-sm text-warning">Connect the extension first to run the test.</div>}
      {!appId ? (
        <Button disabled={!connected} loading={run.isPending} onClick={() => run.mutate(undefined)}><Rocket className="h-4 w-4" /> Start test application</Button>
      ) : (
        <div className="rounded-2xl border border-line p-4">
          <div className="flex items-center justify-between gap-3"><div className="font-semibold">{app?.title ?? 'Sandbox application'}</div>{app && <StateBadge state={app.state} />}</div>
          <Progress value={app?.progress ?? 5} className="mt-3" label="Test progress" />
          <div className="mt-2 text-sm text-muted">{app?.intervention?.message ?? app?.currentStep ?? 'Waiting for the extension to pick it up…'}</div>
          {app?.state === 'AWAITING_REVIEW' && <p className="mt-3 text-sm">The form is filled and waiting in the tab — in Review/Assisted mode you submit it yourself, or approve it from <Link className="font-semibold text-brand-ink hover:underline" to={`/app/applications?id=${app.id}`}>Applications</Link>.</p>}
        </div>
      )}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onNext}>Skip</Button><Button disabled={!done} onClick={onNext}>{done ? 'Looks good — continue' : 'Continue'}</Button></div>
    </Card>
  );
}

function DiscoverStep({ onFinish }: { onFinish: () => void }) {
  return (
    <Card className="space-y-5 p-6">
      <p className="text-muted">ApplyFlux now searches company career sites and public job boards for roles that match your profile, keeps only recent postings, and queues the best matches for Auto Apply. Nothing to set up: it repeats on its own.</p>
      <DiscoveryPanel compact />
      <div className="flex justify-end gap-2"><Link to="/app/jobs" className={buttonVariants({ variant: 'ghost' })}>See the jobs</Link><Button onClick={onFinish}>Finish setup</Button></div>
    </Card>
  );
}
