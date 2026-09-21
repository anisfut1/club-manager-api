-- Équipes internes du club (ex: "SM2", "U13F"). Distinctes des engagements
-- FFBB (ffbb_team_engagements, migration suivante) : une équipe interne
-- existe même avant tout engagement FFBB connu, et regroupe l'historique
-- d'une équipe à travers les saisons.
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.club (id) on delete restrict,
  name text not null,
  category text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.teams is
  'Équipe interne du club (ex: SM2, U13F). Le lien avec les engagements FFBB se fait via ffbb_team_engagements.';

create index teams_club_id_idx on public.teams (club_id);

-- Complète user_roles (Phase 0) : le scope d'un rôle (ex: coach limité à une
-- équipe) était différé faute de table `teams`. Elle existe maintenant.
alter table public.user_roles
  add column scope_team_id uuid references public.teams (id) on delete cascade;

comment on column public.user_roles.scope_team_id is
  'Portée optionnelle du rôle (ex: coach limité à cette équipe). NULL = portée globale.';
