import * as React from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Download, Eye, FileText, FileUp, Layers, ScanText, Star, Trash2, UploadCloud } from 'lucide-react';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton } from '@/components/ui';
import { api, errorMessage, fileUrl } from '@/lib/api';
import { qk, useAction, useDocuments } from '@/lib/queries';
import type { Doc } from '@/lib/types';
import { formatDate } from '@/lib/utils';
import { toast } from 'sonner';

export function UploadZone({ onUploaded, rootDocumentId, compact }: { onUploaded?: (d: Doc) => void; rootDocumentId?: string; compact?: boolean }) {
  const [drag, setDrag] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const up = useAction(
    (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', 'resume');
      if (rootDocumentId) fd.append('rootDocumentId', rootDocumentId);
      return api.upload<Doc>('/documents', fd);
    },
    { success: (d) => (d.parseStatus === 'failed' ? 'Uploaded, but no text could be read' : 'Resume uploaded'), invalidate: [qk.documents('resume'), qk.documents(), qk.me], onSuccess: onUploaded },
  );
  const pick = (f?: File | null) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast.error('Files must be 10 MB or smaller');
    up.mutate(f);
  };
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
      className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed text-center transition ${compact ? 'p-6' : 'p-10'} ${drag ? 'border-brand bg-brand-soft/50' : 'border-line hover:border-brand/40'}`}
    >
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-soft text-brand-ink"><UploadCloud className="h-6 w-6" /></div>
      <p className="mt-4 font-semibold">{rootDocumentId ? 'Upload a new version' : 'Drop your resume here'}</p>
      <p className="mt-1 text-sm text-muted">PDF, DOCX, TXT, MD or RTF · up to 10 MB</p>
      <input ref={input} type="file" accept=".pdf,.docx,.txt,.md,.rtf" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} aria-label="Choose resume file" />
      <Button className="mt-5" variant="secondary" loading={up.isPending} onClick={() => input.current?.click()}><FileUp className="h-4 w-4" /> Choose file</Button>
    </div>
  );
}

export function ResumeLibrary() {
  const { data, isLoading, error, refetch } = useDocuments('resume');
  const [preview, setPreview] = React.useState<{ url: string; doc: Doc } | null>(null);
  const [del, setDel] = React.useState<Doc | null>(null);
  const [rename, setRename] = React.useState<Doc | null>(null);
  const [title, setTitle] = React.useState('');
  const nav = useNavigate();
  const inv = [qk.documents('resume'), qk.documents(), qk.me];
  const makeDefault = useAction((id: string) => api.patch(`/documents/${id}`, { isDefault: true }), { success: 'Default resume updated', invalidate: inv });
  const remove = useAction((id: string) => api.del(`/documents/${id}`), { success: 'Resume deleted', invalidate: inv, onSuccess: () => setDel(null) });
  const doRename = useAction(() => api.patch(`/documents/${rename!.id}`, { title }), { success: 'Renamed', invalidate: inv, onSuccess: () => setRename(null) });
  const parse = useAction((id: string) => api.post<{ id: string }>(`/documents/${id}/parse`), { onSuccess: (p) => nav(`/app/resumes/review/${p.id}`) });

  const groups = React.useMemo(() => {
    const m = new Map<string, Doc[]>();
    for (const d of data ?? []) {
      const k = d.rootDocumentId ?? d.id;
      m.set(k, [...(m.get(k) ?? []), d]);
    }
    return [...m.values()].map((g) => g.sort((a, b) => b.version - a.version));
  }, [data]);

  const open = async (d: Doc, download = false) => {
    try {
      const url = await fileUrl(`/documents/${d.id}/file${download ? '?download=1' : ''}`);
      if (download) {
        const a = document.createElement('a');
        a.href = url;
        a.download = d.fileName;
        a.click();
      } else setPreview({ url, doc: d });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <PageHeader eyebrow="Your materials" title="Resume library" description="Keep multiple resumes and versions. The default resume is attached unless you pick another for a job." />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {error && <ErrorState error={error} onRetry={refetch} />}
          {isLoading && <Skeleton className="h-40 rounded-3xl" />}
          {data && !data.length && <EmptyState icon={<FileText className="h-5 w-5" />} title="No resumes yet" description="Upload your resume to build your profile and attach it to applications." />}
          {groups.map((g) => {
            const latest = g[0];
            return (
              <Card key={latest.id}>
                <CardHeader
                  title={<span className="inline-flex items-center gap-2">{latest.title} {g.some((d) => d.isDefault) && <Badge tone="info"><Star className="h-3 w-3" /> Default</Badge>}</span>}
                  description={`${g.length} version${g.length > 1 ? 's' : ''} · ${latest.origin === 'tailored' ? 'Tailored' : 'Uploaded'} ${formatDate(latest.createdAt)}`}
                  action={<Button size="sm" variant="secondary" onClick={() => setRename(latest)}>Rename</Button>}
                />
                <ul className="divide-y divide-line">
                  {g.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                      <Layers className="h-4 w-4 text-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">v{d.version} · {d.fileName}</div>
                        <div className="text-xs text-muted">
                          {(d.sizeBytes / 1024).toFixed(0)} KB · {formatDate(d.createdAt)} · {d.parseStatus === 'parsed' ? 'Text readable' : d.parseStatus === 'failed' ? <span className="text-danger">{d.parseError}</span> : d.parseStatus}
                        </div>
                      </div>
                      {d.isDefault ? <Badge tone="info">Default</Badge> : <Button size="sm" variant="ghost" onClick={() => makeDefault.mutate(d.id)}>Make default</Button>}
                      <Button size="icon" variant="ghost" aria-label="Preview" onClick={() => open(d)}><Eye className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" aria-label="Download" onClick={() => open(d, true)}><Download className="h-4 w-4" /></Button>
                      {d.parseStatus === 'parsed' && (
                        <Button size="sm" variant="soft" loading={parse.isPending && parse.variables === d.id} onClick={() => parse.mutate(d.id)}><ScanText className="h-4 w-4" /> Extract to profile</Button>
                      )}
                      <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setDel(d)}><Trash2 className="h-4 w-4" /></Button>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-line p-4"><UploadZone rootDocumentId={latest.rootDocumentId ?? latest.id} compact /></div>
              </Card>
            );
          })}
        </div>
        <div className="space-y-4">
          <UploadZone onUploaded={(d) => d.parseStatus === 'parsed' && parse.mutate(d.id)} />
          <p className="text-xs text-muted">After upload, ApplyFlux extracts your details for review. Nothing is added to your profile until you confirm it.</p>
        </div>
      </div>
      <Dialog open={!!preview} onOpenChange={(o) => { if (!o && preview) URL.revokeObjectURL(preview.url); if (!o) setPreview(null); }} title={preview?.doc.title ?? ''} description={preview?.doc.fileName} wide>
        {preview && (preview.doc.mimeType === 'application/pdf' || preview.doc.mimeType.startsWith('text/') ? <iframe src={preview.url} title="Resume preview" className="h-[70vh] w-full rounded-xl border border-line bg-white" /> : <p className="text-sm text-muted">Preview isn't available for this file type. Download it to view.</p>)}
      </Dialog>
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title="Delete this resume?" description={del && !del.rootDocumentId ? 'This deletes the resume and all its versions permanently.' : 'This version will be deleted permanently.'} danger confirmLabel="Delete" loading={remove.isPending} onConfirm={() => del && remove.mutate(del.id)} />
      <Dialog open={!!rename} onOpenChange={(o) => { if (o && rename) setTitle(rename.title); if (!o) setRename(null); }} title="Rename resume" footer={<Button loading={doRename.isPending} onClick={() => doRename.mutate(undefined)}>Save</Button>}>
        <Field label="Title" htmlFor="rn"><Input id="rn" value={title || rename?.title || ''} onChange={(e) => setTitle(e.target.value)} /></Field>
      </Dialog>
    </div>
  );
}

/* Parse review --------------------------------------------------------------- */

interface Extracted {
  firstName: string | null; lastName: string | null; email: string | null; phone: string | null; city: string | null; region: string | null; country: string | null;
  linkedinUrl: string | null; githubUrl: string | null; portfolioUrl: string | null; headline: string | null; summary: string | null; skills: string[];
  languages: Array<{ language: string; proficiency: string | null }>;
  experiences: Array<{ company: string; title: string; location: string | null; startDate: string | null; endDate: string | null; isCurrent: boolean; description: string | null; achievements: string[] }>;
  educations: Array<{ institution: string; degree: string | null; fieldOfStudy: string | null; startDate: string | null; endDate: string | null }>;
  certifications: Array<{ name: string; issuer: string | null; issuedOn: string | null }>;
  projects: Array<{ name: string; url: string | null; description: string | null }>;
  uncertain: string[];
}

export function ParseReview({ onDone, parseId }: { onDone?: () => void; parseId?: string }) {
  const params = useParams();
  const id = parseId ?? params.id;
  const nav = useNavigate();
  const [parse, setParse] = React.useState<{ method: string; extracted: Extracted; warnings: string[] } | null>(null);
  const [x, setX] = React.useState<Extracted | null>(null);
  const [confirmed, setConfirmed] = React.useState<Set<string>>(new Set());
  const [confirmHistory, setConfirmHistory] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  React.useEffect(() => {
    api.get<{ method: string; extracted: Extracted; warnings: string[] }>(`/resume-parses/${id}`).then((p) => { setParse(p); setX(p.extracted); }).catch(setError);
  }, [id]);
  const apply = useAction(() => api.post(`/resume-parses/${id}/apply`, { extracted: x, confirmedFields: [...confirmed], confirmHistory }), {
    success: 'Profile updated from your resume',
    invalidate: [qk.profile, qk.me, ['jobs']],
    onSuccess: () => (onDone ? onDone() : nav('/app/profile')),
  });
  if (error) return <ErrorState error={error} />;
  if (!x || !parse) return <Skeleton className="h-96 rounded-3xl" />;
  const simple: Array<[keyof Extracted, string]> = [['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['city', 'City'], ['country', 'Country'], ['linkedinUrl', 'LinkedIn'], ['githubUrl', 'GitHub'], ['portfolioUrl', 'Portfolio'], ['headline', 'Headline']];
  const toggle = (k: string) => setConfirmed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  return (
    <div>
      {!onDone && <Link to="/app/resumes" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" /> Resume library</Link>}
      <PageHeader eyebrow="Review extraction" title="Check what we found" description="Edit anything that's wrong and tick the details you confirm are correct. Unticked details are saved as unverified and won't be used in Auto Mode." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone="info">{parse.method === 'ai' ? 'AI extraction, cross-checked against your file' : 'Rule-based extraction'}</Badge>
        {parse.warnings.map((w) => <Badge key={w} tone="warning">{w}</Badge>)}
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader title="Contact & basics" action={<Button size="sm" variant="ghost" onClick={() => setConfirmed(new Set(simple.filter(([k]) => x[k]).map(([k]) => k as string)))}>Confirm all</Button>} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            {simple.map(([k, l]) => (
              <Field key={k} label={l} htmlFor={`x-${k}`} badge={x.uncertain.includes(k as string) ? <Badge tone="warning">Unsure</Badge> : undefined}>
                <div className="flex items-center gap-2">
                  <Input id={`x-${k}`} value={(x[k] as string) ?? ''} onChange={(e) => setX({ ...x, [k]: e.target.value || null })} />
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted"><input type="checkbox" className="h-4 w-4 accent-[rgb(var(--brand))]" checked={confirmed.has(k as string)} onChange={() => toggle(k as string)} disabled={!x[k]} /> Correct</label>
                </div>
              </Field>
            ))}
            <Field label="Skills" htmlFor="x-skills" className="sm:col-span-2" hint="Comma separated">
              <Input id="x-skills" value={x.skills.join(', ')} onChange={(e) => setX({ ...x, skills: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            </Field>
          </div>
        </Card>
        <Card>
          <CardHeader title={`Work history (${x.experiences.length})`} description="Check titles, companies and dates carefully — these are used on applications." />
          <ul className="divide-y divide-line">
            {x.experiences.map((e, i) => (
              <li key={i} className="grid gap-3 p-5 sm:grid-cols-[1fr_1fr_8rem_8rem_auto]">
                <Input aria-label="Title" value={e.title} onChange={(ev) => setX({ ...x, experiences: x.experiences.map((y, j) => (j === i ? { ...y, title: ev.target.value } : y)) })} />
                <Input aria-label="Company" value={e.company} onChange={(ev) => setX({ ...x, experiences: x.experiences.map((y, j) => (j === i ? { ...y, company: ev.target.value } : y)) })} />
                <Input aria-label="Start" placeholder="YYYY-MM" value={e.startDate ?? ''} onChange={(ev) => setX({ ...x, experiences: x.experiences.map((y, j) => (j === i ? { ...y, startDate: ev.target.value || null } : y)) })} />
                <Input aria-label="End" placeholder={e.isCurrent ? 'Present' : 'YYYY-MM'} disabled={e.isCurrent} value={e.endDate ?? ''} onChange={(ev) => setX({ ...x, experiences: x.experiences.map((y, j) => (j === i ? { ...y, endDate: ev.target.value || null } : y)) })} />
                <Button size="icon" variant="ghost" aria-label="Remove role" onClick={() => setX({ ...x, experiences: x.experiences.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
              </li>
            ))}
            {!x.experiences.length && <li className="p-5 text-sm text-muted">No roles detected. You can add them on your profile.</li>}
          </ul>
        </Card>
        <Card>
          <CardHeader title={`Education (${x.educations.length}) · Certifications (${x.certifications.length})`} />
          <ul className="divide-y divide-line">
            {x.educations.map((e, i) => (
              <li key={i} className="grid gap-3 p-5 sm:grid-cols-[1.4fr_1fr_8rem_auto]">
                <Input aria-label="Institution" value={e.institution} onChange={(ev) => setX({ ...x, educations: x.educations.map((y, j) => (j === i ? { ...y, institution: ev.target.value } : y)) })} />
                <Input aria-label="Degree" value={e.degree ?? ''} onChange={(ev) => setX({ ...x, educations: x.educations.map((y, j) => (j === i ? { ...y, degree: ev.target.value || null } : y)) })} />
                <Input aria-label="End" value={e.endDate ?? ''} onChange={(ev) => setX({ ...x, educations: x.educations.map((y, j) => (j === i ? { ...y, endDate: ev.target.value || null } : y)) })} />
                <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setX({ ...x, educations: x.educations.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
              </li>
            ))}
            {x.certifications.map((c, i) => <li key={`c${i}`} className="px-5 py-3 text-sm">{c.name}{c.issuer ? ` · ${c.issuer}` : ''}</li>)}
          </ul>
        </Card>
        <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[rgb(var(--brand))]" checked={confirmHistory} onChange={(e) => setConfirmHistory(e.target.checked)} /> I've checked the work history and education above — mark them as verified</label>
          <Button loading={apply.isPending} onClick={() => apply.mutate(undefined)}>Save to profile</Button>
        </Card>
      </div>
    </div>
  );
}
