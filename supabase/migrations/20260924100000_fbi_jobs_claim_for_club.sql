-- =============================================================================
-- Réclamation d'un job FBI SCOPÉE À UN CLUB — voir docs/FBI.md "Neuvième
-- déclenchement" : `/internal/cron/fbi-jobs` ne tourne qu'une fois par jour
-- (vercel.json), et un club_admin n'a aucun moyen "via l'appli" de faire
-- traiter ses jobs `discover_emarque`/`test_connection` en attente plus tôt
-- sans déclencher ce cron à la main sur le dashboard Vercel — exactement ce
-- que le club a demandé d'éviter. `claim_next_fbi_job` existant réclame
-- GLOBALEMENT (n'importe quel club) : jamais exposable à un rôle
-- `authenticated`/appelable depuis une route `/v1/*` scopée à UN club sans
-- fuiter/traiter les jobs d'un AUTRE club. Cette variante ajoute un filtre
-- `club_id`, même logique de verrou (FOR UPDATE SKIP LOCKED, un seul job
-- actif par club à la fois) sinon identique.
-- =============================================================================

create function public.claim_next_fbi_job_for_club(p_club_id uuid, p_worker_id text)
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
  'Comme claim_next_fbi_job, mais filtré à UN club — utilisée par POST /v1/clubs/:clubId/integrations/fbi/process-jobs (service role, après vérification club_admin par la route), jamais exposée directement à authenticated.';

-- Même politique d'accès que claim_next_fbi_job : ni GRANT authenticated,
-- ni policy — appel service role uniquement, depuis le code serveur.
revoke all on function public.claim_next_fbi_job_for_club(uuid, text) from public, anon, authenticated;
