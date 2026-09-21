-- Référentiel club : une seule ligne pour le SC Sète Basket.
-- Ce n'est PAS une table alimentée par la synchronisation FFBB (Phase 1) : elle sert
-- de point d'ancrage stable (club_id) pour les données internes (licenciés, équipes...).
create table public.club (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ffbb_club_id text not null unique,
  created_at timestamptz not null default now()
);

comment on table public.club is
  'Club (référentiel interne). Une seule ligne attendue pour le SC Sète Basket.';
comment on column public.club.ffbb_club_id is
  'Identifiant du club côté FFBB (ex: OCC0034008). Référence uniquement : aucune synchronisation FFBB en Phase 0.';

insert into public.club (name, ffbb_club_id)
values ('SC Sète Basket', 'OCC0034008')
on conflict (ffbb_club_id) do nothing;
