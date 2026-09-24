-- =============================================================================
-- Auto-guérison d'un job FBI bloqué en `claimed`/`running` — constaté en
-- production le 2026-09-24 (§ "Vingt-deuxième déclenchement", docs/FBI.md) :
-- le tout premier succès de bout en bout (rencontre n°1481) a pris ~3min30
-- contre le vrai FBI (login + navigation + recherche + téléchargements réels,
-- bien plus lent que les fixtures locales). Un lot de plusieurs jobs dans la
-- même invocation peut dépasser `maxDuration: 300` (vercel.json) : Vercel tue
-- alors le process EN PLEIN TRAITEMENT d'un job suivant, avant que son
-- `finally` (browser-client.ts) ne s'exécute — le job reste bloqué en
-- `status = 'claimed'` indéfiniment (`started_at`/`finished_at` jamais posés,
-- aucune exception à gérer côté applicatif : le process entier disparaît).
--
-- La contrainte "un seul job actif par club" (`club_id not in (select club_id
-- from fbi_jobs where status in ('claimed','running'))`) bloquait alors TOUTE
-- réclamation future pour ce club, sans limite de temps — nécessitant une
-- intervention manuelle en base pour débloquer (fait une première fois par
-- SQL direct le 2026-09-24, jamais automatisé jusqu'ici).
--
-- Corrigé : la garde "un seul job actif" n'exclut désormais que les jobs
-- `claimed`/`running` dont `claimed_at` est RÉCENT (< 10 minutes) — largement
-- au-dessus du temps constaté pour un job réel (~3min30) et de
-- `maxDuration: 300` (5 min) lui-même. Un job plus vieux que ça a forcément
-- été tué par un timeout (ou un crash) : il ne bloque plus la file, un
-- nouveau job pour ce club peut être réclamé. Le job fantôme lui-même reste
-- en `claimed` (trace d'audit utile), mais n'est plus jamais un verrou
-- permanent.
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
  order by scheduled_at
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
  'Réclame atomiquement le prochain job FBI éligible (FOR UPDATE SKIP LOCKED), en excluant les clubs ayant déjà un job actif RÉCENT (< 10 min — un job claimed/running plus vieux a forcément été tué par un timeout, voir migration 20260924140000). Appelée uniquement par le worker (service role) via son propre client Postgres — jamais exposée à un rôle authenticated.';

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
  order by scheduled_at
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

comment on function public.claim_next_fbi_job_for_club(uuid, text) is
  'Comme claim_next_fbi_job, mais filtré à UN club — utilisée par POST /v1/clubs/:clubId/integrations/fbi/process-jobs (service role, après vérification club_admin par la route), jamais exposée directement à authenticated. Même garde de fraîcheur (< 10 min) sur le job actif bloquant, voir migration 20260924140000.';
