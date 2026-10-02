-- Retour du club, 2026-10-02 (« des matchs sans stats, faut tout régler ») :
-- un job resté « claimed » après un timeout Vercel (process tué avant de
-- passer en succeeded/failed) n'était JAMAIS remis en file. Constaté en
-- production : un `check_all_derogations` figé depuis le 30/09 bloquait,
-- via l'index unique « un seul job actif de ce type par club », toute
-- nouvelle vérification des dérogations.
--
-- Avant chaque réclamation, les jobs claimed/running depuis plus de 15 min
-- (une invocation dure au plus 5 min, vercel.json) sont remis en attente —
-- ou passés en échec s'ils ont épuisé leurs tentatives.

create or replace function public.recover_stale_fbi_jobs()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  recovered integer;
begin
  update public.fbi_jobs
  set
    status = case when attempt_count < max_attempts then 'pending' else 'failed' end,
    scheduled_at = case when attempt_count < max_attempts then now() else scheduled_at end,
    finished_at = case when attempt_count < max_attempts then null else now() end,
    last_error = 'Job interrompu (délai d''exécution dépassé) — remis en file automatiquement. ' || coalesce(last_error, '')
  where status in ('claimed', 'running')
    and claimed_at < now() - interval '15 minutes';
  get diagnostics recovered = row_count;
  return recovered;
end;
$$;

revoke all on function public.recover_stale_fbi_jobs() from public, anon, authenticated;

create or replace function public.claim_next_fbi_job(p_worker_id text)
returns public.fbi_jobs
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  claimed_job public.fbi_jobs;
begin
  perform public.recover_stale_fbi_jobs();

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
set search_path to 'public'
as $$
declare
  claimed_job public.fbi_jobs;
begin
  perform public.recover_stale_fbi_jobs();

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
