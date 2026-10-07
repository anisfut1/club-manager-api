-- Journal du worker de test FBI « session persistante » (ops/fbi-session-worker,
-- 2026-10-07). Le worker (VPS) n'a AUCUNE clé Supabase sensible : il insère
-- avec la clé publique (anon) + un jeton propre au worker (en-tête
-- `x-probe-token`), dont seule l'empreinte SHA-256 est stockée ici.
-- Insertion seule (RLS : une seule politique, INSERT pour anon avec jeton
-- valide) — aucune lecture, modification ni suppression. Vérifié le 07/10 :
-- bon jeton accepté, mauvais jeton refusé, 0 ligne lisible par anon.

create table if not exists public.fbi_probe_tokens (
  worker_id text primary key,
  token_sha256 text not null,
  created_at timestamptz not null default now()
);
alter table public.fbi_probe_tokens enable row level security;

create table if not exists public.fbi_probe_events (
  id uuid primary key default gen_random_uuid(),
  worker_id text not null,
  at timestamptz not null,
  received_at timestamptz not null default now(),
  kind text not null check (length(kind) <= 64),
  outcome text not null check (length(outcome) <= 128),
  elapsed_ms integer,
  state text check (length(state) <= 32),
  detail jsonb not null default '{}'::jsonb check (pg_column_size(detail) <= 16000)
);
create index if not exists fbi_probe_events_worker_at on public.fbi_probe_events (worker_id, at desc);
alter table public.fbi_probe_events enable row level security;

create or replace function public.fbi_probe_token_valid(p_worker_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.fbi_probe_tokens t
    where t.worker_id = p_worker_id
      and t.token_sha256 = encode(sha256(convert_to(coalesce(current_setting('request.headers', true)::json ->> 'x-probe-token', ''), 'UTF8')), 'hex')
  );
$$;

create policy fbi_probe_events_insert_with_token on public.fbi_probe_events
  for insert to anon
  with check (public.fbi_probe_token_valid(worker_id));
