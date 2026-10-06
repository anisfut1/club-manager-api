-- Processus e-Marque déterministe (retour du club, 2026-10-06 : "je veux un
-- process clair, pas au hasard") — voir src/jobs/backoff.ts
-- (`nextEmarqueCheckAt`) et docs/EMARQUE.md.

-- 1. État final "pas de feuille e-Marque" : 7 jours de vérifications à
--    horaires fixes sans feuille sur FBI (relance manuelle possible).
alter table public.matches drop constraint if exists matches_emarque_status_check;
alter table public.matches add constraint matches_emarque_status_check check (
  emarque_status = any (array[
    'not_applicable', 'pending', 'waiting_for_emarque', 'discovered', 'downloading',
    'downloaded', 'parsing', 'imported', 'error', 'needs_review', 'not_available'
  ]::text[])
);

-- 2. Début de la fenêtre de vérification d'un job relancé à la main (sinon :
--    fin du match).
alter table public.fbi_jobs add column if not exists window_start timestamptz;

-- 3. Un job `discover_emarque` interrompu (délai dépassé) n'est jamais
--    abandonné sur un nombre d'essais : c'est le calendrier fixe qui décide.
create or replace function public.recover_stale_fbi_jobs()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  recovered integer;
begin
  update public.fbi_jobs
  set
    status = case when type = 'discover_emarque' or attempt_count < max_attempts then 'pending' else 'failed' end,
    scheduled_at = case when type = 'discover_emarque' or attempt_count < max_attempts then now() else scheduled_at end,
    finished_at = case when type = 'discover_emarque' or attempt_count < max_attempts then null else now() end,
    last_error = 'Job interrompu (délai d''exécution dépassé) — remis en file automatiquement. ' || coalesce(last_error, '')
  where status in ('claimed', 'running')
    and claimed_at < now() - interval '15 minutes';
  get diagnostics recovered = row_count;
  return recovered;
end;
$function$;

-- 4. Ordre de traitement : les feuilles e-Marque d'abord, du match le plus
--    ancien au plus récent ; puis les autres vérifications FBI.
create or replace function public.claim_next_fbi_job(p_worker_id text)
returns public.fbi_jobs
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  claimed_job public.fbi_jobs;
begin
  perform public.recover_stale_fbi_jobs();

  select j.* into claimed_job
  from public.fbi_jobs j
  left join public.matches m on m.id = j.match_id
  where j.status = 'pending'
    and j.scheduled_at <= now()
    and j.club_id not in (
      select club_id from public.fbi_jobs
      where status in ('claimed', 'running')
        and claimed_at > now() - interval '10 minutes'
    )
  order by
    (case when j.type = 'discover_emarque' then 0 else 1 end),
    m.match_datetime nulls last,
    j.scheduled_at
  limit 1
  for update of j skip locked;

  if claimed_job.id is null then
    return null;
  end if;

  update public.fbi_jobs
  set status = 'claimed', claimed_at = now(), claimed_by = p_worker_id, attempt_count = attempt_count + 1
  where id = claimed_job.id
  returning * into claimed_job;

  return claimed_job;
end;
$function$;

create or replace function public.claim_next_fbi_job_for_club(p_club_id uuid, p_worker_id text)
returns public.fbi_jobs
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  claimed_job public.fbi_jobs;
begin
  perform public.recover_stale_fbi_jobs();

  select j.* into claimed_job
  from public.fbi_jobs j
  left join public.matches m on m.id = j.match_id
  where j.status = 'pending'
    and j.scheduled_at <= now()
    and j.club_id = p_club_id
    and j.club_id not in (
      select club_id from public.fbi_jobs
      where status in ('claimed', 'running')
        and claimed_at > now() - interval '10 minutes'
    )
  order by
    (case when j.type = 'discover_emarque' then 0 else 1 end),
    m.match_datetime nulls last,
    j.scheduled_at
  limit 1
  for update of j skip locked;

  if claimed_job.id is null then
    return null;
  end if;

  update public.fbi_jobs
  set status = 'claimed', claimed_at = now(), claimed_by = p_worker_id, attempt_count = attempt_count + 1
  where id = claimed_job.id
  returning * into claimed_job;

  return claimed_job;
end;
$function$;
