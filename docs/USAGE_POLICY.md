# Usage counting policy

- **Counted:** an application ApplyFlux submits, whether the confirmation is verified (`SUBMITTED`) or not (`SUBMISSION_UNVERIFIED`). One unit per application, ever — the ledger key is `(user, 'application', application_id)`.
- **Not counted:** failed, skipped, stopped or cancelled attempts; applications the person marks as "applied manually"; retries.
- **Reservation:** when the extension claims an application, one unit is reserved under a per-user advisory lock, so concurrent claims can never exceed the monthly or daily limit. The reservation is released when the application leaves the active states without a submission.
- **Daily limit:** `min(user daily limit, plan daily limit)`. Hitting a limit pauses the run and notifies the person.
- **AI generations:** each cover letter, tailoring or answer-drafting request counts once (idempotency key per request); blocked when the monthly AI allowance is used up.
- Limits live in the `plans` table; nothing commercial is hard-coded.
