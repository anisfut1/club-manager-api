-- Une seule connexion FBI par passage (2026-10-06) : une fois la session FBI
-- d'un club ouverte pour un job discover_emarque, les autres jobs
-- discover_emarque DUS de CE club sont réclamés dans la même session au lieu
-- d'une nouvelle connexion (identifiant + mot de passe) par match — c'est
-- précisément cette répétition que FBI coupait.
--
-- Pas de garde "un job actif par club" ici, contrairement à
-- claim_next_fbi_job* : l'appelant détient DÉJÀ le job actif du club (c'est
-- sa session). Même ordre équitable que 20261006120000_fbi_jobs_fair_order.
create or replace function public.claim_next_discover_job_in_session(p_club_id uuid, p_worker_id text)
returns public.fbi_jobs
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  claimed_job public.fbi_jobs;
begin
  select j.* into claimed_job
  from public.fbi_jobs j
  left join public.matches m on m.id = j.match_id
  where j.status = 'pending'
    and j.type = 'discover_emarque'
    and j.scheduled_at <= now()
    and j.club_id = p_club_id
  order by
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

revoke all on function public.claim_next_discover_job_in_session(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_next_discover_job_in_session(uuid, text) to service_role;
