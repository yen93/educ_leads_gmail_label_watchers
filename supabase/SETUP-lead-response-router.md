# Setup — lead-response-router push subscription (one manual GCP step)

`lead-response-router` is PUSH-based "just like gmail_drafter". Gmail allows only ONE
`users.watch` per mailbox, and the drafter already owns it (INBOX + its action labels →
Pub/Sub topic `projects/n8nautomations-498202/topics/gmail-inbound`, daily renewal cron).

So this router does **not** arm its own watch. It receives the SAME notifications via a
**second push subscription** on that existing topic. INBOX is already in the watch and
lead replies land in INBOX, so they push to both the drafter and this router. Each
function filters independently and keeps its own baseline, so they never interfere.

## The one step: add a second push subscription

Everything else is already live (function deployed `verify_jwt=false`; state tables
`educ_watch_state` / `educ_processed_messages` created). Only this subscription is left,
and it must be created in the **OAuth client's GCP project** `n8nautomations-498202`
(same project as the topic) — it can't be created from Supabase.

**Values**
- Topic: `projects/n8nautomations-498202/topics/gmail-inbound`
- New subscription id: `gmail-inbound-lead-response-push`
- Delivery type: **Push**
- Push endpoint:
  `https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/lead-response-router?token=<PUSH_SHARED_SECRET>`
  (same `PUSH_SHARED_SECRET` the drafter uses; it's the `?token=` in the existing
  `renew-gmail-watch-daily` cron and is set as a Supabase secret)
- Ack deadline: ~60s. No OIDC — the URL token is the auth.

**gcloud (run against n8nautomations-498202):**
```
gcloud pubsub subscriptions create gmail-inbound-lead-response-push \
  --project=n8nautomations-498202 \
  --topic=projects/n8nautomations-498202/topics/gmail-inbound \
  --push-endpoint="https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/lead-response-router?token=<PUSH_SHARED_SECRET>" \
  --ack-deadline=60
```

Or Console: Pub/Sub → Subscriptions → Create → pick the topic → Delivery **Push** →
paste the endpoint → Ack deadline 60s → Create.

No publisher/IAM change is needed: the topic already grants
`gmail-api-push@system.gserviceaccount.com` the Publisher role for the drafter.

## After it's created
- The first notification this router receives seeds `public.educ_watch_state`
  (records the historyId and acks) — so the FIRST event after setup is only used to
  seed, same as the drafter.
- Verify end-to-end: reply (from an external address) to a thread currently labelled
  `follow-up-sequence-ed-sector`. Within seconds the thread should move to
  `@ sales to action/outbound lead responses` (ed-sector removed), and that lead's row
  in `manually_found_educ_leads` should flip to `8A`.
- Logs: Supabase → Edge Functions → `lead-response-router` → Logs.
- `select * from public.educ_router_runs where router='lead-response-router' order by ran_at desc;`

## Manual reprocess / backfill
`…/lead-response-router?token=<PUSH_SHARED_SECRET>&thread=<threadId>` processes one
thread directly (bypasses Pub/Sub): if it's an ed-sector thread with an inbound reply,
it routes it and sets the lead to `8A`. Useful for testing or backfilling a thread that
already got a reply before setup.
