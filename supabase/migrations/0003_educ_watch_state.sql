-- State for the PUSH-based lead-response-router (main_task 2).
--
-- This router piggybacks on the drafter's existing Gmail watch + Pub/Sub topic via a
-- SECOND push subscription, so it must keep its OWN processing baseline (separate from
-- the drafter's public.gmail_watch_state, which the drafter advances on every run).
--
-- Only the service_role (the edge function) touches these; RLS is ON with no policies.

-- Processing position, one row per watched mailbox (keyed by the notification's
-- emailAddress, i.e. james@...). Self-seeds on the first push it receives.
create table if not exists public.educ_watch_state (
  email_address   text primary key,
  last_history_id text,
  updated_at      timestamptz not null default now()
);

-- Idempotency ledger so duplicate / retried Pub/Sub deliveries never route a thread
-- twice. action: 'responded' (routed) or 'skip' (locked then filtered out).
create table if not exists public.educ_processed_messages (
  message_id   text primary key,
  thread_id    text,
  action       text,
  processed_at timestamptz not null default now()
);

create index if not exists educ_processed_messages_processed_at_idx
  on public.educ_processed_messages (processed_at);

alter table public.educ_watch_state        enable row level security;
alter table public.educ_processed_messages enable row level security;
