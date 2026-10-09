# ApplyFlux architecture

```
┌──────────────────────┐   Supabase Auth (JWT)   ┌──────────────────────────────┐
│ apps/web (React/Vite)│────────────────────────▶│ apps/server (Express, Node)  │
│ landing, app, setup  │◀──── Realtime (RLS) ────│  /api      REST (validated)  │
└──────────┬───────────┘                         │  /api/ext  extension protocol│
           │ externally_connectable (pair only)  │  /sandbox  mock employer     │
┌──────────▼───────────┐   Ext token (revocable) │  sweeper   lease recovery    │
│ apps/extension (MV3) │────────────────────────▶└──────┬───────────────┬───────┘
│ service worker +     │                                │ pg (txns,      │ service role
│ content script       │                                │ locks)         ▼
│ (@applyflux/form-    │                         ┌──────▼──────┐  ┌──────────────┐
│  engine in the page) │                         │ Supabase PG │  │ Supabase      │
└──────────────────────┘                         │ RLS, triggers│  │ Storage (priv)│
                                                 └─────────────┘  └──────────────┘
packages/shared       states, schemas, matching, question rules, liveness (shared by all)
packages/form-engine  DOM detection → mapping → filling, CAPTCHA/auth detection, adapters, evidence
```

## Key decisions

- **Supabase Postgres is the source of truth.** The API connects with a privileged Postgres role for transactions, advisory locks and `FOR UPDATE SKIP LOCKED`; every query is scoped to the authenticated user. RLS is the second line of defence and powers Realtime. Clients have no write policies on applications, usage, consent, documents or extension tokens.
- **Automation runs in the user's browser.** The extension is the executor; the server is the coordinator. Execution is a resumable workflow of short calls (`/next`, `/heartbeat`, `/report`), not a long HTTP request. Each claim carries a 120 s lease extended by heartbeats.
- **State machine** (`packages/shared/src/states.ts`) is enforced twice: in TypeScript and by a database trigger (a test asserts they are identical). Re-queueing after a submit click is refused by the database.
- **Submission verification**: the extension reports evidence (final URL, confirmation text, form still present, visible errors). The server judges it (`judgeEvidence`) — `SUBMITTED` needs a confirmation signal with the form gone; anything weaker is `SUBMISSION_UNVERIFIED`; visible errors are `NEEDS_ATTENTION`. A `SUBMITTED` row without evidence is rejected by a check constraint.
- **Human verification**: a CAPTCHA moves only that application to `AWAITING_HUMAN_VERIFICATION` (others continue), preserves `step_state`, focuses the tab and notifies. Resolution requires evidence (provider token present, no challenge visible). Bounded: the 4th challenge → `NEEDS_ATTENTION`; 30 minutes without completion → `NEEDS_ATTENTION`.
- **Recovery**: the sweeper re-queues expired leases before a submit click (bounded attempts) and sends anything after a submit click to `NEEDS_ATTENTION` with an explanation — never an automatic retry.
- **Daily limit** (the person's own setting): reserved at claim under a per-user advisory lock (concurrency-safe), charged once per application via a unique ledger key, released on failure/skip/stop. See `USAGE_POLICY.md`.
- **Answers**: saved approved answer → deterministic answer from verified profile facts → (non-sensitive only) grounded AI draft checked for unsupported numbers/credentials. Work authorisation, sponsorship, citizenship, demographics, disability, veteran, criminal history and legal consent are never AI-answered.
- **Untrusted content**: job descriptions and form labels are wrapped as data in prompts; the extension validates every message with zod and accepts only pairing from web pages.

## Modules

| Path | Purpose |
|---|---|
| `supabase/migrations` | Schema, RLS, state trigger, storage, execution controls |
| `packages/shared` | Types, zod schemas, state machine, match scoring, question classification, profile assessment, normalisation, liveness |
| `packages/form-engine` | Field detection, mapping, filling, file attachment, CAPTCHA/sign-in detection, confirmation evidence, platform adapters |
| `apps/server` | REST API, extension protocol, queue workflow, resume parsing (PDF/DOCX/TXT/RTF), discovery, AI, sandbox, migrations runner |
| `apps/extension` | MV3 service worker (coordination), content script (engine), popup |
| `apps/web` | Public site, auth, onboarding wizard, dashboard, control center, all product screens |
| `e2e` | Playwright: real Chromium + built extension + API + Postgres against the Sandbox |
