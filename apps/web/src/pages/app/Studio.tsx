import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, FileCheck2, PenSquare, Plus, Sparkles, Trash2, Wand2, XCircle } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { qk, useAction, useCoverLetters, useDocuments, useJobs, useMe, useProfile } from '@/lib/queries';
import type { CoverLetter } from '@/lib/types';
import { timeAgo } from '@/lib/utils';
import { MatchExplanation } from './Jobs';

function JobPicker({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const { data } = useJobs({ sort: 'score', pageSize: 100 });
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a job…</option>
      {data?.items.map((j) => <option key={j.id} value={j.id}>{j.title} — {j.company}</option>)}
    </Select>
  );
}

interface Tailoring {
  id: string;
  analysis: { jobSkills: string[]; inResume: string[]; inProfileOnly: string[]; missing: string[]; coverage: number | null; suggestions: string[]; match: import('@/lib/types').MatchBreakdown };
}

export function ResumeStudio() {
  const [params] = useSearchParams();
  const { data: docs } = useDocuments('resume');
  const { data: me } = useMe();
  const { data: profile } = useProfile();
  const [docId, setDocId] = React.useState('');
  const [jobId, setJobId] = React.useState(params.get('job') ?? '');
  const [t, setT] = React.useState<Tailoring | null>(null);
  const [draft, setDraft] = React.useState<{ headline: string; summary: string; experiences: Array<{ index: number; bullets: string[] }>; skillsOrder: string[]; warnings: string[] } | null>(null);
  React.useEffect(() => { if (!docId && docs?.length) setDocId((docs.find((d) => d.isDefault) ?? docs[0]).id); }, [docs, docId]);
  const analyze = useAction(() => api.post<Tailoring>('/studio/analyze', { documentId: docId, jobId }), { onSuccess: (r) => { setT(r); setDraft(null); } });
  const tailor = useAction(() => api.post<NonNullable<typeof draft>>(`/studio/${t!.id}/tailor`), { onSuccess: setDraft });
  const save = useAction(() => api.post(`/studio/${t!.id}/save`, draft ?? { summary: profile?.profile.summary ?? '' }), { success: 'Saved as a new resume version', invalidate: [qk.documents('resume'), qk.documents()] });

  return (
    <div>
      <PageHeader eyebrow="Your materials" title="Resume Studio" description="See how a resume lines up with a specific job, and tailor wording to it — without adding skills or experience you don't have." />
      <Card className="mb-6 grid gap-4 p-5 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <Field label="Resume" htmlFor="st-doc">
          <Select id="st-doc" value={docId} onChange={(e) => setDocId(e.target.value)}>
            {!docs?.length && <option value="">Upload a resume first</option>}
            {docs?.map((d) => <option key={d.id} value={d.id}>{d.title} (v{d.version})</option>)}
          </Select>
        </Field>
        <Field label="Job" htmlFor="st-job"><JobPicker id="st-job" value={jobId} onChange={setJobId} /></Field>
        <Button disabled={!docId || !jobId} loading={analyze.isPending} onClick={() => analyze.mutate(undefined)}><Wand2 className="h-4 w-4" /> Analyze fit</Button>
      </Card>
      {!t ? (
        <EmptyState icon={<Wand2 className="h-5 w-5" />} title="Pick a resume and a job" description="ApplyFlux compares the job's requirements with your resume and verified profile, then suggests honest improvements." />
      ) : (
        <div className="grid gap-6 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader title="Keyword coverage" description={t.analysis.coverage == null ? 'No recognisable skills in this job description.' : `${t.analysis.coverage}% of the job's recognised skills appear in this resume.`} />
            <div className="space-y-5 p-5">
              <div><div className="mb-2 text-sm font-semibold">Already in your resume</div><div className="flex flex-wrap gap-1.5">{t.analysis.inResume.map((s) => <Badge key={s} tone="success"><CheckCircle2 className="h-3 w-3" /> {s}</Badge>)}{!t.analysis.inResume.length && <span className="text-sm text-muted">None</span>}</div></div>
              <div><div className="mb-2 text-sm font-semibold">In your profile but missing from this resume</div><div className="flex flex-wrap gap-1.5">{t.analysis.inProfileOnly.map((s) => <Badge key={s} tone="info">{s}</Badge>)}{!t.analysis.inProfileOnly.length && <span className="text-sm text-muted">None</span>}</div></div>
              <div><div className="mb-2 text-sm font-semibold">Gaps (not evidenced anywhere)</div><div className="flex flex-wrap gap-1.5">{t.analysis.missing.map((s) => <Badge key={s} tone="neutral"><XCircle className="h-3 w-3" /> {s}</Badge>)}{!t.analysis.missing.length && <span className="text-sm text-muted">None</span>}</div></div>
              {!!t.analysis.suggestions.length && <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{t.analysis.suggestions.map((s) => <li key={s}>{s}</li>)}</ul>}
              <div className="flex flex-wrap gap-2 border-t border-line pt-5">
                <Button onClick={() => tailor.mutate(undefined)} loading={tailor.isPending} disabled={!me?.aiConfigured}><Sparkles className="h-4 w-4" /> Draft tailored content</Button>
                {!me?.aiConfigured && <span className="self-center text-xs text-muted">AI drafting isn't configured on this server.</span>}
              </div>
              {draft && (
                <div className="space-y-4 rounded-2xl border border-line p-4">
                  {!!draft.warnings.length && <div className="rounded-xl bg-warning/10 p-3 text-sm text-warning">Check these before saving: {draft.warnings.join('; ')}</div>}
                  <Field label="Headline" htmlFor="td-h"><Input id="td-h" value={draft.headline} onChange={(e) => setDraft({ ...draft, headline: e.target.value })} /></Field>
                  <Field label="Summary" htmlFor="td-s"><Textarea id="td-s" rows={4} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></Field>
                  {draft.experiences.map((e) => (
                    <Field key={e.index} label={`${profile?.experiences[e.index]?.title ?? 'Role'} — ${profile?.experiences[e.index]?.company ?? ''}`} htmlFor={`td-e${e.index}`} hint="One bullet per line">
                      <Textarea id={`td-e${e.index}`} rows={4} value={e.bullets.join('\n')} onChange={(ev) => setDraft({ ...draft, experiences: draft.experiences.map((x) => (x.index === e.index ? { ...x, bullets: ev.target.value.split('\n') } : x)) })} />
                    </Field>
                  ))}
                  <Button onClick={() => save.mutate(undefined)} loading={save.isPending}><FileCheck2 className="h-4 w-4" /> Save as new resume version (PDF)</Button>
                </div>
              )}
            </div>
          </Card>
          <Card className="h-fit"><CardHeader title="Match for this job" /><div className="p-5"><MatchExplanation b={t.analysis.match} /></div></Card>
        </div>
      )}
    </div>
  );
}

export function CoverLetterStudio() {
  const { data, isLoading } = useCoverLetters();
  const { data: me } = useMe();
  const [editing, setEditing] = React.useState<Partial<CoverLetter> | null>(null);
  const [gen, setGen] = React.useState<{ jobId: string; length: 'concise' | 'detailed' } | null>(null);
  const inv = [qk.coverLetters, qk.documents()];
  const generate = useAction(() => api.post<CoverLetter>('/cover-letters/generate', gen), { success: 'Draft ready — review and approve it', invalidate: inv, onSuccess: (c) => { setGen(null); setEditing(c); } });
  const save = useAction(() => (editing?.id ? api.patch(`/cover-letters/${editing.id}`, { title: editing.title, body: editing.body }) : api.post('/cover-letters', { title: editing!.title, body: editing!.body, jobId: editing!.jobId ?? null, length: editing!.length ?? 'concise' })), { success: 'Saved', invalidate: inv, onSuccess: () => setEditing(null) });
  const approve = useAction((c: CoverLetter) => api.patch(`/cover-letters/${c.id}`, { status: c.status === 'approved' ? 'draft' : 'approved' }), { invalidate: inv, success: 'Updated' });
  const render = useAction((id: string) => api.post(`/cover-letters/${id}/render`), { success: 'PDF created — it can now be attached to applications', invalidate: inv });
  const del = useAction((id: string) => api.del(`/cover-letters/${id}`), { success: 'Deleted', invalidate: inv });
  return (
    <div>
      <PageHeader
        eyebrow="Your materials"
        title="Cover Letter Studio"
        description="Generate grounded drafts from your verified profile, edit them, and approve the ones ApplyFlux may attach."
        actions={<><Button variant="secondary" onClick={() => setEditing({ title: '', body: '', length: 'concise' })}><Plus className="h-4 w-4" /> Write one</Button><Button onClick={() => setGen({ jobId: '', length: 'concise' })} disabled={!me?.aiConfigured}><Sparkles className="h-4 w-4" /> Generate for a job</Button></>}
      />
      {isLoading && <Skeleton className="h-40 rounded-3xl" />}
      {data && !data.length && <EmptyState icon={<PenSquare className="h-5 w-5" />} title="No cover letters yet" description={me?.aiConfigured ? 'Generate one for a job or write your own reusable version.' : 'Write a reusable cover letter. (AI drafting is not configured on this server.)'} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((c) => (
          <Card key={c.id} className="flex flex-col p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><div className="truncate font-semibold">{c.title}</div><div className="text-xs text-muted">{c.jobCompany ? `${c.jobTitle} · ${c.jobCompany} · ` : ''}{c.length} · {timeAgo(c.updatedAt)}</div></div>
              <div className="flex gap-1.5">{c.generated && <Badge tone="info">AI draft</Badge>}<Badge tone={c.status === 'approved' ? 'success' : 'warning'}>{c.status}</Badge></div>
            </div>
            <p className="mt-3 line-clamp-5 whitespace-pre-line text-sm text-muted">{c.body}</p>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              <Button size="sm" variant="secondary" onClick={() => setEditing(c)}>Edit</Button>
              <Button size="sm" variant={c.status === 'approved' ? 'ghost' : 'soft'} onClick={() => approve.mutate(c)}>{c.status === 'approved' ? 'Unapprove' : 'Approve'}</Button>
              <Button size="sm" variant="ghost" loading={render.isPending && render.variables === c.id} onClick={() => render.mutate(c.id)}>{c.documentId ? 'Re-render PDF' : 'Create PDF'}</Button>
              <Button size="icon" variant="ghost" className="ml-auto" aria-label="Delete" onClick={() => del.mutate(c.id)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </Card>
        ))}
      </div>
      <Dialog open={!!gen} onOpenChange={(o) => !o && setGen(null)} title="Generate a cover letter" description="Uses only your profile facts. You'll review before anything is used." footer={<Button loading={generate.isPending} disabled={!gen?.jobId} onClick={() => generate.mutate(undefined)}><Sparkles className="h-4 w-4" /> Generate</Button>}>
        {gen && <div className="space-y-4"><Field label="Job" htmlFor="cl-job"><JobPicker id="cl-job" value={gen.jobId} onChange={(v) => setGen({ ...gen, jobId: v })} /></Field><Field label="Length" htmlFor="cl-len"><Select id="cl-len" value={gen.length} onChange={(e) => setGen({ ...gen, length: e.target.value as 'concise' })}><option value="concise">Concise (≈200 words)</option><option value="detailed">Detailed (≈350 words)</option></Select></Field></div>}
      </Dialog>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={editing?.id ? 'Edit cover letter' : 'New cover letter'} wide footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending} disabled={!editing?.title || !editing?.body} onClick={() => save.mutate(undefined)}>Save</Button></>}>
        {editing && (
          <div className="space-y-4">
            {!!editing.warnings?.length && <div className="rounded-xl bg-warning/10 p-3 text-sm text-warning">Possible unsupported details — please check: {editing.warnings.join('; ')}</div>}
            <Field label="Title" htmlFor="ce-t"><Input id="ce-t" value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
            <Field label="Letter" htmlFor="ce-b"><Textarea id="ce-b" rows={16} value={editing.body ?? ''} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}
