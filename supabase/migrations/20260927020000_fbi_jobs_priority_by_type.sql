-- =============================================================================
-- Priorité par TYPE de job dans le claim — corrige une famine constatée en
-- production le 2026-09-27 (rencontre 15, "j'ai fait la verif manuelle...
-- jai tjr pas les motifs", "si on peut les avoir sur les autres on peut sur
-- celui la") : `claim_next_fbi_job`/`claim_next_fbi_job_for_club` ne
-- triaient QUE par `scheduled_at` (le plus ancien d'abord), tous types
-- confondus. Le cron quotidien `discover_emarque` (vercel.json, 03:18 UTC)
-- empile ~80 jobs d'un coup ; chacun, quand FBI n'a pas encore de document à
-- proposer, se REPLANIFIE (`nextErrorBackoffSeconds`) au lieu d'échouer —
-- constaté en base : ce backlog reste `pending` toute la journée et redevient
-- ELIGIBLE (`scheduled_at <= now()`) bien avant qu'un admin ne clique quoi
-- que ce soit.
--
-- Conséquence directe (confirmée par les `fbi_jobs` du club le 2026-09-27,
-- claimed_by "admin-app#...#<timestamp>") : CHAQUE clic sur "Vérifier sur
-- FBI" / "Vérifier toutes les dérogations" (qui appelle `.../fbi/process-jobs`,
-- `CLUB_JOB_BATCH_SIZE = 1`, UN SEUL job traité par appel) réclamait en fait
-- le PROCHAIN `discover_emarque` du backlog (son `scheduled_at`, même après
-- plusieurs replanifications, restant plus ancien que celui d'un job de
-- vérification tout juste créé) — jamais le job de dérogation que le club
-- venait de demander. Trois jobs de dérogation (2 x check_derogation, 1 x
-- check_all_derogations) sont ainsi restés `pending`, `attempt_count = 0`,
-- TOUTE LA JOURNÉE, pendant qu'une dizaine de `discover_emarque` étaient
-- réclamés/replanifiés à leur place au fil des clics du club sur d'autres
-- boutons (dont "Traiter les jobs FBI en attente", pensé pour l'e-Marque).
--
-- Fix : un ORDER BY à deux niveaux — priorité de TYPE d'abord (une action
-- explicitement déclenchée par un admin qui ATTEND un résultat passe avant
-- une redécouverte e-Marque en tâche de fond, jamais l'inverse), FIFO par
-- `scheduled_at` ENSUITE au sein d'un même niveau. Ne change ni le verrou
-- "un seul job actif par club" ni la logique de replanification de
-- `discover_emarque` — uniquement l'ORDRE de réclamation.
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
      select club_id from public.fbi_jobs where status in ('claimed', 'running')
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
      select club_id from public.fbi_jobs where status in ('claimed', 'running')
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
  'Réclame atomiquement le prochain job FBI éligible (FOR UPDATE SKIP LOCKED), priorité de TYPE (tout sauf discover_emarque avant discover_emarque) puis FIFO par scheduled_at, en excluant les clubs ayant déjà un job actif. Appelée uniquement par le worker (service role) via son propre client Postgres — jamais exposée à un rôle authenticated.';

comment on function public.claim_next_fbi_job_for_club(uuid, text) is
  'Comme claim_next_fbi_job, mais filtré à UN club — utilisée par POST /v1/clubs/:clubId/integrations/fbi/process-jobs (service role, après vérification club_admin par la route), jamais exposée directement à authenticated.';
