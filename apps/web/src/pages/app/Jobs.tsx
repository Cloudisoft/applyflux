import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Bookmark, BookmarkCheck, Briefcase, CheckCircle2, ExternalLink, Link2, ListPlus, MapPin, Plus, RefreshCw, Save, Search, Sparkles, Star, Trash2, XCircle } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Textarea, Tip, buttonVariants } from '@/components/ui';
import { ScoreRing, StateBadge } from '@/components/brand';
import { api } from '@/lib/api';
import { qk, useAction, useJob, useJobs, useSavedSearches, useSources } from '@/lib/queries';
import type { Job, MatchBreakdown } from '@/lib/types';
import { DiscoveryPanel } from '@/components/discovery';
import { cn, salaryRange, timeAgo } from '@/lib/utils';

type Filters = { q?: string; location?: string; remoteOnly?: boolean; employmentType?: string; salaryMin?: string; minScore?: string; excludeApplied?: boolean; bookmarked?: boolean; sponsorshipOk?: boolean; sort: string; page: number };

export function JobRow({ job, selected, onSelect }: { job: Job; selected?: boolean; onSelect?: (v: boolean) => void }) {
  const toggle = useAction((b: boolean) => api.patch(`/jobs/${job.id}`, { isBookmarked: b }), { invalidate: [['jobs']] });
  const sal = salaryRange(job.salaryMin, job.salaryMax, job.salaryCurrency);
  return (
    <div className={cn('flex items-center gap-4 px-5 py-4 transition hover:bg-elevated/60', selected && 'bg-brand-soft/40')}>
      {onSelect && <input type="checkbox" className="h-4 w-4 rounded accent-[rgb(var(--brand))]" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${job.title}`} disabled={!!job.applicationState && !['DISCOVERED', 'SHORTLISTED', 'SKIPPED', 'FAILED'].includes(job.applicationState)} />}
      <Tip content={job.breakdown ? `${job.breakdown.matchedSkills.length} matching skills${job.breakdown.concerns.length ? ` · ${job.breakdown.concerns.length} concern(s)` : ''}` : 'Not scored yet'}>
        <span>
          <ScoreRing score={job.score} />
        </span>
      </Tip>
      <Link to={`/app/jobs/${job.id}`} className="min-w-0 flex-1">
        <div className="truncate font-semibold hover:underline">{job.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span className="truncate">{job.company}</span>
          {job.location && (
            <span className="inline-flex items-center gap-1 truncate">
              <MapPin className="h-3.5 w-3.5" />
              {job.location}
            </span>
          )}
          {sal && <span>{sal}</span>}
          <span className="text-xs">{timeAgo(job.postedAt ?? job.createdAt)}</span>
        </div>
      </Link>
      <div className="hidden items-center gap-2 md:flex">
        {job.liveness === 'expired' && <Badge tone="danger">Expired</Badge>}
        {job.breakdown?.concerns.length ? (
          <Tip content={job.breakdown.concerns.join(' · ')}>
            <span>
              <Badge tone="warning">
                <AlertTriangle className="h-3 w-3" /> {job.breakdown.concerns.length}
              </Badge>
            </span>
          </Tip>
        ) : null}
        {job.atsVendor && <Badge tone="neutral" className="capitalize">{job.atsVendor}</Badge>}
        {job.applicationState && <StateBadge state={job.applicationState} />}
      </div>
      <button onClick={() => toggle.mutate(!job.isBookmarked)} className="rounded-lg p-2 text-muted hover:bg-elevated hover:text-brand-ink" aria-label={job.isBookmarked ? 'Remove bookmark' : 'Bookmark'}>
        {job.isBookmarked ? <BookmarkCheck className="h-5 w-5 text-brand" /> : <Bookmark className="h-5 w-5" />}
      </button>
    </div>
  );
}

export function JobDiscovery({ matchMode = false }: { matchMode?: boolean }) {
  const [f, setF] = React.useState<Filters>({ sort: matchMode ? 'score' : 'recent', page: 1, minScore: matchMode ? '60' : undefined, excludeApplied: matchMode });
  const [qDraft, setQDraft] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = React.useState(false);
  const [sourcesOpen, setSourcesOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [searchName, setSearchName] = React.useState('');
  const { data, isLoading, error, refetch, isFetching } = useJobs({ ...f, pageSize: 25 });
  const { data: saved } = useSavedSearches();
  const enqueue = useAction((ids: string[]) => api.post<Array<{ status: string; reason?: string }>>('/applications/enqueue', { jobIds: ids }), {
    invalidate: [['jobs'], ['applications'], qk.dashboard],
    success: (r) => {
      const q = r.filter((x) => x.status === 'queued').length;
      const skipped = r.filter((x) => x.status === 'skipped');
      return `${q} queued${skipped.length ? ` · ${skipped.length} skipped (${skipped[0].reason})` : ''}`;
    },
    onSuccess: () => setSelected(new Set()),
  });
  const saveSearch = useAction((name: string) => api.post('/saved-searches', { name, query: { ...f, page: undefined } }), { success: 'Search saved', invalidate: [qk.savedSearches], onSuccess: () => setSaveOpen(false) });
  const set = (patch: Partial<Filters>) => setF((p) => ({ ...p, ...patch, page: patch.page ?? 1 }));

  return (
    <div>
      <PageHeader
        eyebrow={matchMode ? 'Smart Match' : 'Opportunities'}
        title={matchMode ? 'Your best matches' : 'Job Discovery'}
        description={matchMode ? 'Roles ranked by a transparent score against your verified profile. Open any role to see exactly why.' : 'Recent jobs ApplyFlux found for you across company career sites and job boards. The best matches are queued for Auto Apply automatically.'}
        actions={
          !matchMode && (
            <>
              <Button variant="secondary" onClick={() => setSourcesOpen(true)}>
                <RefreshCw className="h-4 w-4" /> Follow a company
              </Button>
              <Button onClick={() => setImportOpen(true)}>
                <Plus className="h-4 w-4" /> Import a job
              </Button>
            </>
          )
        }
      />
      {!matchMode && <DiscoveryPanel />}
      <Card className="mb-4 p-4">
        <form
          className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: qDraft || undefined });
            // Pressing Search always fetches fresh results, even when the filters did not change.
            void refetch();
          }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input className="pl-9" placeholder="Title, keyword or company" value={qDraft} onChange={(e) => setQDraft(e.target.value)} aria-label="Keywords" />
          </div>
          <Input placeholder="Location" value={f.location ?? ''} onChange={(e) => set({ location: e.target.value || undefined })} aria-label="Location" />
          <Select value={f.sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort">
            <option value="score">Best match</option>
            <option value="recent">Most recent</option>
            <option value="company">Company A–Z</option>
          </Select>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {[
            ['remoteOnly', 'Remote only'],
            ['excludeApplied', 'Hide applied'],
            ['bookmarked', 'Bookmarked'],
            ['sponsorshipOk', 'No "no sponsorship" statement'],
          ].map(([k, l]) => (
            <button key={k} type="button" onClick={() => set({ [k]: !f[k as keyof Filters] } as Partial<Filters>)} className={cn('rounded-full border px-3 py-1 font-medium transition', f[k as keyof Filters] ? 'border-brand/40 bg-brand-soft text-brand-ink' : 'border-line text-muted hover:text-ink')} aria-pressed={!!f[k as keyof Filters]}>
              {l}
            </button>
          ))}
          <Select className="h-8 w-auto text-xs" value={f.employmentType ?? ''} onChange={(e) => set({ employmentType: e.target.value || undefined })} aria-label="Employment type">
            <option value="">Any type</option>
            <option value="full_time">Full-time</option>
            <option value="part_time">Part-time</option>
            <option value="contract">Contract</option>
            <option value="internship">Internship</option>
          </Select>
          <Select className="h-8 w-auto text-xs" value={f.minScore ?? ''} onChange={(e) => set({ minScore: e.target.value || undefined })} aria-label="Minimum match score">
            <option value="">Any score</option>
            {[40, 50, 60, 70, 80].map((s) => (
              <option key={s} value={s}>Score ≥ {s}</option>
            ))}
          </Select>
          <Input className="h-8 w-36 text-xs" type="number" min={0} placeholder="Min salary" value={f.salaryMin ?? ''} onChange={(e) => set({ salaryMin: e.target.value || undefined })} aria-label="Minimum salary" />
          <div className="ml-auto flex items-center gap-2">
            {!!saved?.length && (
              <Select className="h-8 w-auto text-xs" value="" onChange={(e) => { const s = saved.find((x) => x.id === e.target.value); if (s) { setF({ sort: 'score', page: 1, ...(s.query as Partial<Filters>) }); setQDraft(String(s.query.q ?? '')); } }} aria-label="Saved searches">
                <option value="">Saved searches…</option>
                {saved.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            )}
            <Button size="sm" variant="ghost" onClick={() => { setSearchName([f.q, f.location, f.remoteOnly ? 'Remote' : ''].filter(Boolean).join(' · ') || 'My search'); setSaveOpen(true); }}>
              <Save className="h-4 w-4" /> Save search
            </Button>
          </div>
        </div>
      </Card>

      {selected.size > 0 && (
        <div className="sticky top-20 z-10 mb-4 flex items-center justify-between rounded-2xl gradient-brand px-5 py-3 text-white shadow-glow animate-fade-up">
          <span className="text-sm font-semibold">{selected.size} selected</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" variant="secondary" loading={enqueue.isPending} onClick={() => enqueue.mutate([...selected])}>
              <ListPlus className="h-4 w-4" /> Add to queue
            </Button>
          </div>
        </div>
      )}

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <Card className={cn('overflow-hidden transition', isFetching && 'opacity-80')}>
          {isLoading && (
            <div className="space-y-3 p-5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          )}
          {data && !data.items.length && (
            <EmptyState
              className="m-5 border-0"
              icon={<Briefcase className="h-5 w-5" />}
              title={matchMode ? 'No strong matches yet' : 'No jobs here yet'}
              description={matchMode ? 'Lower the minimum score, or add more target titles to your profile. New jobs arrive automatically.' : 'ApplyFlux is searching for you. Jobs appear here as soon as the search finishes; you can also import a job by URL.'}
              action={!matchMode ? <Button variant="secondary" onClick={() => setImportOpen(true)}>Import a job</Button> : <Link to="/app/jobs" className={buttonVariants({ variant: 'secondary' })}>Go to Job Discovery</Link>}
            />
          )}
          <div className="divide-y divide-line">
            {data?.items.map((j) => (
              <JobRow key={j.id} job={j} selected={selected.has(j.id)} onSelect={(v) => setSelected((s) => { const n = new Set(s); v ? n.add(j.id) : n.delete(j.id); return n; })} />
            ))}
          </div>
          {data && data.total > data.pageSize && (
            <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
              <span className="text-muted">
                Page {data.page} of {Math.ceil(data.total / data.pageSize)} · {data.total} jobs
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={data.page <= 1} onClick={() => set({ page: data.page - 1 })}>Previous</Button>
                <Button size="sm" variant="secondary" disabled={data.page * data.pageSize >= data.total} onClick={() => set({ page: data.page + 1 })}>Next</Button>
              </div>
            </div>
          )}
        </Card>
      )}
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <Dialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Save this search"
        description="Saved searches keep your filters one click away."
        footer={<><Button variant="secondary" onClick={() => setSaveOpen(false)}>Cancel</Button><Button disabled={!searchName.trim()} loading={saveSearch.isPending} onClick={() => saveSearch.mutate(searchName.trim())}>Save</Button></>}
      >
        <form onSubmit={(e) => { e.preventDefault(); if (searchName.trim()) saveSearch.mutate(searchName.trim()); }}>
          <Field label="Name" htmlFor="search-name"><Input id="search-name" autoFocus value={searchName} onChange={(e) => setSearchName(e.target.value)} maxLength={80} /></Field>
        </form>
      </Dialog>
      <SourcesDialog open={sourcesOpen} onOpenChange={setSourcesOpen} />
    </div>
  );
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = React.useState({ url: '', title: '', company: '', location: '', description: '' });
  const nav = useNavigate();
  const imp = useAction(() => api.post<{ id: string; duplicateOf: string | null }>('/jobs/import', { ...form, location: form.location || undefined, description: form.description || undefined }), {
    success: (r) => (r.duplicateOf ? 'Imported — looks like a duplicate of a job you already have' : 'Job imported'),
    invalidate: [['jobs']],
    onSuccess: (r) => {
      onOpenChange(false);
      nav(`/app/jobs/${r.id}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Import a job" description="Paste the posting's details. ApplyFlux doesn't crawl arbitrary websites — you can also use “Save job” in the extension on any posting page." wide
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={imp.isPending} disabled={!form.url || !form.title || !form.company} onClick={() => imp.mutate(undefined)}>Import</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Job URL" htmlFor="ji-url" className="sm:col-span-2"><Input id="ji-url" type="url" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" /></Field>
        <Field label="Job title" htmlFor="ji-title"><Input id="ji-title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Company" htmlFor="ji-company"><Input id="ji-company" required value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></Field>
        <Field label="Location" htmlFor="ji-loc" className="sm:col-span-2"><Input id="ji-loc" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
        <Field label="Description" htmlFor="ji-desc" hint="Used for match scoring, tailoring and answers." className="sm:col-span-2"><Textarea id="ji-desc" rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function SourcesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = useSources();
  const [url, setUrl] = React.useState('');
  const add = useAction(() => api.post('/sources', { url }), { success: 'Source added — syncing…', invalidate: [qk.sources], onSuccess: (s) => { setUrl(''); sync.mutate((s as { id: string }).id); } });
  const sync = useAction((id: string) => api.post<{ created: number; total: number; expired: number }>(`/sources/${id}/sync`), { success: (r) => `Synced ${r.total} jobs (${r.created} new${r.expired ? `, ${r.expired} expired` : ''})`, invalidate: [qk.sources, ['jobs'], qk.dashboard] });
  const del = useAction((id: string) => api.del(`/sources/${id}`), { success: 'Source removed', invalidate: [qk.sources] });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Job sources" description="Follow companies through their public job boards. Supported: Greenhouse, Lever and Ashby." wide>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined); }}>
        <div className="relative flex-1">
          <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="https://jobs.lever.co/company or https://job-boards.greenhouse.io/company" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Careers board URL" />
        </div>
        <Button type="submit" loading={add.isPending} disabled={!url}>Add</Button>
      </form>
      <div className="mt-5 divide-y divide-line rounded-2xl border border-line">
        {!data?.length && <p className="p-5 text-sm text-muted">No sources yet.</p>}
        {data?.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{s.name}</div>
              <div className="text-xs text-muted">
                <span className="capitalize">{s.kind}</span> · {s.identifier} · {s.lastSyncedAt ? `synced ${timeAgo(s.lastSyncedAt)} (${s.lastJobCount ?? 0} jobs)` : 'never synced'}
              </div>
              {s.lastError && <div className="mt-1 text-xs text-danger">{s.lastError}</div>}
            </div>
            <Button size="sm" variant="secondary" loading={sync.isPending && sync.variables === s.id} onClick={() => sync.mutate(s.id)}>
              <RefreshCw className="h-3.5 w-3.5" /> Sync
            </Button>
            <Button size="icon" variant="ghost" onClick={() => del.mutate(s.id)} aria-label={`Remove ${s.name}`}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function MatchExplanation({ b }: { b: MatchBreakdown }) {
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        {b.components.map((c) => (
          <div key={c.key}>
            <div className="flex justify-between text-sm">
              <span className="font-medium">{c.label}</span>
              <span className="text-muted">{Math.round(c.score * c.weight)} / {c.weight}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full gradient-brand" style={{ width: `${c.score * 100}%` }} />
            </div>
            <div className="mt-1 text-xs text-muted">{c.detail}</div>
          </div>
        ))}
      </div>
      {!!b.matchedSkills.length && (
        <div>
          <div className="mb-2 text-sm font-semibold">Matching skills</div>
          <div className="flex flex-wrap gap-1.5">{b.matchedSkills.map((s) => <Badge key={s} tone="success"><CheckCircle2 className="h-3 w-3" /> {s}</Badge>)}</div>
        </div>
      )}
      {!!b.missingSkills.length && (
        <div>
          <div className="mb-2 text-sm font-semibold">Not in your profile</div>
          <div className="flex flex-wrap gap-1.5">{b.missingSkills.map((s) => <Badge key={s} tone="neutral"><XCircle className="h-3 w-3" /> {s}</Badge>)}</div>
          <p className="mt-2 text-xs text-muted">ApplyFlux never adds these to your applications. If you genuinely have one, add it to your profile.</p>
        </div>
      )}
      {!!b.concerns.length && (
        <div className="rounded-xl bg-warning/10 p-3">
          <div className="mb-1 text-sm font-semibold text-warning">Potential concerns</div>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">{b.concerns.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
      {!!b.highlights.length && <div className="flex items-center gap-2 text-sm text-success"><Star className="h-4 w-4" /> {b.highlights.join(' · ')}</div>}
    </div>
  );
}

export function JobDetail() {
  const { id } = useParams();
  const { data: j, isLoading, error, refetch } = useJob(id!);
  const nav = useNavigate();
  const enqueue = useAction(() => api.post<Array<{ status: string; reason?: string }>>('/applications/enqueue', { jobIds: [id] }), { invalidate: [['job'], ['jobs'], ['applications']], success: (r) => (r[0].status === 'queued' ? 'Added to queue' : r[0].reason ?? 'Already in progress') });
  const shortlist = useAction(() => api.post(`/jobs/${id}/shortlist`), { success: 'Shortlisted', invalidate: [['job'], ['jobs']] });
  const live = useAction(() => api.post<{ result: string; reason: string }>(`/jobs/${id}/liveness`), { success: (r) => `Listing ${r.result}: ${r.reason}`, invalidate: [['job']] });
  const cover = useAction(() => api.post('/cover-letters/generate', { jobId: id, length: 'concise' }), { success: 'Cover letter drafted — review it in Cover Letters', invalidate: [qk.coverLetters], onSuccess: () => nav('/app/cover-letters') });
  const del = useAction(() => api.del(`/jobs/${id}`), { success: 'Job removed', invalidate: [['jobs']], onSuccess: () => nav('/app/jobs') });
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !j) return <Skeleton className="h-96 rounded-3xl" />;
  const canQueue = !j.applicationState || ['DISCOVERED', 'SHORTLISTED', 'SKIPPED', 'FAILED'].includes(j.applicationState);
  return (
    <div>
      <Link to="/app/jobs" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" /> Back to jobs</Link>
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card className="p-6">
            <div className="flex flex-wrap items-start gap-4">
              <ScoreRing score={j.score} size={64} />
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-bold">{j.title}</h1>
                <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-muted">
                  <span className="font-medium text-ink">{j.company}</span>
                  {j.location && <span>{j.location}</span>}
                  {salaryRange(j.salaryMin, j.salaryMax, j.salaryCurrency) && <span>{salaryRange(j.salaryMin, j.salaryMax, j.salaryCurrency)}</span>}
                  {j.employmentType && <span className="capitalize">{j.employmentType.replace('_', ' ')}</span>}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {j.applicationState && <StateBadge state={j.applicationState} />}
                  {j.atsVendor && <Badge className="capitalize">{j.atsVendor}</Badge>}
                  <Badge tone={j.liveness === 'expired' ? 'danger' : j.liveness === 'active' ? 'success' : 'neutral'}>{j.liveness === 'unknown' ? 'Not checked' : j.liveness}</Badge>
                </div>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              {canQueue && <Button onClick={() => enqueue.mutate(undefined)} loading={enqueue.isPending} disabled={j.liveness === 'expired'}><ListPlus className="h-4 w-4" /> Add to queue</Button>}
              {!j.applicationState && <Button variant="secondary" onClick={() => shortlist.mutate(undefined)} loading={shortlist.isPending}><Star className="h-4 w-4" /> Shortlist</Button>}
              <a href={j.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'secondary' })}><ExternalLink className="h-4 w-4" /> Open posting</a>
              <Button variant="secondary" onClick={() => cover.mutate(undefined)} loading={cover.isPending}><Sparkles className="h-4 w-4" /> Draft cover letter</Button>
              <Link to={`/app/studio?job=${j.id}`} className={buttonVariants({ variant: 'secondary' })}>Tailor resume</Link>
              <Button variant="ghost" onClick={() => live.mutate(undefined)} loading={live.isPending}><RefreshCw className="h-4 w-4" /> Check listing</Button>
              {j.applicationId && <Link to={`/app/applications?id=${j.applicationId}`} className={buttonVariants({ variant: 'ghost' })}>View application</Link>}
              {(!j.applicationState || ['DISCOVERED', 'SHORTLISTED', 'SKIPPED'].includes(j.applicationState)) && <Button variant="ghost" onClick={() => del.mutate(undefined)}><Trash2 className="h-4 w-4" /> Remove</Button>}
            </div>
            {!!j.duplicates?.length && (
              <p className="mt-4 rounded-xl bg-warning/10 p-3 text-sm text-warning">This looks like the same role as {j.duplicates.length} other listing(s) you have. ApplyFlux won't apply twice.</p>
            )}
          </Card>
          <Card>
            <CardHeader title="Job description" description="Shown as published by the employer." />
            <div className="whitespace-pre-line p-6 text-sm leading-relaxed text-ink/90">{j.description || <span className="text-muted">No description available for this listing.</span>}</div>
          </Card>
        </div>
        <Card className="h-fit">
          <CardHeader title="Why this score" description="Transparent, rule-based scoring against your profile." />
          <div className="p-5">{j.breakdown ? <MatchExplanation b={j.breakdown} /> : <p className="text-sm text-muted">Not scored yet. Update your profile to score jobs.</p>}</div>
        </Card>
      </div>
    </div>
  );
}
