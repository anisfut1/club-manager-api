-- Matchs (couche FFBB — écriture exclusive du service de synchronisation).
-- `ffbb_match_id` (id Directus de la rencontre) est la clé d'UPSERT : c'est
-- le candidat le plus fiable identifié dans docs/FFBB_ECOSYSTEM_RESEARCH.md
-- §6 pour un identifiant stable côté API publique. `numero` (le "Rencontre
-- N°" imprimé sur les documents e-Marque, ex: 2813) sert lui de clé de
-- rapprochement avec FBI/e-Marque (voir docs, même section) : les deux
-- identifiants sont conservés, avec des usages différents.
create table public.matches (
  id uuid primary key default gen_random_uuid(),
  ffbb_match_id text not null unique,
  ffbb_unique_key text,
  ffbb_gs_id text,
  numero text,
  team_id uuid references public.teams (id) on delete set null,
  competition_id uuid references public.competitions (id) on delete set null,
  pool_id uuid references public.pools (id) on delete set null,
  journee text,
  match_datetime timestamptz,
  is_home boolean,
  opponent_name text,
  opponent_ffbb_organisme_id text,
  venue_id uuid references public.venues (id) on delete set null,
  venue_raw_label text,
  score_home integer,
  score_away integer,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'played', 'postponed', 'cancelled', 'forfeit')),
  emarque_status text not null default 'not_applicable'
    check (emarque_status in ('not_applicable', 'pending', 'waiting_for_emarque', 'imported', 'error', 'needs_review')),
  raw_ffbb_payload jsonb,
  ffbb_last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.matches is
  'Matchs du club (couche FFBB). Écriture exclusive du service de synchronisation FFBB pour les colonnes FFBB ; emarque_status est géré par le pipeline e-Marque (voir src/server/emarque).';
comment on column public.matches.numero is
  'Numéro de rencontre FFBB (ex: 2813), imprimé sur les documents e-Marque. Candidat principal pour le rapprochement avec FBI (voir docs/FFBB_ECOSYSTEM_RESEARCH.md §6).';
comment on column public.matches.emarque_status is
  'not_applicable: pas concerné (match à venir, ou extérieur sans document club) ; pending: joué, en attente de traitement ; waiting_for_emarque: aucun document trouvé pour l''instant chez FBI (retry) ; imported: import e-Marque réussi ; error/needs_review: intervention admin nécessaire (voir /admin/issues).';

create index matches_team_id_idx on public.matches (team_id);
create index matches_competition_id_idx on public.matches (competition_id);
create index matches_match_datetime_idx on public.matches (match_datetime);
create index matches_numero_idx on public.matches (numero);
create index matches_emarque_candidates_idx on public.matches (status, emarque_status)
  where status = 'played' and emarque_status in ('pending', 'waiting_for_emarque');
