-- Audit log for the education-sector Gmail label routers (educ-bounced-threads-router,
-- and later the lead-response-router). Append-only: one row per run with counts +
-- a jsonb detail of what moved. Only the service_role (the edge functions) touches
-- it; RLS is ON with no policies, so anon/authenticated get nothing and service_role
-- bypasses RLS.

create table if not exists public.educ_router_runs (
  id       bigint generated always as identity primary key,
  router   text not null,                       -- e.g. 'bounced-threads-router'
  ran_at   timestamptz not null default now(),
  scanned  int  not null default 0,             -- threads inspected this run
  bounced  int  not null default 0,             -- threads detected as bounced/blocked
  moved    int  not null default 0,             -- threads successfully moved to closed
  errors   int  not null default 0,
  detail   jsonb                                -- moved threads / notes / error text
);

create index if not exists educ_router_runs_ran_at_idx
  on public.educ_router_runs (ran_at desc);

alter table public.educ_router_runs enable row level security;
