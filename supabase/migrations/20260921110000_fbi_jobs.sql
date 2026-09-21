-- =============================================================================
-- FBI/e-Marque réellement automatisé — Étape 1/3 : file de jobs.
--
-- Remplace le modèle "cron fait tout en ligne, séquentiellement, dans une
-- fonction serverless" par une vraie file de travail : le cron Vercel se
-- contente d'EMPILER des jobs (rapide, léger), un worker séparé (capable de
-- faire tourner Playwright, ce qu'une Vercel Function ne permet pas
-- raisonnablement) les CONSOMME. PostgreSQL suffit comme file : pas de
-- Redis/Kafka pour quelques dizaines de clubs (voir docs/FBI_WORKER.md).
-- =============================================================================

create table public.fbi_jobs (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid references public.matches (id) on delete cascade,
  type text not null check (type in ('test_connection', 'discover_emarque')),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 6,
  scheduled_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now()
);

comment on table public.fbi_jobs is
  'File de travail pour l''automatisation FBI (test de connexion, découverte/téléchargement e-Marque). Consommée par le worker (voir docs/FBI_WORKER.md), jamais exécutée en ligne dans une route Vercel.';
comment on column public.fbi_jobs.match_id is
  'NULL pour un job test_connection (pas de match concerné). Obligatoire pour discover_emarque.';
comment on column public.fbi_jobs.claimed_by is
  'Identifiant diagnostique de l''instance de worker ayant réclamé ce job (jamais un secret).';
comment on column public.fbi_jobs.result is
  'Résumé non sensible du résultat (ex: {"documentsFound": 1, "storagePath": "..."}) — jamais de credential, cookie, ou donnée personnelle.';

create index fbi_jobs_club_id_idx on public.fbi_jobs (club_id);
create index fbi_jobs_match_id_idx on public.fbi_jobs (match_id);
create index fbi_jobs_claimable_idx on public.fbi_jobs (scheduled_at) where status = 'pending';

-- Empêche de créer deux fois le même job "discover_emarque" en attente pour
-- le même match (le cron peut tourner plusieurs fois avant qu'un job soit
-- traité) — pas de contrainte équivalente pour test_connection, volontairement
-- déclenché à la demande (bouton admin), jamais dédupliqué.
create unique index fbi_jobs_unique_pending_discovery
  on public.fbi_jobs (club_id, match_id)
  where type = 'discover_emarque' and status in ('pending', 'claimed', 'running');

-- -----------------------------------------------------------------------------
-- Claim atomique (§11 du brief FBI) : FOR UPDATE SKIP LOCKED garantit que
-- deux workers ne réclament jamais le même job. La sous-requête exclut les
-- clubs ayant déjà un job actif (claimed/running) : au plus UNE session FBI
-- active par club à la fois (§13 du brief FBI), quel que soit le nombre de
-- workers qui tournent en parallèle.
-- -----------------------------------------------------------------------------
create function public.claim_next_fbi_job(p_worker_id text)
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
  'Réclame atomiquement le prochain job FBI éligible (FOR UPDATE SKIP LOCKED), en excluant les clubs ayant déjà un job actif. Appelée uniquement par le worker (service role) via son propre client Postgres — jamais exposée à un rôle authenticated.';

-- Accès service role uniquement (le worker se connecte avec la même
-- service role key que l'application, jamais un rôle authenticated).
alter table public.fbi_jobs enable row level security;

create policy "fbi_jobs_select_club_admin" on public.fbi_jobs for select to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());
