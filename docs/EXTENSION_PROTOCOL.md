# Extension ↔ API protocol

All endpoints are under `/api/ext`. Bodies are JSON validated with the zod schemas in `packages/shared/src/schemas.ts`. Errors use `{ "error": { "code", "message" } }`.

## Pairing
1. Web app (signed in): `POST /api/extension/pairing-code` → `{ code: "ABCD-2345", expiresInSeconds: 600 }` (single use, rate limited).
2. Extension: `POST /api/ext/pair { code, name, version }` → `{ token, connectionId }`. The token is random, stored only as SHA-256 on the server, valid 90 days, revocable from the web app (`DELETE /api/extension/connections/:id`).
3. All other calls send `Authorization: Ext <token>`. A revoked/expired token returns `401 EXTENSION_REVOKED`.

## Execution loop
| Call | Purpose |
|---|---|
| `GET /session` | Run status and queue counts |
| `POST /next` | Claim the next queued application (locks, concurrency, quota). Returns an `ExecutionTask` or `{ idle, reason }` |
| `POST /applications/:id/heartbeat` | Extend the lease; returns `signal: continue | pause | stop` and `submitApproved` |
| `POST /applications/:id/report` | One of the `ExtensionReport` types below |
| `POST /answers` | Resolve screening questions (saved → verified facts → grounded AI for non-sensitive) |
| `GET /documents/:id?u&e&s` | HMAC-signed, 10-minute download of the user's own resume/cover letter |
| `POST /jobs` | "Save this job" from the current page |
| `POST /run/start|pause|stop` | Popup controls |

### Reports
- `progress` — step, %, adapter, field results, `stepState`
- `intervention` — `captcha | mfa | login_required | missing_answers | unexpected_form | automation_restricted | validation_errors | unexpected_navigation | …`
- `verification_resolved` — evidence `{ tokenPresent, challengeVisible, provider }`; refused unless the token is present and no challenge is visible
- `ready_for_review` — form filled, waiting for the person
- `submit_attempted` — must precede `submission_result`; after it, the application is never re-queued automatically
- `submission_result` — evidence; the server decides `SUBMITTED` / `SUBMISSION_UNVERIFIED` / `NEEDS_ATTENTION`
- `failed` — `{ code, message, retryable }`; bounded retries only before a submit attempt

Every report requires the caller to hold the application's lease (`409 LEASE_LOST` otherwise).
