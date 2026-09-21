-- =============================================================================
-- MIGRATION SAAS MULTI-TENANT — Étape 8/10 : verrou de synchronisation par club.
--
-- Empêche qu'un cron et un déclenchement manuel admin ("Sync maintenant")
-- lancent deux synchronisations simultanées pour le même (club, intégration)
-- (§26 du brief SaaS). Un verrou par TABLE plutôt qu'un pg_advisory_lock
-- classique : les fonctions serverless (Vercel) n'ont pas de session
-- PostgreSQL persistante entre l'acquisition et la libération d'un verrou
-- de session, ce qui rendrait pg_advisory_lock peu fiable ici. Une ligne en
-- base, avec expiration automatique des verrous "coincés", est un
-- équivalent fonctionnel plus robuste dans ce contexte.
-- =============================================================================

create table public.sync_locks (
  club_id uuid not null references public.clubs (id) on delete cascade,
  integration text not null check (integration in ('ffbb', 'fbi')),
  locked_at timestamptz not null default now(),
  primary key (club_id, integration)
);

comment on table public.sync_locks is
  'Verrou applicatif (club, intégration) : une seule synchronisation à la fois par couple. Accès service role uniquement (RLS activée, aucune policy authenticated).';

alter table public.sync_locks enable row level security;

-- Tente d'acquérir le verrou ; renvoie true si acquis. Libère automatiquement
-- tout verrou plus vieux que p_stale_after (job mort sans avoir nettoyé).
create function public.try_acquire_sync_lock(p_club_id uuid, p_integration text, p_stale_after interval default interval '10 minutes')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.sync_locks
  where club_id = p_club_id
    and integration = p_integration
    and locked_at < now() - p_stale_after;

  insert into public.sync_locks (club_id, integration)
  values (p_club_id, p_integration)
  on conflict (club_id, integration) do nothing;

  return found;
end;
$$;

create function public.release_sync_lock(p_club_id uuid, p_integration text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.sync_locks where club_id = p_club_id and integration = p_integration;
$$;

comment on function public.try_acquire_sync_lock(uuid, text, interval) is
  'Verrou non-bloquant : renvoie false si (club_id, integration) est déjà verrouillé (et pas périmé). Appelée uniquement depuis le code serveur (client admin/service role).';
