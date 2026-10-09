-- Vie d'équipe — Lot 2 : disponibilités des matchs et convocations (retour du
-- club, 2026-10-09). Voir docs/TEAM_LIFE.md.
--
-- Trois notions DISTINCTES (règle métier) :
--   DISPONIBLE : « je peux venir »          → match_availability_responses
--   CONVOQUÉ   : « le coach m'a choisi »     → match_convocation_recipients
--   CONFIRMÉ   : « je confirme ma venue »    → recipients.response
--
-- Les matchs restent la source FFBB (`matches`) : rien n'est recopié ici,
-- sauf la PHOTO de ce qui a été envoyé (match_snapshot, dispatches) pour
-- qu'une modification FFBB ne change jamais en silence ce qu'un parent a lu.
-- Accès uniquement par l'API (rôle service) : RLS activée sans policy.

-- Le coach « demande les disponibilités » d'un match pour son équipe.
create table public.match_availability_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  opened_at timestamptz not null default now(),
  opened_by_user_id uuid references auth.users (id) on delete set null,
  opened_by_licencie_id uuid references public.licencies (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (match_id, team_id)
);
create index match_availability_requests_club on public.match_availability_requests (club_id, team_id);

create table public.match_availability_responses (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  request_id uuid not null references public.match_availability_requests (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  response text not null check (response in ('AVAILABLE', 'UNAVAILABLE', 'UNCERTAIN')),
  responded_at timestamptz not null default now(),
  responded_by_user_id uuid references auth.users (id) on delete set null,
  responded_by_licencie_id uuid references public.licencies (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, licencie_id)
);

-- Une convocation par match et par équipe. Deux jeux de champs :
--   draft_*  : ce que le coach prépare (jamais visible des familles) ;
--   le reste : ce qui a été ENVOYÉ (revision > 0), seul visible des familles.
create table public.match_convocations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  -- Brouillon
  draft_licencie_ids uuid[] not null default '{}',
  draft_meeting_at timestamptz,
  draft_meeting_point text,
  draft_meeting_venue_id uuid references public.club_venues (id) on delete set null,
  draft_coach_message text,
  -- Envoyé
  revision integer not null default 0,
  meeting_at timestamptz,
  meeting_point text,
  meeting_venue_id uuid references public.club_venues (id) on delete set null,
  coach_message text,
  -- Photo du match au moment de l'envoi : { startsAt, isHome, opponent, venueName, venueAddress, teamName }
  match_snapshot jsonb,
  sent_at timestamptz,
  sent_by_user_id uuid references auth.users (id) on delete set null,
  sent_by_licencie_id uuid references public.licencies (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, team_id),
  check (draft_coach_message is null or length(draft_coach_message) <= 1000),
  check (coach_message is null or length(coach_message) <= 1000)
);
create index match_convocations_club_team on public.match_convocations (club_id, team_id);

create table public.match_convocation_recipients (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  convocation_id uuid not null references public.match_convocations (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  response text not null default 'PENDING' check (response in ('PENDING', 'CONFIRMED', 'DECLINED')),
  responded_at timestamptz,
  responded_by_user_id uuid references auth.users (id) on delete set null,
  responded_by_licencie_id uuid references public.licencies (id) on delete set null,
  -- Retiré de la sélection lors d'une mise à jour (gardé pour l'historique).
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (convocation_id, licencie_id)
);
create index match_convocation_recipients_licencie on public.match_convocation_recipients (club_id, licencie_id);

-- Historique : le message réellement envoyé à chacun, à chaque révision.
create table public.match_convocation_dispatches (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  convocation_id uuid not null references public.match_convocations (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  revision integer not null,
  rendered_message text not null,
  sent_at timestamptz not null default now(),
  unique (convocation_id, licencie_id, revision)
);

alter table public.match_availability_requests enable row level security;
alter table public.match_availability_responses enable row level security;
alter table public.match_convocations enable row level security;
alter table public.match_convocation_recipients enable row level security;
alter table public.match_convocation_dispatches enable row level security;
