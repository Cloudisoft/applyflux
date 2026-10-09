# Testing

| Command | What it runs | Needs |
|---|---|---|
| `pnpm test` | Unit + integration tests in every package | PostgreSQL reachable at `postgres://applyflux:applyflux@localhost:5432/postgres` (override with `TEST_ADMIN_DATABASE_URL`) |
| `pnpm test:e2e` | Playwright: real Chromium + built extension + API + Postgres + built web app | Same Postgres; Chromium (`npx playwright install chromium`) |
| `pnpm typecheck` | `tsc` across all packages | — |

Integration tests create throw-away databases, apply `supabase/tests/supabase_shim.sql` (a minimal stand-in for Supabase's `auth`/`storage` schemas and roles — **test only**) and then the real migrations. The AI provider is replaced by a test double at the HTTP boundary; job-board HTTP is stubbed. No test contacts a real employer.

## Results (this release)

All executed and passing:

| Suite | Tests | Covers |
|---|---|---|
| `packages/shared` | 27 | State machine integrity, URL canonicalisation, ATS detection, keyword boundaries, match scoring & sponsorship concerns, question classification (incl. citizenship → sensitive), answers only from verified facts, option matching, profile completeness & date contradictions, phone/date normalisation, liveness (ported) |
| `packages/form-engine` | 18 | Greenhouse-, Lever- and Workday-shaped forms: label resolution, mapping, React-select comboboxes, file upload, checkbox groups, radios, repeating work history/education, saved-answer reuse, AI answers refused for sensitive questions, Auto Mode refuses unverified facts, Review Mode flags them, reCAPTCHA detection & token evidence, sign-in walls, submission evidence verdicts, LinkedIn manual-only |
| `apps/server` RLS | 10 | Bootstrap trigger, per-user isolation, anon access, no client writes to applications/usage/consent, token hashes unreadable, storage folder isolation, DB state machine identical to TS, evidence constraint, no re-queue after submit |
| `apps/server` queue | 13 | Idempotent/duplicate-safe enqueue, extension required, full claim→review→approve→submit→verified flow charged once, unverified evidence, CAPTCHA pause/resume with evidence only, bounded challenges, one CAPTCHA doesn't block others, lease recovery before vs after submit, bounded retries, pause/stop signals, revoked extension, concurrent claims vs daily limit, Auto Mode consent/platform gating |
| `apps/server` API | 14 | Resume upload (PDF) → AI extraction with fabricated role dropped → review → apply as unverified; content-sniffed uploads; profile validation; cross-user access; forged tokens; board sync, scoring, expiry on resync; exclusions & dedup; source failures; answer engine order and grounding guard; cover letter generation & PDF render; studio gap analysis; export & deletion; platform matrix (no plans endpoint) |
| `apps/web` | 4 | UI utilities |
| `apps/extension` | 3 | Message validation (content script and external pages) |
| E2E agent | 5 | Real extension in Chromium against the Sandbox: Auto Mode submit-once with resume attached; CAPTCHA before form (pause → person completes → resume → submitted once); CAPTCHA at submit (no duplicate); Review Mode multi-step (all steps filled, approval, submitted once); honest outcomes (unverified, validation error → needs attention + retry refused, sign-in wall) |
| E2E UI | 3 | Public site with live platform data; every authenticated screen renders from the API without console errors; dark mode; mobile layouts without horizontal overflow |

Additional manual, read-only verification performed during development:
- Greenhouse, Lever and Ashby public board APIs fetched live through `fetchBoard` (216 / 309 / 818 postings) and liveness checks returned `active`.
- Field detection and mapping run against live Greenhouse and Lever application page markup (read-only; nothing filled or submitted).

The E2E suite caught two real defects during development, both fixed: a CAPTCHA resolved during submit resumed in the wrong phase, and a re-injected content script registered a second listener that submitted an approved review twice.
