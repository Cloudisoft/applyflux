# ApplyFlux by Cloudisoft

**One profile. Every opportunity. Applications on autopilot.**

ApplyFlux turns a resume into a verified candidate profile, discovers matching roles from company job boards, and fills, submits and tracks job applications through a Chrome extension. It pauses for a person whenever one is needed: CAPTCHAs, sign-ins, uncertain answers, or review.

```
apps/web        React + Vite + Tailwind: public site, auth, onboarding, dashboard, control center, all screens
apps/server     Express API (Node 20, TypeScript): REST, extension protocol, queue workflow, AI, parsing, sandbox
apps/extension  ApplyFlux Agent: Chrome Manifest V3 service worker + content script + popup
packages/shared       state machine, schemas, matching, question rules, profile assessment
packages/form-engine  form detection/mapping/filling, CAPTCHA & sign-in detection, platform adapters, evidence
supabase/migrations   schema, RLS, triggers, storage policies, plans
e2e                   Playwright suites (real Chromium + extension + API + Postgres)
docs/                 ARCHITECTURE · DEPLOYMENT · EXTENSION_PROTOCOL · COMPATIBILITY · USAGE_POLICY · TESTING
```

## What works

- **Accounts:** sign up, sign in, sign out, email verification (when enabled in Supabase), password reset, persistent sessions, protected routes, and a 9-step setup wizard with progress tracking.
- **Candidate profile:** PDF/DOCX/TXT/MD/RTF uploads, validated by content sniffing. Extraction is rule-based, or AI-based when configured. AI output is cross-checked against the file, so invented roles are dropped. You review the result before it touches your profile.
  - Facts carry their source (resume, user, or AI suggestion) and whether you verified them.
  - The profile shows completeness, missing fields, and date contradictions.
  - You can keep multiple resumes with versioning, preview, and download.
- **Resume Studio & Cover Letter Studio:** keyword gap analysis, tailoring that never adds skills you lack (saved as a new PDF version), and grounded cover-letter drafts. You edit and approve drafts, which render to a verified PDF for attachment.
- **Job discovery:** public Greenhouse, Lever and Ashby boards, plus manual import and "Save job" from the extension.
  - Filters, sorting, saved searches, bookmarks, and shortlists.
  - Duplicate detection by canonical URL and role fingerprint, and expiry detection.
  - A transparent match score explaining matched skills, missing skills, and concerns such as no-sponsorship statements.
- **Auto Apply:** Review, Assisted and Auto modes, with start, pause, resume and stop.
  - The persistent queue uses leases, row locks, bounded retries, a concurrency limit, and recovery after disconnection.
  - Submissions are verified from evidence, so "submitted" and "unverified" stay distinct. An application is never re-queued after a submit click.
  - Usage is reserved and charged exactly once.
- **Human verification:** a CAPTCHA, sign-in or MFA prompt pauses only that application and preserves its progress. ApplyFlux focuses the tab, notifies you, and resumes only on evidence that verification succeeded. Retries are bounded. It never solves or bypasses a challenge.
- **Answer engine:** answers come from approved saved answers first, then verified profile facts, then grounded AI drafts. AI drafts apply only to non-sensitive questions and are checked for unsupported claims. Questions about authorisation, sponsorship, citizenship, demographics and similar topics are never AI-answered.
- **Dashboard & Control Center:** live metrics from stored records, intervention alerts, Supabase Realtime updates, and notifications.
- **Privacy:** RLS on every table, private storage, server-side secrets, a least-privilege extension, audit events, explicit versioned consent for Auto Mode, and JSON export and full account deletion.

## Quick start (local)

```bash
corepack enable && pnpm install
cp .env.example .env              # fill in Supabase + secrets (see docs/DEPLOYMENT.md)
pnpm --filter @applyflux/server db:migrate     # needs DATABASE_URL
pnpm dev                          # API on :3001, web on :5173 (proxied /api)
pnpm --filter @applyflux/extension build   # load apps/extension/dist in chrome://extensions
```

Production runs on **Railway** (`railway.json` included): build `pnpm build`, pre-deploy `pnpm db:migrate`, start `pnpm start`. The API serves the web app from the same origin. See **docs/DEPLOYMENT.md**.

## Environment variables

See `.env.example`.
- **Required (server):** `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DOWNLOAD_SIGNING_SECRET`, `PUBLIC_API_URL`, `WEB_ORIGINS`.
- **Required (web build):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- **Optional:** `AI_PROVIDER` + `OPENAI_API_KEY`/`OPENROUTER_API_KEY`, `AI_MODEL`, `SUPABASE_JWT_SECRET`, `EXTENSION_ORIGINS`, `AUTO_SUBMIT_PLATFORMS`, `VITE_EXTENSION_ID`, `VITE_EXTENSION_STORE_URL`, `ENABLE_SANDBOX`.

The server validates its configuration at startup and refuses to run with unsafe settings (e.g. in-memory storage in production).

## Tests

`pnpm test` runs 89 unit and integration tests, including RLS, the state machine, the queue, CAPTCHA flows and quota races, all against real PostgreSQL. `pnpm test:e2e` runs 8 Playwright tests with the real extension in Chromium. Both pass; details are in **docs/TESTING.md**.

## Honest limitations

- **Auto-submit is enabled only for the ApplyFlux Sandbox by default.** The Greenhouse and Lever adapters can auto-submit and are tested against representative markup. They read live pages correctly, but they have not submitted to a real employer. Enable them per deployment after validating (`AUTO_SUBMIT_PLATFORMS`).
- **Workday, iCIMS, Ashby and generic career pages** support filling plus Review or Assisted mode only. Workday usually requires an account sign-in, which ApplyFlux hands to you.
- **LinkedIn (including Easy Apply) is not automated**, because its User Agreement prohibits automated access. Such jobs are detected and tracked, and you apply manually.
- **Billing:** no payment provider is integrated. Plans and limits are configurable data, prices are unpublished (`NULL`), and an administrator assigns plans.
- **Live services not verified from this build environment:** Supabase Auth/Storage/Realtime and the OpenAI/OpenRouter APIs. The code paths are implemented, and tests use a Postgres shim and an HTTP test double, so verify them on first deploy with real credentials.
- **No official Cloudisoft logo** was available. The UI uses an ApplyFlux product mark and names Cloudisoft in text. Replace `apps/web/public/brand/` with official assets when available.
- Scanned (image-only) PDFs aren't OCR'd. The user is asked for a text-based PDF or DOCX.
- If the browser's service worker restarts mid-application, that application goes back to the queue, or to "Needs attention" if a submit was already clicked.

ApplyFlux adapts MIT-licensed work from [career-ops](https://github.com/career-ops-hq/career-ops). See `THIRD_PARTY_NOTICES.md`.
