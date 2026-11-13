-- Track how many manually_found_educ_leads rows each router run set to '10A'
-- (bounced-lead status). Added when bounced threads began also updating the lead table.

alter table public.educ_router_runs
  add column if not exists leads_updated int not null default 0;
