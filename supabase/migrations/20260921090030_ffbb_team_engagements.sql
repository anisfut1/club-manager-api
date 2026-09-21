-- Lien entre une équipe interne (public.teams) et son engagement FFBB pour
-- une saison donnée. Une équipe interne peut avoir plusieurs engagements au
-- fil des saisons ; un engagement FFBB correspond toujours à une seule
-- équipe interne (résolue automatiquement par le service de synchronisation
-- à partir du nom/numéro d'équipe, ou créée si aucune ne correspond).
create table public.ffbb_team_engagements (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  ffbb_engagement_id text not null unique,
  competition_id uuid not null references public.competitions (id) on delete cascade,
  pool_id uuid references public.pools (id) on delete set null,
  season text,
  name text,
  numero_equipe text,
  raw_ffbb_payload jsonb,
  ffbb_last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ffbb_team_engagements is
  'Engagement FFBB d''une équipe interne dans une compétition/poule pour une saison. Écriture exclusive du service de synchronisation.';

create index ffbb_team_engagements_team_id_idx on public.ffbb_team_engagements (team_id);
create index ffbb_team_engagements_competition_id_idx on public.ffbb_team_engagements (competition_id);
