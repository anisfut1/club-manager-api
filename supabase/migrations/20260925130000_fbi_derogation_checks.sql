-- =============================================================================
-- Consultation en LECTURE SEULE de l'état d'une dérogation FBI par match
-- (demande du club, 2026-09-25 : "faut qu'on gere les derog depuis
-- l'outil"). Portée v1 volontairement limitée à la LECTURE (voir
-- l'échange avec le club) : cette table journalise l'état déjà connu par
-- FBI pour un match donné (écran "Compétitions > Dérogations",
-- rechercherDerogation.fbi), jamais une écriture/soumission de demande —
-- ça, c'est une phase future, plus risquée (envoie une vraie demande au
-- club adverse), volontairement pas construite maintenant.
-- =============================================================================

alter table public.fbi_jobs drop constraint fbi_jobs_type_check;
alter table public.fbi_jobs add constraint fbi_jobs_type_check
  check (type in ('test_connection', 'discover_emarque', 'reconcile_schedule', 'check_derogation'));

comment on column public.fbi_jobs.match_id is
  'NULL pour un job test_connection ou reconcile_schedule (pas de match unique concerné). Obligatoire pour discover_emarque et check_derogation.';

-- Empêche d'empiler deux fois le même job "check_derogation" en attente
-- pour le même match — même logique que fbi_jobs_unique_pending_discovery.
create unique index fbi_jobs_unique_pending_derogation_check
  on public.fbi_jobs (club_id, match_id)
  where type = 'check_derogation' and status in ('pending', 'claimed', 'running');

-- -----------------------------------------------------------------------------
-- Un seul résultat CONNU par match (la ligne est mise à jour à chaque
-- vérification, jamais accumulée en historique — voir `checked_at`).
-- Toutes les colonnes texte conservent le format BRUT FBI (ex: dates
-- "26/09/2026", jamais parsées en `date`/`timestamptz` — le format exact
-- pour chaque état n'a été observé QUE sur une capture d'écran du club,
-- pas confirmé pour tous les cas).
create table public.fbi_derogation_checks (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  numero text,
  etat text,
  date_depot text,
  date_derogation text,
  date_rencontre text,
  heure text,
  domicile text,
  visiteur text,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, match_id)
);

comment on table public.fbi_derogation_checks is
  'Dernier état CONNU (via FBI, rechercherDerogation.fbi) de la dérogation d''un match, pour les clubs ayant FBI configuré. LECTURE SEULE : jamais d''écriture/soumission de demande depuis cette table ni depuis club-manager-api pour l''instant (voir docs/FBI.md).';

create index fbi_derogation_checks_club_id_idx on public.fbi_derogation_checks (club_id);

alter table public.fbi_derogation_checks enable row level security;

create policy "fbi_derogation_checks_select_club_admin" on public.fbi_derogation_checks for select to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());
