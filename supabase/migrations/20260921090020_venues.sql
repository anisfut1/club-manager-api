-- Salles. Alimentée par les champs imbriqués (`salle.*`) des rencontres
-- FFBB (voir docs/FFBB_ECOSYSTEM_RESEARCH.md §3.4) plutôt que par une
-- synchronisation séparée de la collection ffbbserver_salles : plus simple,
-- et suffisant pour le besoin (afficher le lieu d'un match).
create table public.venues (
  id uuid primary key default gen_random_uuid(),
  ffbb_venue_id text unique,
  name text,
  commune text,
  raw_ffbb_payload jsonb,
  ffbb_last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.venues is
  'Salles (référentiel). Alimentée par les champs imbriqués des rencontres FFBB, écriture exclusive du service de synchronisation.';
