-- Traçabilité des exécutions de synchronisation (FFBB, et plus tard FBI).
create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('ffbb', 'fbi')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'partial', 'error')),
  stats jsonb not null default '{}'::jsonb,
  error_log text,
  created_at timestamptz not null default now()
);

comment on table public.sync_runs is
  'Une ligne par exécution du service de synchronisation (FFBB ou FBI). Alimente /admin/sync.';

create index sync_runs_provider_started_at_idx on public.sync_runs (provider, started_at desc);

alter table public.match_change_history
  add constraint match_change_history_sync_run_id_fkey
  foreign key (sync_run_id) references public.sync_runs (id) on delete set null;
