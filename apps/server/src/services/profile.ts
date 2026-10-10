import {
  CandidateProfileInput,
  CertificationInput,
  EducationInput,
  ProjectInput,
  WorkExperienceInput,
  type FullCandidateProfile,
  type CandidateProfileData,
} from '@applyflux/shared';
import { camel, many, one, type Queryable } from '../db';
import { notFound } from '../lib/errors';

const PROFILE_COLUMNS: Record<keyof Omit<CandidateProfileData, never>, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
  city: 'city',
  region: 'region',
  country: 'country',
  postalCode: 'postal_code',
  addressLine1: 'address_line1',
  linkedinUrl: 'linkedin_url',
  githubUrl: 'github_url',
  portfolioUrl: 'portfolio_url',
  otherLinks: 'other_links',
  headline: 'headline',
  summary: 'summary',
  yearsExperience: 'years_experience',
  experienceLevel: 'experience_level',
  skills: 'skills',
  industries: 'industries',
  languages: 'languages',
  workAuthorizations: 'work_authorizations',
  noticePeriod: 'notice_period',
  availableFrom: 'available_from',
  desiredTitles: 'desired_titles',
  desiredSalaryMin: 'desired_salary_min',
  desiredSalaryMax: 'desired_salary_max',
  salaryCurrency: 'salary_currency',
  employmentTypes: 'employment_types',
  workplaceTypes: 'workplace_types',
  desiredLocations: 'desired_locations',
  willingToRelocate: 'willing_to_relocate',
  screening: 'screening',
  fieldMeta: 'field_meta',
};
const JSON_COLUMNS = new Set(['other_links', 'languages', 'work_authorizations', 'screening', 'field_meta']);

function rowToProfile(row: Record<string, unknown> | null): FullCandidateProfile['profile'] {
  const base = CandidateProfileInput.parse({});
  if (!row) return { ...base, verifiedAt: null, updatedAt: null };
  const out: Record<string, unknown> = { ...base };
  for (const [k, col] of Object.entries(PROFILE_COLUMNS)) {
    let v = row[col];
    if (col === 'years_experience' && v != null) v = Number(v);
    if (v !== undefined && v !== null) out[k] = v;
    else if (!(k in base) || (base as Record<string, unknown>)[k] === null) out[k] = null;
  }
  out.verifiedAt = row.verified_at ? new Date(row.verified_at as string).toISOString() : null;
  out.updatedAt = row.updated_at ? new Date(row.updated_at as string).toISOString() : null;
  return out as FullCandidateProfile['profile'];
}

export async function ensureProfileRows(q: Queryable, userId: string, email: string | null) {
  // Normally created by the auth.users trigger; this keeps the API correct if the trigger was not installed.
  await q.query(`insert into profiles (user_id) values ($1) on conflict do nothing`, [userId]);
  await q.query(
    `insert into candidate_profiles (user_id, email, field_meta) values ($1, $2, $3) on conflict do nothing`,
    [userId, email, JSON.stringify(email ? { email: { source: 'user', verified: true } } : {})],
  );
  await q.query(`insert into automation_preferences (user_id) values ($1) on conflict do nothing`, [userId]);
}

export async function loadFullProfile(q: Queryable, userId: string): Promise<FullCandidateProfile & { version: number }> {
  const [p, exps, edus, certs, projs] = await Promise.all([
    one(q, 'select * from candidate_profiles where user_id = $1', [userId]),
    many(q, 'select * from work_experiences where user_id = $1 order by is_current desc, start_date desc nulls last, sort_order', [userId]),
    many(q, 'select * from educations where user_id = $1 order by end_date desc nulls first, sort_order', [userId]),
    many(q, 'select * from certifications where user_id = $1 order by issued_on desc nulls last', [userId]),
    many(q, 'select * from projects where user_id = $1 order by created_at', [userId]),
  ]);
  const strip = (r: Record<string, unknown>) => {
    const c = camel<Record<string, unknown>>(r);
    delete c.userId;
    delete c.createdAt;
    delete c.updatedAt;
    return c;
  };
  return {
    profile: rowToProfile(p),
    version: (p?.version as number) ?? 0,
    experiences: exps.map(strip) as unknown as FullCandidateProfile['experiences'],
    educations: edus.map(strip) as unknown as FullCandidateProfile['educations'],
    certifications: certs.map(strip) as unknown as FullCandidateProfile['certifications'],
    projects: projs.map(strip) as unknown as FullCandidateProfile['projects'],
  };
}

/** Partial update: only provided keys are written. Bumps version so stale match scores are recomputed. */
export async function updateProfile(q: Queryable, userId: string, patch: Partial<CandidateProfileData>) {
  const parsed = CandidateProfileInput.partial().parse(patch);
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  for (const [k, v] of Object.entries(parsed)) {
    if (!(k in patch)) continue;
    const col = PROFILE_COLUMNS[k as keyof CandidateProfileData];
    if (!col) continue;
    vals.push(JSON_COLUMNS.has(col) ? JSON.stringify(v) : v);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return;
  await q.query(`update candidate_profiles set ${sets.join(', ')}, version = version + 1 where user_id = $1`, vals);
}

/** Mark profile fields as confirmed by the user (verified facts). */
export async function verifyFields(q: Queryable, userId: string, fields: string[], verified: boolean) {
  const row = await one<{ field_meta: Record<string, { source: string; verified: boolean }> }>(q, 'select field_meta from candidate_profiles where user_id=$1', [userId]);
  if (!row) throw notFound('Profile');
  const meta = { ...row.field_meta };
  for (const f of fields) meta[f] = { source: (meta[f]?.source as 'user') ?? 'user', verified };
  await q.query(
    `update candidate_profiles set field_meta = $2, verified_at = case when $3 then now() else verified_at end, version = version + 1 where user_id = $1`,
    [userId, JSON.stringify(meta), verified],
  );
}

type Section = 'experiences' | 'educations' | 'certifications' | 'projects';
export const SECTIONS: Record<Section, { table: string; schema: typeof WorkExperienceInput | typeof EducationInput | typeof CertificationInput | typeof ProjectInput; cols: Record<string, string> }> = {
  experiences: {
    table: 'work_experiences',
    schema: WorkExperienceInput,
    cols: { company: 'company', title: 'title', location: 'location', startDate: 'start_date', endDate: 'end_date', isCurrent: 'is_current', description: 'description', achievements: 'achievements', source: 'source', verified: 'verified', sortOrder: 'sort_order' },
  },
  educations: {
    table: 'educations',
    schema: EducationInput,
    cols: { institution: 'institution', degree: 'degree', fieldOfStudy: 'field_of_study', startDate: 'start_date', endDate: 'end_date', grade: 'grade', source: 'source', verified: 'verified', sortOrder: 'sort_order' },
  },
  certifications: {
    table: 'certifications',
    schema: CertificationInput,
    cols: { name: 'name', issuer: 'issuer', issuedOn: 'issued_on', expiresOn: 'expires_on', credentialId: 'credential_id', source: 'source', verified: 'verified' },
  },
  projects: {
    table: 'projects',
    schema: ProjectInput,
    cols: { name: 'name', url: 'url', description: 'description', skills: 'skills', source: 'source', verified: 'verified' },
  },
};

export async function insertSectionItem(q: Queryable, userId: string, section: Section, input: unknown) {
  const def = SECTIONS[section];
  const data = def.schema.parse(input) as Record<string, unknown>;
  const cols = Object.keys(def.cols).filter((k) => k in data);
  const vals = cols.map((k) => data[k]);
  const r = await one(
    q,
    `insert into ${def.table} (user_id, ${cols.map((k) => def.cols[k]).join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
    [userId, ...vals],
  );
  await q.query('update candidate_profiles set version = version + 1 where user_id = $1', [userId]);
  return r!.id as string;
}

export async function updateSectionItem(q: Queryable, userId: string, section: Section, id: string, input: unknown) {
  const def = SECTIONS[section];
  const data = (def.schema as typeof WorkExperienceInput).partial().parse(input) as Record<string, unknown>;
  const cols = Object.keys(def.cols).filter((k) => k in (input as object) && k in data);
  if (!cols.length) return;
  const r = await q.query(
    `update ${def.table} set ${cols.map((k, i) => `${def.cols[k]} = $${i + 3}`).join(', ')} where id = $1 and user_id = $2`,
    [id, userId, ...cols.map((k) => data[k])],
  );
  if (!r.rowCount) throw notFound('Item');
  await q.query('update candidate_profiles set version = version + 1 where user_id = $1', [userId]);
}

export async function deleteSectionItem(q: Queryable, userId: string, section: Section, id: string) {
  const r = await q.query(`delete from ${SECTIONS[section].table} where id = $1 and user_id = $2`, [id, userId]);
  if (!r.rowCount) throw notFound('Item');
  await q.query('update candidate_profiles set version = version + 1 where user_id = $1', [userId]);
}

/** Plain-text fact sheet for AI prompts. Only includes verified entries when verifiedOnly. */
export function factSheet(p: FullCandidateProfile, verifiedOnly = false): string {
  const pr = p.profile;
  const v = (k: string) => !verifiedOnly || pr.fieldMeta[k]?.verified;
  const lines: string[] = [];
  const name = [pr.firstName, pr.lastName].filter(Boolean).join(' ');
  if (name) lines.push(`Name: ${name}`);
  if (pr.headline) lines.push(`Headline: ${pr.headline}`);
  if (pr.city || pr.country) lines.push(`Location: ${[pr.city, pr.region, pr.country].filter(Boolean).join(', ')}`);
  if (pr.summary) lines.push(`Summary: ${pr.summary}`);
  if (pr.yearsExperience != null && v('yearsExperience')) lines.push(`Years of experience: ${pr.yearsExperience}`);
  if (pr.skills.length) lines.push(`Skills: ${pr.skills.join(', ')}`);
  if (pr.languages.length) lines.push(`Languages: ${pr.languages.map((l) => `${l.language}${l.proficiency ? ` (${l.proficiency})` : ''}`).join(', ')}`);
  lines.push('Work history:');
  p.experiences
    .filter((e) => !verifiedOnly || e.verified)
    .forEach((e, i) => {
      lines.push(`  [${i}] ${e.title} at ${e.company} (${e.startDate ?? '?'} – ${e.isCurrent ? 'present' : e.endDate ?? '?'})${e.location ? `, ${e.location}` : ''}`);
      if (e.description) lines.push(`      ${e.description}`);
      for (const a of e.achievements) lines.push(`      • ${a}`);
    });
  lines.push('Education:');
  p.educations.filter((e) => !verifiedOnly || e.verified).forEach((e) => lines.push(`  ${[e.degree, e.fieldOfStudy].filter(Boolean).join(' in ') || 'Studies'} — ${e.institution} (${e.endDate ?? '?'})`));
  if (p.certifications.length) {
    lines.push('Certifications:');
    p.certifications.filter((c) => !verifiedOnly || c.verified).forEach((c) => lines.push(`  ${c.name}${c.issuer ? ` (${c.issuer})` : ''}`));
  }
  if (p.projects.length) {
    lines.push('Projects:');
    p.projects.forEach((x) => lines.push(`  ${x.name}: ${x.description ?? ''}`));
  }
  return lines.join('\n');
}
