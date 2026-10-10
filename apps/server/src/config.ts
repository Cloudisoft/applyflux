import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3001),
    /** Public origin of this API, used for sandbox links and signed download URLs. */
    PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
    /** Comma-separated origins allowed by CORS (the web app). */
    WEB_ORIGINS: z.string().default('http://localhost:5173'),
    /** Comma-separated chrome-extension://<id> origins allowed to call /api/ext. Empty = any extension origin (dev). */
    EXTENSION_ORIGINS: z.string().default(''),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (Supabase → Project Settings → Database → Connection string)'),
    DATABASE_SSL: bool,

    SUPABASE_URL: z.string().url().optional(),
    /** Server-only. Never expose to the browser or the extension. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    /** Legacy HS256 JWT secret. If unset, tokens are verified against the project's JWKS. */
    SUPABASE_JWT_SECRET: z.string().optional(),
    STORAGE_BUCKET: z.string().default('documents'),
    /** "supabase" in every real environment. "memory" exists only for automated tests. */
    STORAGE_DRIVER: z.enum(['supabase', 'memory']).default('supabase'),

    AI_PROVIDER: z.enum(['anthropic', 'openai', 'openrouter', 'none']).default('none'),
    /** Optional second provider used when the primary errors (outage, rate limit, bad key). */
    AI_FALLBACK_PROVIDER: z.enum(['anthropic', 'openai', 'openrouter', 'none']).default('none'),
    ANTHROPIC_API_KEY: z.string().optional(),
    /** Claude model id. Defaults to claude-opus-5-5. */
    ANTHROPIC_MODEL: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
    /** OpenAI / OpenRouter model id. */
    AI_MODEL: z.string().optional(),
    AI_BASE_URL: z.string().url().optional(),

    /** Platforms where Auto Mode may click Submit. Expand only after validating a platform end to end. */
    AUTO_SUBMIT_PLATFORMS: z.string().default('sandbox'),
    /** HMAC secret for signed document download links. */
    DOWNLOAD_SIGNING_SECRET: z.string().min(32, 'DOWNLOAD_SIGNING_SECRET must be at least 32 characters'),
    ENABLE_SANDBOX: z
      .string()
      .optional()
      .transform((v) => v !== 'false'),
    /** Automatic job discovery: how often each person's search re-runs, and optional Adzuna keys for a broad web search. */
    DISCOVERY_INTERVAL_HOURS: z.coerce.number().min(1).max(168).default(6),
    ADZUNA_APP_ID: z.string().optional(),
    ADZUNA_APP_KEY: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.STORAGE_DRIVER === 'supabase' && (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY))
      ctx.addIssue({ code: 'custom', message: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for supabase storage' });
    if (e.STORAGE_DRIVER === 'memory' && e.NODE_ENV === 'production')
      ctx.addIssue({ code: 'custom', message: 'STORAGE_DRIVER=memory is not allowed in production' });
    if (!e.SUPABASE_JWT_SECRET && !e.SUPABASE_URL)
      ctx.addIssue({ code: 'custom', message: 'Set SUPABASE_URL (JWKS verification) or SUPABASE_JWT_SECRET' });
    const keyFor = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as const;
    for (const [field, provider] of [['AI_PROVIDER', e.AI_PROVIDER], ['AI_FALLBACK_PROVIDER', e.AI_FALLBACK_PROVIDER]] as const) {
      if (provider === 'none') continue;
      if (!e[keyFor[provider]]) ctx.addIssue({ code: 'custom', message: `${keyFor[provider]} is required when ${field}=${provider}` });
    }
    if (e.AI_FALLBACK_PROVIDER !== 'none' && e.AI_FALLBACK_PROVIDER === e.AI_PROVIDER)
      ctx.addIssue({ code: 'custom', message: 'AI_FALLBACK_PROVIDER must differ from AI_PROVIDER' });
    if (e.AI_FALLBACK_PROVIDER !== 'none' && e.AI_PROVIDER === 'none')
      ctx.addIssue({ code: 'custom', message: 'Set AI_PROVIDER before AI_FALLBACK_PROVIDER' });
  });

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // On Railway, default the public URL and web origin to the service's generated domain.
  const railway = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined;
  if (railway) env = { ...env, PUBLIC_API_URL: env.PUBLIC_API_URL || railway, WEB_ORIGINS: env.WEB_ORIGINS || railway };
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`).join('\n');
    throw new Error(`Invalid ApplyFlux server configuration:\n${msg}\nSee .env.example and docs/DEPLOYMENT.md.`);
  }
  return parsed.data;
}

export const autoSubmitPlatforms = (c: Config) =>
  new Set(
    c.AUTO_SUBMIT_PLATFORMS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
