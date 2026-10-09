-- Vie d'équipe — Lot 3 : lavage des maillots (retour du club, 2026-10-09).
-- SEULE tâche gérée (pas de gestionnaire de tâches générique). Matchs
-- officiels uniquement. Même philosophie que les tables de marque : le
-- logiciel SUGGÈRE (équité : moins de lavages cette saison d'abord), le
-- COACH DÉCIDE — aucune affectation automatique. Une affectation par match
-- et par équipe ; `seen_at` = « J'ai vu » (pas de workflow lavé / rendu).
create table public.match_laundry_assignments (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by_user_id uuid references auth.users (id) on delete set null,
  assigned_by_licencie_id uuid references public.licencies (id) on delete set null,
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, team_id)
);
create index match_laundry_assignments_club_licencie on public.match_laundry_assignments (club_id, licencie_id);
alter table public.match_laundry_assignments enable row level security;
