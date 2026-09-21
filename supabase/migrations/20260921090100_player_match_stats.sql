-- Statistiques individuelles extraites du document "résumé" e-Marque.
-- Chaque colonne est nullable et DOIT le rester en l'absence de donnée
-- (null != 0, voir ARCHITECTURE.md §22) : ne jamais transformer une case
-- vide/illisible en zéro dans le parser.
create table public.player_match_stats (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  participant_id uuid not null unique references public.match_participants (id) on delete cascade,
  seconds_played integer,
  points integer,
  shots_made integer,
  three_points_made integer,
  two_points_interior_made integer,
  two_points_exterior_made integer,
  free_throws_made integer,
  fouls_committed integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.player_match_stats is
  'Statistiques individuelles par match (document "résumé" e-Marque). Une ligne par participant, 1-1 avec match_participants.';
comment on column public.player_match_stats.shots_made is
  'Nombre total de tirs RÉUSSIS (3pts + 2pts intérieur + 2pts extérieur). Le document e-Marque ne fournit pas les tentatives : aucun pourcentage de réussite n''est calculable à partir de cette seule feuille.';

create index player_match_stats_match_id_idx on public.player_match_stats (match_id);

-- Schéma préparé pour un futur enrichissement (positions de tirs), non
-- peuplé en V1 : l'extraction du document "positiontir" est purement
-- graphique (voir docs/FFBB_ECOSYSTEM_RESEARCH.md) et jugée expérimentale,
-- volontairement non implémentée pour ne pas bloquer l'import principal
-- (ARCHITECTURE.md §23).
create table public.shot_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  participant_id uuid references public.match_participants (id) on delete set null,
  team_side text not null check (team_side in ('home', 'away')),
  period integer,
  made boolean not null,
  shot_type text,
  x numeric,
  y numeric,
  created_at timestamptz not null default now()
);

comment on table public.shot_events is
  'EXPÉRIMENTAL — schéma préparé, non peuplé en V1 (extraction positiontir non implémentée, voir ARCHITECTURE.md §23).';

create index shot_events_match_id_idx on public.shot_events (match_id);
