-- Vie d'équipe : présence RÉELLE à un entraînement passé (retour du club,
-- 2026-10-10 : « voir les 2 derniers entraînements pour pouvoir mettre
-- absent, ou retard ceux qui sont arrivés en retard ou pas venus »).
-- Distinct de training_responses (ce que la famille a PRÉVU). Relevée par le
-- coach de l'équipe / un admin, une fois la séance commencée. Pas de ligne =
-- présent (le coach ne marque que les absents et les retards).
create table public.training_attendance (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  occurrence_id uuid not null references public.training_occurrences (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  status text not null check (status in ('PRESENT', 'LATE', 'ABSENT')),
  marked_at timestamptz not null default now(),
  marked_by_user_id uuid references auth.users (id) on delete set null,
  marked_by_licencie_id uuid references public.licencies (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (occurrence_id, licencie_id)
);
create index training_attendance_club_occurrence on public.training_attendance (club_id, occurrence_id);
alter table public.training_attendance enable row level security;
