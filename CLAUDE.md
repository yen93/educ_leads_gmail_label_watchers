# CLAUDE.md — educ_leads_gmail_label_watchers

Working notes for a future Claude session. For a current-state inventory see
`as_built.txt`; for the lead-response push setup see
`supabase/SETUP-lead-response-router.md`; for session history see `chat_history/`.

## What this project is
Two Gmail "routers" (Supabase edge functions) that triage the **education-sector
outbound follow-up sequence** living in **james@myadventuregroup.com.au**:

1. **`educ-bounced-threads-router`** (DAILY cron, 06:00 PH) — scans threads still in
   `follow-up-sequence-ed-sector`, and for any **bounced/blocked** thread: moves it to
   `follow-up-sequence-closed` and sets the matching lead to **`10A`**.
2. **`lead-response-router`** (PUSH) — when a lead **replies** to an ed-sector thread,
   moves it to `@ sales to action/outbound lead responses` and sets the lead to **`8A`**.

Both reuse the sibling **`email_drafter_edge_function`** project's mailbox, auth, and
Supabase project. This is a separate project folder; nothing here modifies the drafter.

## The one architectural constraint that shapes everything
**Gmail allows only ONE `users.watch` per mailbox, and `gmail_drafter` already owns it**
(INBOX + its action labels → Pub/Sub topic `projects/n8nautomations-498202/topics/gmail-inbound`,
kept alive by its own daily renewal cron). Therefore:
- `lead-response-router` does **NOT** arm its own watch. It rides the drafter's existing
  watch/topic via a **second push subscription** (`gmail-inbound-lead-response-push`).
  INBOX is already watched and lead replies land in INBOX, so both functions get every
  push and filter independently.
- It keeps its **own** baseline in `public.educ_watch_state` (NEVER the drafter's
  `gmail_watch_state`) so the two don't fight over the processing position.
- `educ-bounced-threads-router` needs no push at all — it's a scheduled Gmail search.

## Auth & target mailbox (same as the drafter)
- Mailbox = `james@` ; Gmail calls act as `users/me`.
- OAuth **refresh-token** flow (NOT domain-wide delegation) — `_shared/google-auth.ts`
  is a verbatim copy of the drafter's. Secrets `GMAIL_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`
  are already set on the project (shared with the drafter + n8n; if revoked, those break too).
- `PUSH_SHARED_SECRET` (the `?token=` auth for both functions) is reused from the drafter
  and is embedded in the `renew-gmail-watch-daily` cron URL — read it from `cron.job`
  rather than inventing a new one.

## Layout
- `supabase/functions/educ-bounced-threads-router/index.ts` — daily bounce router.
- `supabase/functions/lead-response-router/index.ts` — push response router.
- `supabase/functions/_shared/` — `google-auth.ts`, `gmail.ts`, `labels.ts` (shared by
  both). `labels.ts` holds the three label search tokens.
- `supabase/migrations/0001..0003` — `educ_router_runs` (audit) + `leads_updated` column,
  and `educ_watch_state` + `educ_processed_messages` (lead-response state/idempotency).
- `supabase/schedule_bounced_router.sql` — the daily cron (already applied).
- `supabase/SETUP-lead-response-router.md` — the one manual GCP (Pub/Sub) step.

## Key decisions & gotchas (non-obvious)
- **Target labels are in james@, NOT the connected julienne@ mailbox.** Don't try to
  verify them via the Gmail MCP (that's julienne@). Resolution happens at runtime via the
  OAuth token, separator-insensitively (case/space/`/`/punctuation don't matter).
- **"Route"/"move" = add target label + remove `follow-up-sequence-ed-sector`** in ONE
  atomic `threads.modify`, so the sequence stops chasing. (If a future ask wants to KEEP
  ed-sector, change `modifyThreadLabels(..., [targetId], [edId])` to drop the remove arg.)
- **Lead matching is by EMAIL, never thread_id.** The `thread_id` stored in
  `manually_found_educ_leads` is the OUTBOUND thread; a bounce/reply often lives under a
  different Gmail thread id. Match `WHERE email IN (...)` using the failed-recipient /
  responder / outbound-To addresses (lowercased; internal `@myadventuregroup.com.au`
  dropped). Status values: bounced → `10A`, responded → `8A`.
- **DB writes are in-place UPDATEs** on the natural key (email). Never truncate / bulk
  delete — see the global data-safety rule. `educ_router_runs` is append-only audit.
- **Bounce detection** (bounced router): From `mailer-daemon`/`postmaster`; DSN subjects
  (undeliverable / delivery status notification / failure notice / delivery incomplete /
  message blocked / …); an `X-Failed-Recipients` header; or a `multipart/report` /
  `message/delivery-status` MIME part. Conservative on purpose; regex is easy to widen.
- **Response detection** (response router): a NEW inbound message in INBOX whose thread
  carries ed-sector and which is a genuine reply — not SENT/DRAFT, not mailer-daemon
  (that's the bounce router's job), not `no-reply`, not internal, not self.
- **`?thread=<id>` mode** on both functions processes a single thread directly (bypasses
  cron/Pub/Sub) — use it to backfill or test without waiting for a live event.
- **getThread uses `format=metadata`** (From/To/Subject/X-Failed-Recipients + labelIds) to
  keep payloads small; the MIME structure is still present for DSN-part detection.

## Deploy / run
- **Deploy via the Supabase MCP `deploy_edge_function`** (the Supabase CLI is blocked by
  Windows App Control on this machine). MCP does NOT bundle from disk, so pass the
  entrypoint + **all** `_shared/*.ts` files on every deploy, `verify_jwt=false`, file
  names in the deployed form (`functions/<name>/index.ts`, `functions/_shared/*.ts`).
- Target project = **MAGTestProject** (`aivitcomiywiysrfwqxt`).
- The lead-response Pub/Sub subscription is created in GCP project
  `n8nautomations-498202` (needs `gcloud auth login` + Pub/Sub rights there) — see the
  SETUP doc. No IAM change needed; the topic already grants the Gmail publisher.

## Verify
- Bounced router: `POST …/educ-bounced-threads-router?token=…` → JSON
  `{scanned,bounced,moved,leadsUpdated,errors}`; `select * from educ_router_runs …`.
- Response router: reply (external address) to an ed-sector thread → it moves to the
  responses label and the lead flips to `8A`; `select * from educ_router_runs where
  router='lead-response-router' …`; `select * from educ_watch_state;`.

## Open items (not yet decided by the user)
- Move vs. KEEP `ed-sector` on a response (currently MOVE).
- Whether to stop `draft-james-reply` auto-drafting once a lead has responded (both
  functions see the same INBOX push, so the drafter currently also drafts a reply).
- Optional one-time backfill of existing ed-sector threads that already got a reply.

## Conventions
- This folder is not a git repo managed by Claude; the user handles all git/GitHub.
  `/dcp` here documents (chat_history, as_built, CLAUDE.md, .gitignore) but runs no git.
- Target Supabase project deliberately = MAGTestProject (`aivitcomiywiysrfwqxt`).
