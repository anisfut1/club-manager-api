-- Couche FFBB (écriture exclusive du service de synchronisation, voir
-- ARCHITECTURE.md §4/§8). Tous les identifiants externes sont stockés en
-- `text` : ce sont des id Directus (voir docs/FFBB_ECOSYSTEM_RESEARCH.md
-- §3), pas des types internes — les traiter comme opaques évite tout souci
-- de débordement/format si l'API change.
create table public.competitions (
  id uuid primary key default gen_random_uuid(),
  ffbb_competition_id text not null unique,
  name text not null,
  code text,
  sexe text,
  type_competition text,
  category_code text,
  category_label text,
  phase_code text,
  live_stat boolean not null default false,
  emarque_v2 boolean not null default false,
  publication_internet boolean not null default true,
  season text,
  parent_ffbb_competition_id text,
  raw_ffbb_payload jsonb,
  ffbb_last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.competitions is
  'Compétitions FFBB (référentiel). Écrite uniquement par le service de synchronisation.';
comment on column public.competitions.live_stat is
  'Reflète competitions.liveStat côté FFBB : indique si des statistiques avancées existent pour cette compétition (voir docs/FFBB_ECOSYSTEM_RESEARCH.md §7).';
comment on column public.competitions.emarque_v2 is
  'Reflète competitions.emarqueV2 côté FFBB : la compétition utilise-t-elle la feuille de marque électronique.';
comment on column public.competitions.parent_ffbb_competition_id is
  'competitionId de la compétition parente côté FFBB (compétition_origine), résolue en interne au besoin. Pas de FK stricte : la compétition parente peut ne pas encore être synchronisée.';

create index competitions_parent_idx on public.competitions (parent_ffbb_competition_id);

create table public.pools (
  id uuid primary key default gen_random_uuid(),
  ffbb_pool_id text not null unique,
  competition_id uuid not null references public.competitions (id) on delete cascade,
  name text not null,
  raw_ffbb_payload jsonb,
  ffbb_last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.pools is
  'Poules FFBB (référentiel). Écrite uniquement par le service de synchronisation.';

create index pools_competition_id_idx on public.pools (competition_id);
