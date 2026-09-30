-- =============================================================================
-- Régression trouvée en production le 2026-09-30 (retour du club : "jai laissé
-- tourner la nuit et jai tjr pas les stats sur les matchs joués", malgré 48
-- exécutions "success" du relai GitHub Actions toutes les 15 min) : la
-- migration 20260927020000_fbi_jobs_priority_by_type.sql a recréé
-- claim_next_fbi_job/claim_next_fbi_job_for_club à partir d'une version
-- ANTÉRIEURE à 20260924140000_fbi_jobs_claim_stale_recovery.sql — la clause
-- `and claimed_at > now() - interval '10 minutes'` de la garde anti-blocage a
-- disparu SANS QUE PERSONNE NE LE REMARQUE, le diff de 20260927020000 se
-- concentrant sur le nouvel ORDER BY.
--
-- Conséquence, constatée en base ce matin : un job reconcile_schedule resté
-- en status='claimed' depuis 2026-09-30 01:30:34 (très probablement tué par
-- un timeout Vercel, comme documenté dans 20260924140000) bloque TOUTE
-- réclamation pour ce club depuis 6h+ — 37 jobs discover_emarque et 1
-- check_all_derogations restent `pending`, jamais réclamés (`claimed_at`
-- toujours null), quel que soit le nombre d'exécutions du cron.
--
-- Fix : recombine les DEUX correctifs qui n'auraient jamais dû être perdus
-- l'un pour l'autre — priorité de TYPE (20260927020000) ET garde de
-- fraîcheur 10 minutes sur le job actif bloquant (20260924140000). Toute
-- future migration touchant ces fonctions doit repartir de CETTE version,
-- pas d'une version antérieure au 2026-09-24.
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
  order by (case when type = 'discover_emarque' then 1 else 0 end), scheduled_at
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
  order by (case when type = 'discover_emarque' then 1 else 0 end), scheduled_at
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
  'Réclame atomiquement le prochain job FBI éligible (FOR UPDATE SKIP LOCKED), priorité de TYPE (tout sauf discover_emarque avant discover_emarque) puis FIFO par scheduled_at, en excluant les clubs ayant déjà un job actif RÉCENT (< 10 min — un job claimed/running plus vieux a forcément été tué par un timeout, voir migrations 20260924140000 et 20260930080000). Appelée uniquement par le worker (service role) via son propre client Postgres — jamais exposée à un rôle authenticated.';

comment on function public.claim_next_fbi_job_for_club(uuid, text) is
  'Comme claim_next_fbi_job, mais filtré à UN club — utilisée par POST /v1/clubs/:clubId/integrations/fbi/process-jobs (service role, après vérification club_admin par la route), jamais exposée directement à authenticated. Même garde de fraîcheur (< 10 min) sur le job actif bloquant, voir migrations 20260924140000 et 20260930080000.';
