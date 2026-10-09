-- Vie d'équipe — Lot 1 : entraînements (retour du club, 2026-10-09 : « les
-- coachs doivent pouvoir PLANIFIER leurs entraînements directement dans
-- l'application… joueurs/parents répondent Présent / Absent / Incertain »).
-- Voir docs/TEAM_LIFE.md.
--
-- training_series      : un créneau récurrent (jour, horaires, lieu, période).
-- training_occurrences : les séances réelles, générées à partir de la série.
--                        Modifier ou annuler UNE séance ne touche jamais la
--                        série ; une séance annulée reste visible (jamais
--                        supprimée en silence).
-- training_responses   : Présent / Absent / Incertain par licencié et séance.
--
-- Matchs officiels : jamais ici (ils restent dans `matches`, source FFBB).
-- Accès uniquement par l'API (rôle service, après contrôle club/équipe/lien
-- personnel) : RLS activée sans policy.

create table public.training_series (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  -- 0 = dimanche … 6 = samedi (même convention que JavaScript `getDay`).
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  club_venue_id uuid references public.club_venues (id) on delete set null,
  location_label text,
  starts_on date not null,
  ends_on date not null,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_by_licencie_id uuid references public.licencies (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time),
  check (ends_on >= starts_on),
  check (ends_on - starts_on <= 400)
);
create index training_series_club_team on public.training_series (club_id, team_id);

create table public.training_occurrences (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  series_id uuid references public.training_series (id) on delete set null,
  -- Date prévue par la série (clé de rapprochement, même si la séance est déplacée).
  series_date date,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  club_venue_id uuid references public.club_venues (id) on delete set null,
  location_label text,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  cancel_reason text,
  -- Modifiée individuellement : jamais écrasée par une modification de la série.
  is_modified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (series_id, series_date)
);
create index training_occurrences_club_team_start on public.training_occurrences (club_id, team_id, starts_at);

create table public.training_responses (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  occurrence_id uuid not null references public.training_occurrences (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  response text not null check (response in ('PRESENT', 'ABSENT', 'UNCERTAIN')),
  responded_at timestamptz not null default now(),
  -- Qui a répondu : compte connecté, ou lien personnel (licencié du lien).
  responded_by_user_id uuid references auth.users (id) on delete set null,
  responded_by_licencie_id uuid references public.licencies (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (occurrence_id, licencie_id)
);
create index training_responses_club_licencie on public.training_responses (club_id, licencie_id);

alter table public.training_series enable row level security;
alter table public.training_occurrences enable row level security;
alter table public.training_responses enable row level security;

comment on table public.training_series is 'Créneau d''entraînement récurrent d''une équipe (jour, horaires, lieu, période). Voir docs/TEAM_LIFE.md.';
comment on table public.training_occurrences is 'Séance d''entraînement (générée par une série ou modifiée individuellement). Annulée = status cancelled, jamais supprimée.';
comment on table public.training_responses is 'Réponse Présent / Absent / Incertain d''un licencié à une séance.';
