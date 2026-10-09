# Deploying ApplyFlux

ApplyFlux has three deployables, all built from this monorepo:

| Part | Where it runs | Built by |
|---|---|---|
| API + web app (single origin) | Replit (or any Node 20+ host) | `pnpm build` → `apps/server/dist`, `apps/web/dist` |
| Database, auth, file storage, realtime | Supabase | `supabase/migrations/*.sql` |
| ApplyFlux Agent (Chrome MV3) | Users' Chrome | `pnpm --filter @applyflux/extension build` → `apps/extension/dist` |

## 1. Supabase

1. Create a project. Note the **Project URL**, **anon key** and **service_role key** (Project Settings → API) and the **database connection string** (Project Settings → Database).
2. Apply the migrations — either:
   - `supabase link --project-ref <ref> && supabase db push` (Supabase CLI), or
   - `DATABASE_URL=<connection string> DATABASE_SSL=true pnpm --filter @applyflux/server db:migrate` (no CLI needed; records applied files in `public.applyflux_migrations`).
   The migrations create every table, RLS policy, the state-transition trigger, the `on_auth_user_created` bootstrap trigger, the private `documents` storage bucket and its policies, the plan catalogue, and add the queue tables to the `supabase_realtime` publication.
3. **Auth** → URL configuration: set Site URL to your web origin and add `https://<origin>/app/setup` and `https://<origin>/reset-password` to Redirect URLs. Enable "Confirm email" if you want email verification (the sign-up screen handles both cases).
4. **Plans**: prices are `NULL` (shown as "Pricing not yet published"). Change limits or set prices with SQL, e.g. `update plans set price_cents = 1900, currency = 'USD' where id = 'pro';`. Move a user to a plan with `update subscriptions set plan_id = 'pro' where user_id = '…';` (no payment provider is integrated).

## 2. API + web app on Replit

1. Import the repository into Replit. `.replit` and `replit.nix` are included.
2. Add the variables from `.env.example` as **Secrets** (server values and the `VITE_*` values — the web build reads `VITE_*` at build time). Required: `DATABASE_URL`, `DATABASE_SSL=true`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DOWNLOAD_SIGNING_SECRET`, `PUBLIC_API_URL`, `WEB_ORIGINS`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
3. Deploy. The deployment build runs `pnpm install && pnpm build && pnpm db:migrate`; the run command is `pnpm start`, which serves the API at `/api`, the Sandbox at `/sandbox`, and the web app for every other path.
4. Check `GET /api/health` → `{"data":{"ok":true,"ai":…}}`.

The server refuses to start with an invalid configuration and prints exactly which variable is wrong.

### AI (optional)
Set `AI_PROVIDER=openai` + `OPENAI_API_KEY`, or `AI_PROVIDER=openrouter` + `OPENROUTER_API_KEY` (optionally `AI_MODEL`). Without it, ApplyFlux uses rule-based resume extraction and asks the person for open-ended answers; the UI says so.

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
