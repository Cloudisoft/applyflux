/**
 * Text normalisation and boundary-aware keyword matching.
 * The synonym groups and boundary rule follow career-ops keyword-match.mjs
 * (MIT): "java" must not match inside "javascript", but "c++", "ci/cd" and
 * "node.js" still match around their symbols.
 */

export const SYNONYMS: string[][] = [
  ['javascript', 'js', 'ecmascript'],
  ['typescript', 'ts'],
  ['kubernetes', 'k8s'],
  ['machine learning', 'ml'],
  ['ci/cd', 'cicd', 'continuous integration'],
  ['infrastructure as code', 'iac'],
  ['natural language processing', 'nlp'],
  ['large language model', 'large language models', 'llm', 'llms'],
  ['amazon web services', 'aws'],
  ['google cloud platform', 'gcp', 'google cloud'],
  ['microsoft azure', 'azure'],
  ['postgresql', 'postgres'],
  ['node.js', 'nodejs', 'node'],
  ['react', 'react.js', 'reactjs'],
  ['vue', 'vue.js', 'vuejs'],
  ['golang', 'go'],
  ['c#', 'csharp', '.net'],
  ['user experience', 'ux'],
  ['user interface', 'ui'],
  ['product management', 'product manager'],
  ['search engine optimization', 'seo'],
  ['customer relationship management', 'crm'],
];

export function normalizeText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ′´`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsTerm(text: string, term: string): boolean {
  const t = normalizeText(term);
  if (!t) return false;
  const re = new RegExp(`(?<![a-z0-9])${escapeRe(t)}(?![a-z0-9])`);
  return re.test(normalizeText(text));
}

export function termVariants(term: string): string[] {
  const t = normalizeText(term);
  const group = SYNONYMS.find((g) => g.includes(t));
  const base = group ? [...group] : [t];
  const out = new Set(base);
  for (const b of base) {
    if (b.length > 3 && b.endsWith('s')) out.add(b.slice(0, -1));
    if (b.length >= 3 && !b.endsWith('s') && /^[a-z0-9]+$/.test(b)) out.add(b + 's');
  }
  return [...out];
}

export function matchesAnyVariant(text: string, term: string): boolean {
  return termVariants(term).some((v) => containsTerm(text, v));
}

/** Curated, conservative skill vocabulary used to pull requirements out of a JD. */
export const SKILL_VOCABULARY = [
  'javascript', 'typescript', 'python', 'java', 'kotlin', 'swift', 'go', 'golang', 'rust', 'ruby', 'php', 'scala', 'c++', 'c#', 'sql',
  'react', 'next.js', 'vue', 'angular', 'svelte', 'node.js', 'express', 'django', 'flask', 'fastapi', 'rails', 'spring', '.net',
  'graphql', 'rest', 'grpc', 'html', 'css', 'tailwind', 'redux',
  'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'kafka', 'rabbitmq', 'snowflake', 'bigquery', 'dbt', 'airflow', 'spark',
  'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform', 'ansible', 'ci/cd', 'linux', 'git',
  'machine learning', 'deep learning', 'pytorch', 'tensorflow', 'nlp', 'llm', 'computer vision', 'data science', 'statistics',
  'pandas', 'numpy', 'tableau', 'power bi', 'excel', 'looker',
  'figma', 'sketch', 'user research', 'ux', 'ui', 'design systems', 'prototyping',
  'product management', 'agile', 'scrum', 'jira', 'roadmapping', 'a/b testing', 'analytics',
  'salesforce', 'hubspot', 'crm', 'seo', 'sem', 'content marketing', 'copywriting', 'google analytics',
  'project management', 'stakeholder management', 'leadership', 'mentoring', 'communication',
  'security', 'penetration testing', 'soc 2', 'iso 27001', 'gdpr', 'hipaa',
  'ios', 'android', 'react native', 'flutter',
  'accounting', 'financial modeling', 'budgeting', 'forecasting', 'sap', 'quickbooks',
  'recruiting', 'customer success', 'account management', 'sales', 'b2b', 'saas', 'negotiation',
];

export function extractSkills(text: string, extra: string[] = []): string[] {
  const found = new Set<string>();
  for (const skill of [...SKILL_VOCABULARY, ...extra]) {
    if (matchesAnyVariant(text, skill)) {
      const t = normalizeText(skill);
      const group = SYNONYMS.find((g) => g.includes(t));
      found.add(group ? group[0] : t);
    }
  }
  return [...found];
}

/** Escape text for safe insertion into HTML. */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Lightweight similarity between two short strings (Dice coefficient on bigrams). */
export function similarity(a: string, b: string): number {
  const x = normalizeText(a).replace(/[^a-z0-9 ]/g, '');
  const y = normalizeText(b).replace(/[^a-z0-9 ]/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0);
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

/* ------------------------------------------------------------------ */
/* The same question in different words                                */
/* ------------------------------------------------------------------ */

const QUESTION_STOPWORDS = new Set(
  'a an the of to in on at for with by from about as and or if is are was were be been being do does did have has had you your yours we our us this that these those it its any some what which who whom how when where why will would can could should may might must please currently first ever there their them they i me my am applying apply role position job company'.split(' '),
);
/** Words employers use interchangeably in the same question. */
const QUESTION_SYNONYMS: string[][] = [
  ['size', 'big', 'large', 'many', 'number', 'count'],
  ['hear', 'find', 'learn', 'discover', 'see', 'come'],
  ['led', 'lead', 'leading', 'manage', 'managed', 'managing', 'supervise', 'supervised'],
  ['years', 'year', 'yrs'],
  ['experience', 'experienced'],
  ['salary', 'compensation', 'pay'],
  ['expected', 'expectation', 'expectations', 'desired'],
  ['start', 'join', 'begin'],
  ['relocate', 'relocation', 'move'],
  ['require', 'need', 'needs', 'required'],
  ['sponsorship', 'sponsor', 'visa'],
  ['authorized', 'authorised', 'eligible', 'permitted', 'legally'],
];
const SYNONYM_OF = new Map<string, string>(QUESTION_SYNONYMS.flatMap((g) => g.map((w) => [w, g[0]] as [string, string])));

function questionWords(q: string): Set<string> {
  return new Set(
    normalizeText(q)
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 1 && !QUESTION_STOPWORDS.has(w))
      .map((w) => SYNONYM_OF.get(w) ?? w.replace(/(ing|ed|es|s)$/, '')),
  );
}

/**
 * How alike two questions are (0-1), by their meaningful words with synonyms folded together
 * ("How big a team have you led?" ~ "What size of team have you managed?"). Character similarity is only used
 * for very short questions: by characters "years with React" and "years with Python" look nearly the same.
 */
export function questionSimilarity(a: string, b: string): number {
  const wa = questionWords(a);
  const wb = questionWords(b);
  if (wa.size < 2 || wb.size < 2) return similarity(a, b);
  let both = 0;
  wa.forEach((w) => {
    if (wb.has(w)) both++;
  });
  return both / (wa.size + wb.size - both);
}
