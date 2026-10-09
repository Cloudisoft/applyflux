import * as React from 'react';
import { AlertCircle, BadgeCheck, Briefcase, CircleAlert, GraduationCap, Medal, Pencil, Plus, Trash2, FolderGit2, ShieldCheck } from 'lucide-react';
import type { CandidateProfileData, WorkAuthorization } from '@applyflux/shared';
import { Badge, Button, Card, CardHeader, Dialog, ErrorState, Field, Input, PageHeader, Progress, Select, Skeleton, TagInput, Textarea, Tip } from '@/components/ui';
import { api } from '@/lib/api';
import { qk, useAction, useProfile } from '@/lib/queries';
import type { ProfileResponse } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

type P = ProfileResponse['profile'];

function VerifyBadge({ p, field }: { p: P; field: string }) {
  const m = p.fieldMeta[field];
  const verify = useAction(() => api.post('/profile/verify', { fields: [field] }), { invalidate: [qk.profile, qk.me], success: 'Confirmed' });
  if (!m) return null;
  if (m.verified) return <Badge tone="success"><BadgeCheck className="h-3 w-3" /> Verified</Badge>;
  return (
    <Tip content="Extracted from your resume. Confirm it's correct so ApplyFlux can use it in Auto Mode.">
      <button type="button" onClick={() => verify.mutate(undefined)} className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning ring-1 ring-warning/25 hover:bg-warning/20">
        <CircleAlert className="h-3 w-3" /> Confirm
      </button>
    </Tip>
  );
}

/** Editable core profile. Saving marks every edited field as a verified, user-sourced fact. */
export function ProfileForm({ profile, sections = ['personal', 'links', 'professional', 'authorization', 'preferences'], onSaved, submitLabel = 'Save changes' }: { profile: P; sections?: string[]; onSaved?: () => void; submitLabel?: string }) {
  const [p, setP] = React.useState<P>(profile);
  const [dirty, setDirty] = React.useState<Set<string>>(new Set());
  React.useEffect(() => setP(profile), [profile]);
  const set = <K extends keyof CandidateProfileData>(k: K, v: CandidateProfileData[K]) => {
    setP((x) => ({ ...x, [k]: v }));
    setDirty((d) => new Set(d).add(k as string));
  };
  const save = useAction(
    () => {
      const patch: Record<string, unknown> = {};
      for (const k of dirty) patch[k] = (p as Record<string, unknown>)[k];
      return api.patch('/profile', patch);
    },
    { success: 'Profile saved', invalidate: [qk.profile, qk.me, ['jobs']], onSuccess: () => { setDirty(new Set()); onSaved?.(); } },
  );
  const txt = (k: keyof CandidateProfileData, label: string, opts: { type?: string; ac?: string; hint?: string; span?: boolean } = {}) => (
    <Field label={label} htmlFor={`pf-${k}`} hint={opts.hint} badge={<VerifyBadge p={p} field={k} />} className={opts.span ? 'sm:col-span-2' : undefined}>
      <Input id={`pf-${k}`} type={opts.type ?? 'text'} autoComplete={opts.ac} value={(p[k] as string | null) ?? ''} onChange={(e) => set(k, (e.target.value || null) as never)} />
    </Field>
  );
  const has = (s: string) => sections.includes(s);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty.size) return onSaved?.();
        save.mutate(undefined);
      }}
      className="space-y-6"
    >
      {has('personal') && (
        <Card>
          <CardHeader title="Personal details" description="Used to fill contact fields on every application." />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            {txt('firstName', 'First name', { ac: 'given-name' })}
            {txt('lastName', 'Last name', { ac: 'family-name' })}
            {txt('email', 'Email', { type: 'email', ac: 'email' })}
            {txt('phone', 'Phone', { type: 'tel', ac: 'tel', hint: 'Include your country code, e.g. +44 20 7946 0000' })}
            {txt('city', 'City', { ac: 'address-level2' })}
            {txt('region', 'State / region', { ac: 'address-level1' })}
            {txt('country', 'Country', { ac: 'country-name' })}
            {txt('postalCode', 'Postal code', { ac: 'postal-code' })}
            {txt('addressLine1', 'Street address', { ac: 'address-line1', span: true, hint: 'Optional — only some applications ask for it.' })}
          </div>
        </Card>
      )}
      {has('links') && (
        <Card>
          <CardHeader title="Professional links" />
          <div className="grid gap-4 p-5 sm:grid-cols-3">
            {txt('linkedinUrl', 'LinkedIn URL', { type: 'url' })}
            {txt('githubUrl', 'GitHub URL', { type: 'url' })}
            {txt('portfolioUrl', 'Portfolio / website', { type: 'url' })}
          </div>
        </Card>
      )}
      {has('professional') && (
        <Card>
          <CardHeader title="Professional summary" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            {txt('headline', 'Headline', { span: true, hint: 'e.g. Senior Product Designer · B2B SaaS' })}
            <Field label="Summary" htmlFor="pf-summary" className="sm:col-span-2" badge={<VerifyBadge p={p} field="summary" />}>
              <Textarea id="pf-summary" rows={4} value={p.summary ?? ''} onChange={(e) => set('summary', e.target.value || null)} />
            </Field>
            <Field label="Years of experience" htmlFor="pf-years" badge={<VerifyBadge p={p} field="yearsExperience" />}>
              <Input id="pf-years" type="number" min={0} max={70} step={0.5} value={p.yearsExperience ?? ''} onChange={(e) => set('yearsExperience', e.target.value === '' ? null : Number(e.target.value))} />
            </Field>
            <Field label="Experience level" htmlFor="pf-level">
              <Select id="pf-level" value={p.experienceLevel ?? ''} onChange={(e) => set('experienceLevel', (e.target.value || null) as P['experienceLevel'])}>
                <option value="">Select…</option>
                {['entry', 'mid', 'senior', 'lead', 'executive'].map((l) => <option key={l} value={l} className="capitalize">{l}</option>)}
              </Select>
            </Field>
            <Field label="Skills" htmlFor="pf-skills" className="sm:col-span-2" hint="Press Enter or comma to add. Only list skills you can evidence." badge={<VerifyBadge p={p} field="skills" />}>
              <TagInput id="pf-skills" value={p.skills} onChange={(v) => set('skills', v)} placeholder="TypeScript, Figma, SQL…" />
            </Field>
            <Field label="Industries" htmlFor="pf-ind" className="sm:col-span-2">
              <TagInput id="pf-ind" value={p.industries} onChange={(v) => set('industries', v)} placeholder="Fintech, Healthcare…" />
            </Field>
          </div>
        </Card>
      )}
      {has('authorization') && <AuthorizationEditor value={p.workAuthorizations} onChange={(v) => set('workAuthorizations', v)} badge={<VerifyBadge p={p} field="workAuthorizations" />} />}
      {has('preferences') && (
        <Card>
          <CardHeader title="Job preferences" description="Drives job matching and answers to salary and availability questions." />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Desired job titles" htmlFor="pf-titles" className="sm:col-span-2">
              <TagInput id="pf-titles" value={p.desiredTitles} onChange={(v) => set('desiredTitles', v)} placeholder="Product Designer, UX Lead…" />
            </Field>
            <Field label="Preferred locations" htmlFor="pf-locs" className="sm:col-span-2">
              <TagInput id="pf-locs" value={p.desiredLocations} onChange={(v) => set('desiredLocations', v)} placeholder="London, Berlin, Remote (EU)…" />
            </Field>
            <div className="sm:col-span-2">
              <Label2>Workplace</Label2>
              <Chips options={[['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']]} value={p.workplaceTypes} onChange={(v) => set('workplaceTypes', v as P['workplaceTypes'])} />
            </div>
            <div className="sm:col-span-2">
              <Label2>Employment type</Label2>
              <Chips options={[['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contract', 'Contract'], ['internship', 'Internship'], ['temporary', 'Temporary']]} value={p.employmentTypes} onChange={(v) => set('employmentTypes', v as P['employmentTypes'])} />
            </div>
            <Field label="Minimum salary" htmlFor="pf-smin" badge={<VerifyBadge p={p} field="desiredSalaryMin" />}>
              <Input id="pf-smin" type="number" min={0} value={p.desiredSalaryMin ?? ''} onChange={(e) => set('desiredSalaryMin', e.target.value === '' ? null : Number(e.target.value))} />
            </Field>
            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <Field label="Target salary" htmlFor="pf-smax">
                <Input id="pf-smax" type="number" min={0} value={p.desiredSalaryMax ?? ''} onChange={(e) => set('desiredSalaryMax', e.target.value === '' ? null : Number(e.target.value))} />
              </Field>
              <Field label="Currency" htmlFor="pf-cur">
                <Input id="pf-cur" maxLength={3} placeholder="USD" value={p.salaryCurrency ?? ''} onChange={(e) => set('salaryCurrency', e.target.value.toUpperCase() || null)} />
              </Field>
            </div>
            {txt('noticePeriod', 'Notice period', { hint: 'e.g. 4 weeks' })}
            <Field label="Available from" htmlFor="pf-avail" badge={<VerifyBadge p={p} field="availableFrom" />}>
              <Input id="pf-avail" type="date" value={p.availableFrom ?? ''} onChange={(e) => set('availableFrom', e.target.value || null)} />
            </Field>
            <Field label="Willing to relocate?" htmlFor="pf-reloc" badge={<VerifyBadge p={p} field="willingToRelocate" />}>
              <Select id="pf-reloc" value={p.willingToRelocate == null ? '' : String(p.willingToRelocate)} onChange={(e) => set('willingToRelocate', e.target.value === '' ? null : e.target.value === 'true')}>
                <option value="">Prefer not to say</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            </Field>
          </div>
        </Card>
      )}
      <div className="sticky bottom-4 z-10 flex justify-end">
        <Button type="submit" loading={save.isPending} className={cn(!dirty.size && !onSaved && 'opacity-70')}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

const Label2 = ({ children }: { children: React.ReactNode }) => <div className="mb-1.5 text-sm font-medium">{children}</div>;
function Chips({ options, value, onChange }: { options: Array<[string, string]>; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group">
      {options.map(([v, l]) => {
        const on = value.includes(v);
        return (
          <button key={v} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== v) : [...value, v])} className={cn('rounded-xl border px-3.5 py-2 text-sm font-medium transition', on ? 'border-brand/50 bg-brand-soft text-brand-ink' : 'border-line text-muted hover:text-ink')}>
            {l}
          </button>
        );
      })}
    </div>
  );
}

function AuthorizationEditor({ value, onChange, badge }: { value: WorkAuthorization[]; onChange: (v: WorkAuthorization[]) => void; badge?: React.ReactNode }) {
  const tri = (v: boolean | null) => (v == null ? '' : String(v));
  const parse = (s: string) => (s === '' ? null : s === 'true');
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-brand" /> Work authorization {badge}</span>}
        description="ApplyFlux answers authorization and sponsorship questions only from what you record here — never by guessing."
      />
      <div className="space-y-3 p-5">
        {value.map((w, i) => (
          <div key={i} className="grid items-end gap-3 rounded-xl border border-line p-3 sm:grid-cols-[1.2fr_1fr_1fr_auto]">
            <Field label="Country" htmlFor={`wa-c-${i}`}>
              <Input id={`wa-c-${i}`} value={w.country} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, country: e.target.value } : x)))} placeholder="United States" />
            </Field>
            <Field label="Authorized to work?" htmlFor={`wa-a-${i}`}>
              <Select id={`wa-a-${i}`} value={tri(w.authorized)} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, authorized: parse(e.target.value) } : x)))}>
                <option value="">Not stated</option><option value="true">Yes</option><option value="false">No</option>
              </Select>
            </Field>
            <Field label="Needs sponsorship?" htmlFor={`wa-s-${i}`}>
              <Select id={`wa-s-${i}`} value={tri(w.requiresSponsorship)} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, requiresSponsorship: parse(e.target.value) } : x)))}>
                <option value="">Not stated</option><option value="true">Yes</option><option value="false">No</option>
              </Select>
            </Field>
            <Button type="button" size="icon" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove country"><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...value, { country: '', authorized: null, requiresSponsorship: null }])}>
          <Plus className="h-4 w-4" /> Add country
        </Button>
      </div>
    </Card>
  );
}

/* History sections ---------------------------------------------------------- */

type SectionKey = 'experiences' | 'educations' | 'certifications' | 'projects';
const SECTION_META: Record<SectionKey, { title: string; icon: React.ElementType; fields: Array<{ k: string; l: string; type?: string; span?: boolean; area?: boolean; hint?: string }> }> = {
  experiences: {
    title: 'Work history',
    icon: Briefcase,
    fields: [
      { k: 'title', l: 'Job title' }, { k: 'company', l: 'Company' }, { k: 'location', l: 'Location' },
      { k: 'startDate', l: 'Start (YYYY-MM)', hint: 'e.g. 2021-03' }, { k: 'endDate', l: 'End (YYYY-MM)', hint: 'Leave empty if current' }, { k: 'isCurrent', l: 'I currently work here', type: 'checkbox' },
      { k: 'description', l: 'Description', area: true, span: true }, { k: 'achievements', l: 'Achievements (one per line)', area: true, span: true },
    ],
  },
  educations: {
    title: 'Education',
    icon: GraduationCap,
    fields: [{ k: 'institution', l: 'Institution', span: true }, { k: 'degree', l: 'Degree' }, { k: 'fieldOfStudy', l: 'Field of study' }, { k: 'startDate', l: 'Start (YYYY)' }, { k: 'endDate', l: 'End (YYYY or YYYY-MM)' }, { k: 'grade', l: 'Grade / GPA' }],
  },
  certifications: { title: 'Certifications', icon: Medal, fields: [{ k: 'name', l: 'Name', span: true }, { k: 'issuer', l: 'Issuer' }, { k: 'credentialId', l: 'Credential ID' }, { k: 'issuedOn', l: 'Issued (YYYY-MM)' }, { k: 'expiresOn', l: 'Expires (YYYY-MM)' }] },
  projects: { title: 'Projects', icon: FolderGit2, fields: [{ k: 'name', l: 'Name' }, { k: 'url', l: 'URL', type: 'url' }, { k: 'description', l: 'Description', area: true, span: true }] },
};

export function HistorySection({ section, items }: { section: SectionKey; items: Array<Record<string, unknown>> }) {
  const meta = SECTION_META[section];
  const [editing, setEditing] = React.useState<Record<string, unknown> | null>(null);
  const inv = [qk.profile, qk.me, ['jobs']];
  const save = useAction(
    (item: Record<string, unknown>) => {
      const body: Record<string, unknown> = {};
      for (const f of meta.fields) {
        let v = item[f.k];
        if (f.k === 'achievements') v = String(v ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
        else if (f.type === 'checkbox') v = !!v;
        else v = v === '' ? null : v;
        body[f.k] = v;
      }
      body.verified = true;
      body.source = item.id ? item.source ?? 'user' : 'user';
      return item.id ? api.patch(`/profile/${section}/${item.id}`, body) : api.post(`/profile/${section}`, body);
    },
    { success: 'Saved', invalidate: inv, onSuccess: () => setEditing(null) },
  );
  const del = useAction((id: string) => api.del(`/profile/${section}/${id}`), { success: 'Removed', invalidate: inv });
  const verify = useAction((id: string) => api.patch(`/profile/${section}/${id}`, { verified: true }), { success: 'Confirmed', invalidate: inv });
  const Icon = meta.icon;
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Icon className="h-4 w-4 text-brand" /> {meta.title}</span>} action={<Button size="sm" variant="secondary" onClick={() => setEditing({})}><Plus className="h-4 w-4" /> Add</Button>} />
      <ul className="divide-y divide-line">
        {!items.length && <li className="px-5 py-6 text-sm text-muted">Nothing added yet.</li>}
        {items.map((it) => (
          <li key={it.id as string} className="flex items-start gap-3 px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{String(it.title ?? it.degree ?? it.name ?? it.institution ?? '')}{section === 'experiences' && <span className="font-normal text-muted"> · {String(it.company)}</span>}</div>
              <div className="text-sm text-muted">
                {section === 'educations' && <>{String(it.institution)}{it.fieldOfStudy ? ` · ${String(it.fieldOfStudy)}` : ''} · </>}
                {!!(it.startDate || it.issuedOn) && <>{String(it.startDate ?? it.issuedOn)} – {it.isCurrent ? 'Present' : String(it.endDate ?? it.expiresOn ?? '')}</>}
              </div>
              {Array.isArray(it.achievements) && it.achievements.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-ink/80">{(it.achievements as string[]).slice(0, 4).map((a) => <li key={a}>{a}</li>)}</ul>
              )}
            </div>
            {it.verified ? (
              <Badge tone="success"><BadgeCheck className="h-3 w-3" /> Verified</Badge>
            ) : (
              <Button size="sm" variant="soft" onClick={() => verify.mutate(it.id as string)}>Confirm</Button>
            )}
            <Button size="icon" variant="ghost" onClick={() => setEditing({ ...it, achievements: Array.isArray(it.achievements) ? (it.achievements as string[]).join('\n') : '' })} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" onClick={() => del.mutate(it.id as string)} aria-label="Delete"><Trash2 className="h-4 w-4" /></Button>
          </li>
        ))}
      </ul>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={`${editing?.id ? 'Edit' : 'Add'} ${meta.title.toLowerCase().replace(/s$/, '')}`} wide
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending} onClick={() => editing && save.mutate(editing)}>Save</Button></>}>
        {editing && (
          <div className="grid gap-4 sm:grid-cols-2">
            {meta.fields.map((f) =>
              f.type === 'checkbox' ? (
                <label key={f.k} className="flex items-center gap-2 text-sm font-medium sm:col-span-2">
                  <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--brand))]" checked={!!editing[f.k]} onChange={(e) => setEditing({ ...editing, [f.k]: e.target.checked, ...(e.target.checked ? { endDate: '' } : {}) })} /> {f.l}
                </label>
              ) : (
                <Field key={f.k} label={f.l} htmlFor={`h-${f.k}`} hint={f.hint} className={f.span ? 'sm:col-span-2' : undefined}>
                  {f.area ? (
                    <Textarea id={`h-${f.k}`} rows={4} value={String(editing[f.k] ?? '')} onChange={(e) => setEditing({ ...editing, [f.k]: e.target.value })} />
                  ) : (
                    <Input id={`h-${f.k}`} type={f.type ?? 'text'} value={String(editing[f.k] ?? '')} disabled={f.k === 'endDate' && !!editing.isCurrent} onChange={(e) => setEditing({ ...editing, [f.k]: e.target.value })} />
                  )}
                </Field>
              ),
            )}
          </div>
        )}
      </Dialog>
    </Card>
  );
}

export function AssessmentPanel({ data }: { data: ProfileResponse }) {
  const a = data.assessment;
  const verifyAll = useAction(() => api.post('/profile/verify', { fields: a.unverified.filter((f) => !f.includes('.')) }), { success: 'Confirmed', invalidate: [qk.profile, qk.me] });
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Completeness</h3>
        <span className="font-display text-2xl font-bold">{a.completeness}%</span>
      </div>
      <Progress value={a.completeness} className="mt-3" label="Profile completeness" />
      <div className={cn('mt-4 rounded-xl p-3 text-sm', a.readyForAutomation ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning')}>
        {a.readyForAutomation ? 'Ready for automation.' : 'Not ready for Auto Mode yet — complete and confirm the items below.'}
      </div>
      {!!a.missing.length && (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Missing</div>
          <ul className="space-y-1 text-sm">{a.missing.map((m) => <li key={m.field} className="flex items-center gap-2"><CircleAlert className={cn('h-4 w-4', m.requiredForAutomation ? 'text-warning' : 'text-muted')} /> {m.label}{m.requiredForAutomation && <Badge tone="warning" className="ml-auto">Required</Badge>}</li>)}</ul>
        </div>
      )}
      {!!a.issues.length && (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Check these</div>
          <ul className="space-y-1.5 text-sm">{a.issues.map((i, n) => <li key={n} className="flex gap-2"><AlertCircle className={cn('mt-0.5 h-4 w-4 shrink-0', i.severity === 'error' ? 'text-danger' : 'text-warning')} /> {i.message}</li>)}</ul>
        </div>
      )}
      {a.unverified.some((f) => !f.includes('.')) && (
        <Button size="sm" variant="secondary" className="mt-4 w-full" loading={verifyAll.isPending} onClick={() => verifyAll.mutate(undefined)}>
          Confirm all extracted details are correct
        </Button>
      )}
      <p className="mt-3 text-xs text-muted">Last updated {formatDate(data.profile.updatedAt)}</p>
    </Card>
  );
}

export function ProfilePage() {
  const { data, isLoading, error, refetch } = useProfile();
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div>
      <PageHeader eyebrow="Your materials" title="Candidate profile" description="Configure once, reuse everywhere. Verified facts are kept separate from anything extracted or AI-drafted." />
      {isLoading || !data ? (
        <Skeleton className="h-96 rounded-3xl" />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
          <div className="space-y-6">
            <ProfileForm profile={data.profile} />
            <HistorySection section="experiences" items={data.experiences as never} />
            <HistorySection section="educations" items={data.educations as never} />
            <HistorySection section="certifications" items={data.certifications as never} />
            <HistorySection section="projects" items={data.projects as never} />
          </div>
          <div className="space-y-6 xl:sticky xl:top-24 xl:h-fit">
            <AssessmentPanel data={data} />
          </div>
        </div>
      )}
    </div>
  );
}
