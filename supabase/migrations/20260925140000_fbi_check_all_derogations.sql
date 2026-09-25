-- =============================================================================
-- "je veux un bouton global qui check toutes les demandes, pas match par
-- match" (2026-09-25) — la première version (check_derogation) était
-- scopée à UN match à la fois, ce qui aurait nécessité une connexion FBI
-- PAR MATCH pour tout vérifier (rythme déjà à l'origine d'un blocage
-- anti-bot par le passé, voir ProcessFbiJobsButton.tsx côté SCSB).
-- check_all_derogations fait UNE SEULE recherche non filtrée (numéro
-- vide) sur rechercherDerogation.fbi, comme reconcile_schedule le fait
-- déjà pour le calendrier — une seule connexion FBI pour tout le club.
-- =============================================================================

alter table public.fbi_jobs drop constraint fbi_jobs_type_check;
alter table public.fbi_jobs add constraint fbi_jobs_type_check
  check (type in ('test_connection', 'discover_emarque', 'reconcile_schedule', 'check_derogation', 'check_all_derogations'));

comment on column public.fbi_jobs.match_id is
  'NULL pour un job test_connection, reconcile_schedule ou check_all_derogations (pas de match unique concerné). Obligatoire pour discover_emarque et check_derogation.';

-- Empêche d'empiler deux fois le même job "check_all_derogations" en
-- attente pour le même club — même logique que
-- fbi_jobs_unique_pending_reconcile_schedule.
create unique index fbi_jobs_unique_pending_all_derogations
  on public.fbi_jobs (club_id)
  where type = 'check_all_derogations' and status in ('pending', 'claimed', 'running');
