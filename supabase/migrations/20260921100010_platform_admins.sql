-- =============================================================================
-- MIGRATION SAAS MULTI-TENANT — Étape 2/10 : administration de la plateforme.
--
-- Un platform_admin est un opérateur du SaaS (nous), pas un administrateur
-- de club. Distinction volontaire du futur `club_admin` (voir migration
-- suivante) pour ne jamais confondre "tous les droits sur un club" et "tous
-- les droits sur la plateforme" (voir docs/MULTI_TENANCY.md).
--
-- Aucune auto-élévation possible : cette table n'a AUCUNE policy RLS pour
-- `authenticated` (même principe que fbi_credentials) — seule la service
-- role (jamais exposée au navigateur) peut y insérer une ligne. Le premier
-- platform_admin est créé par un script/opération manuelle documentée
-- (voir scripts/seed.ts), jamais depuis l'application elle-même.
-- =============================================================================

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.platform_admins is
  'Opérateurs de la plateforme SaaS (jamais un rôle de club). Écriture service-role uniquement, RLS activée sans policy authenticated.';

alter table public.platform_admins enable row level security;

create function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins where user_id = auth.uid()
  );
$$;

comment on function public.is_platform_admin() is
  'Vrai si l''utilisateur authentifié courant est un administrateur de la plateforme SaaS (pas un admin de club). SECURITY DEFINER + search_path fixé pour éviter la récursion RLS et toute résolution de fonction homonyme malveillante.';

-- Un platform_admin peut voir la liste des platform_admins (utile pour
-- /platform). Personne d'autre. Aucune policy d'écriture pour authenticated.
create policy "platform_admins_select_platform_admin"
  on public.platform_admins
  for select
  to authenticated
  using (public.is_platform_admin());
