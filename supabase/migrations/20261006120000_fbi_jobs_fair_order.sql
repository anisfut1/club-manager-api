-- Rotation équitable des jobs FBI (2026-10-06) : constaté en production que
-- deux matchs anciens en échec répété repassaient TOUJOURS en tête (tri par
-- date de match) et bloquaient les 17 autres. Priorité désormais au job
-- essayé il y a le plus longtemps (jamais essayé = en premier : un match tout
-- juste joué passe donc avant tout le monde), puis au match le plus ancien.
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
    j.claimed_at asc nulls first,
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
    j.claimed_at asc nulls first,
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
