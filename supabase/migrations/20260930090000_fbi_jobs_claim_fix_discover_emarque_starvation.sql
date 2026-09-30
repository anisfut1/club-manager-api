-- =============================================================================
-- Famine constatée en production le 2026-09-30, juste après la correction de
-- la régression sur la garde de fraîcheur 10 min (migration 20260930080000) :
-- retour du club "jai laissé tourner la nuit et jai tjr pas les stats sur
-- les matchs joués" persistait — 39 jobs discover_emarque toujours `pending`,
-- `claimed_at IS NULL`, alors que la file se débloquait bien (vérifié :
-- plusieurs check_all_derogations/reconcile_schedule réclamés et terminés
-- avec succès dans la même fenêtre).
--
-- Cause : `/internal/cron/fbi-enqueue` (appelé toutes les ~15-20 min par le
-- relai GitHub Actions, voir fbi-frequent-sync.yml) ré-empile UN job
-- reconcile_schedule ET UN job check_all_derogations à CHAQUE passage où le
-- précédent de ce type a déjà terminé (la contrainte unique de fbi_jobs
-- n'empêche qu'un doublon PENDANT qu'un job du même type est encore actif,
-- jamais une ré-création après succès). Comme `claim_next_fbi_job(_for_club)`
-- priorise STRICTEMENT tout type autre que discover_emarque (migration
-- 20260927020000), et que `/internal/cron/fbi-jobs` ne traite qu'UN SEUL job
-- par invocation (`JOB_BATCH_SIZE = 1`, volontairement petit pour rester
-- sous `maxDuration: 300` — un seul check_all_derogations peut à lui seul
-- consommer 4-5 min), le job fraîchement recréé à chaque cycle gagne
-- TOUJOURS face au backlog discover_emarque, quel que soit son âge. Famine
-- permanente, symétrique de celle documentée dans 20260927020000 (qui
-- empêchait l'inverse : un clic manuel de vérification bloqué derrière un
-- backlog discover_emarque).
--
-- Fix : la priorité de type ne s'applique plus qu'aux jobs discover_emarque
-- RÉCENTS (< 30 min) — au-delà, un discover_emarque redevient éligible au
-- même rang que n'importe quel autre type, et son ancienneté (FIFO par
-- scheduled_at) lui permet alors de passer devant une vérification qui vient
-- d'être recréée. Un clic manuel de vérification (le cas que 20260927020000
-- voulait résoudre) reste prioritaire sur un backlog discover_emarque
-- récent, mais un backlog qui traîne depuis plus de 30 min n'est plus
-- indéfiniment repoussé.
-- =============================================================================

create or replace function public.claim_next_fbi_job(p_worker_id text)
returns public.fbi_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_job public.fbi_jobs;
begin
  select * into claimed_job
  from public.fbi_jobs
  where status = 'pending'
    and scheduled_at <= now()
    and club_id not in (
      select club_id from public.fbi_jobs
      where status in ('claimed', 'running')
        and claimed_at > now() - interval '10 minutes'
    )
  order by
    (case when type = 'discover_emarque' and scheduled_at > now() - interval '30 minutes' then 1 else 0 end),
    scheduled_at
  limit 1
  for update skip locked;

  if claimed_job.id is null then
    return null;
  end if;

  update public.fbi_jobs
  set status = 'claimed', claimed_at = now(), claimed_by = p_worker_id, attempt_count = attempt_count + 1
  where id = claimed_job.id
  returning * into claimed_job;

  return claimed_job;
end;
$$;

create or replace function public.claim_next_fbi_job_for_club(p_club_id uuid, p_worker_id text)
returns public.fbi_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_job public.fbi_jobs;
begin
  select * into claimed_job
  from public.fbi_jobs
  where status = 'pending'
    and scheduled_at <= now()
    and club_id = p_club_id
    and club_id not in (
      select club_id from public.fbi_jobs
      where status in ('claimed', 'running')
        and claimed_at > now() - interval '10 minutes'
    )
  order by
    (case when type = 'discover_emarque' and scheduled_at > now() - interval '30 minutes' then 1 else 0 end),
    scheduled_at
  limit 1
  for update skip locked;

  if claimed_job.id is null then
    return null;
  end if;

  update public.fbi_jobs
  set status = 'claimed', claimed_at = now(), claimed_by = p_worker_id, attempt_count = attempt_count + 1
  where id = claimed_job.id
  returning * into claimed_job;

  return claimed_job;
end;
$$;

comment on function public.claim_next_fbi_job(text) is
  'Réclame atomiquement le prochain job FBI éligible (FOR UPDATE SKIP LOCKED). Priorité : tout type autre que discover_emarque, PUIS un discover_emarque de plus de 30 min (évite la famine, voir 20260930090000), PUIS un discover_emarque récent — FIFO par scheduled_at au sein de chaque groupe. Exclut les clubs ayant déjà un job actif RÉCENT (< 10 min, voir 20260924140000/20260930080000). Appelée uniquement par le worker (service role) via son propre client Postgres — jamais exposée à un rôle authenticated.';

comment on function public.claim_next_fbi_job_for_club(uuid, text) is
  'Comme claim_next_fbi_job, mais filtré à UN club — utilisée par POST /v1/clubs/:clubId/integrations/fbi/process-jobs (service role, après vérification club_admin par la route), jamais exposée directement à authenticated. Même ordre de priorité et même garde de fraîcheur, voir 20260924140000/20260927020000/20260930080000/20260930090000.';
