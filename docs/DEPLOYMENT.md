# Deploying ApplyFlux

ApplyFlux has three deployables, all built from this monorepo:

| Part | Where it runs | Built by |
|---|---|---|
| API + web app (single origin) | Railway | `pnpm build` → `apps/server/dist`, `apps/web/dist` |
| Database, auth, file storage, realtime | Supabase | `supabase/migrations/*.sql` |
| ApplyFlux Agent (Chrome MV3) | Users' Chrome | `pnpm --filter @applyflux/extension build` → `apps/extension/dist` |

## 1. Supabase

1. Create a project. Note the **Project URL**, **anon key** and **service_role key** (Project Settings → API) and the **database connection string** (Project Settings → Database).
2. Apply the migrations — either:
   - `supabase link --project-ref <ref> && supabase db push` (Supabase CLI), or
   - `DATABASE_URL=<connection string> DATABASE_SSL=true pnpm --filter @applyflux/server db:migrate` (no CLI needed; records applied files in `public.applyflux_migrations`).
   The migrations create every table, RLS policy, the state-transition trigger, the `on_auth_user_created` bootstrap trigger, the private `documents` storage bucket and its policies, and add the queue tables to the `supabase_realtime` publication.
3. **Auth** → URL configuration: set Site URL to your web origin and add `https://<origin>/app/setup` and `https://<origin>/reset-password` to Redirect URLs. Enable "Confirm email" if you want email verification (the sign-up screen handles both cases).

## 2. API + web app on Railway

`railway.json` and `.node-version` (Node 22) are included, so Railway needs no extra build settings.

1. In Railway: **New Project → Deploy from GitHub repo** and pick this repository. One service runs everything.
2. **Settings → Networking → Generate Domain** to get a public URL. `PUBLIC_API_URL` and `WEB_ORIGINS` default to it automatically (`RAILWAY_PUBLIC_DOMAIN`); set them explicitly only for a custom domain.
3. **Variables** — add these (Railway exposes them at build time too, which the web build needs for `VITE_*`):
   - `NODE_ENV=production`
   - `DATABASE_URL` (Supabase *session* connection string) and `DATABASE_SSL=true`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `DOWNLOAD_SIGNING_SECRET` (`openssl rand -hex 32`)
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   - AI: `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_FALLBACK_PROVIDER=openai`, `OPENAI_API_KEY`
   - optional: `EXTENSION_ORIGINS`, `VITE_EXTENSION_ID`, `APPLYFLUX_EXTENSION_KEY`, `AUTO_SUBMIT_PLATFORMS`, `DISCOVERY_INTERVAL_HOURS`, `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` (broader automatic job search)
4. Deploy. Railway runs `pnpm install && pnpm build`, then `pnpm db:migrate` as the pre-deploy step (applies any new migrations before traffic switches), then `pnpm start`. `PORT` is supplied by Railway.
5. The deploy is healthy when `GET /api/health` returns `{"data":{"ok":true,…}}` (Railway's health check uses this path).

The server refuses to start with an invalid configuration and prints exactly which variable is wrong (see **Deploy Logs**).

### AI (optional)
- **Primary:** `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` uses Claude (`claude-opus-5-5` by default; override with `ANTHROPIC_MODEL`) through the official Anthropic SDK. If Claude declines a request on safety grounds, the API automatically retries it on another suitable Claude model in the same call.
- **Fallback:** `AI_FALLBACK_PROVIDER=openai` + `OPENAI_API_KEY` (or `openrouter` + `OPENROUTER_API_KEY`). When the primary errors — outage, rate limit, bad key, malformed output — the same request goes to the fallback. A safety refusal is never re-sent to a different provider.
- Either provider can be primary. Without any AI, ApplyFlux uses rule-based resume extraction and asks the person for open-ended answers; the UI says so.

## 3. The ApplyFlux Agent extension

```bash
APPLYFLUX_API_URL=https://your-api.example APPLYFLUX_WEB_URL=https://your-web.example NODE_ENV=production \
  pnpm --filter @applyflux/extension build
```

- Load `apps/extension/dist` via `chrome://extensions` → Developer mode → Load unpacked, or zip it for the Chrome Web Store.
- After publishing, set `EXTENSION_ORIGINS=chrome-extension://<id>` on the API and `VITE_EXTENSION_ID=<id>` (one-click pairing) and `VITE_EXTENSION_STORE_URL` on the web build.
- Permissions: `storage`, `alarms`, `scripting`, plus host access to the API origin. Job-site access (`https://*/*`) and `notifications` are **optional** and requested from the popup when the person chooses.

## 4. Enabling automatic submission for a real platform

`AUTO_SUBMIT_PLATFORMS` defaults to `sandbox`. Before adding `greenhouse` or `lever`:
1. Validate the adapter on that platform with a test posting you control (or the employer's explicit permission) in Review Mode and confirm every field.
2. Review the platform's terms for automated submissions.
3. Add the id (e.g. `AUTO_SUBMIT_PLATFORMS=sandbox,greenhouse`) and redeploy. Workday, iCIMS, Ashby and the generic adapter never auto-submit (adapter capability is off); LinkedIn is never automated.
