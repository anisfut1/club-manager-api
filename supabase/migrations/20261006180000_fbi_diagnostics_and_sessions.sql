-- Diagnostic et ménagement de l'accès FBI (2026-10-06) : FBI coupe par
-- moments l'adresse utilisée (Vercel, puis le VPS du proxy). Trois tables,
-- service_role UNIQUEMENT (RLS activée, aucune policy).

-- 1. Joignabilité de FBI vérifiée avant chaque passage (une requête légère,
--    sans connexion) : historique pour mesurer la durée des coupures.
create table if not exists public.fbi_reachability_checks (
  id bigserial primary key,
  checked_at timestamptz not null default now(),
  via text not null check (via in ('proxy', 'direct')),
  ok boolean not null,
  http_status integer,
  elapsed_ms integer not null,
  error text
);
create index if not exists fbi_reachability_checks_checked_at_idx on public.fbi_reachability_checks (checked_at desc);

-- 2. Trace de chaque session navigateur FBI : chaque requête (chemin sans
--    paramètres, type, statut ou erreur, durée). Jamais de corps, cookie,
--    identifiant ni paramètre d'URL.
create table if not exists public.fbi_session_traces (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  via text not null check (via in ('proxy', 'direct')),
  outcome text not null,
  request_count integer not null,
  failed_count integer not null,
  events jsonb not null
);
create index if not exists fbi_session_traces_started_at_idx on public.fbi_session_traces (started_at desc);

-- 3. Session FBI conservée d'un passage à l'autre (cookies chiffrés AES-256-GCM,
--    club_id en AAD) : une connexion par jour au lieu d'une par passage.
create table if not exists public.fbi_saved_sessions (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  state_ciphertext text not null,
  state_iv text not null,
  state_auth_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fbi_reachability_checks enable row level security;
alter table public.fbi_session_traces enable row level security;
alter table public.fbi_saved_sessions enable row level security;
revoke all on table public.fbi_reachability_checks, public.fbi_session_traces, public.fbi_saved_sessions from anon, authenticated;
revoke all on sequence public.fbi_reachability_checks_id_seq from anon, authenticated;
