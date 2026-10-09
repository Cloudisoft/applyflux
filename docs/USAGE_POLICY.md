# Daily limit policy

ApplyFlux has no plans or subscriptions. The only limits are the ones each person sets in Automation Settings: a daily application limit (1–200) and how many applications run at once (1–5).

- **Counted toward the daily limit:** an application ApplyFlux submits, whether the confirmation is verified (`SUBMITTED`) or not (`SUBMISSION_UNVERIFIED`). One unit per application, ever — the ledger key is `(user, 'application', application_id)`.
- **Not counted:** failed, skipped, stopped or cancelled attempts; applications the person marks as "applied manually"; retries.
- **Reservation:** when the extension claims an application, one unit is reserved under a per-user advisory lock, so concurrent claims can never exceed the daily limit. The reservation is released when the application leaves the active states without a submission.
- Hitting the limit pauses the run and notifies the person.
- AI drafting (cover letters, tailoring, answers) is not metered.
