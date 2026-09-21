-- =============================================================================
-- Phase 0 — Politiques RLS de socle.
--
-- Principe directeur (ARCHITECTURE.md §7/§15) : le frontend n'est jamais la
-- barrière de sécurité, PostgreSQL l'est. Chaque policy ci-dessous est
-- volontairement simple et commentée ; des règles plus fines (coach limité à
-- son équipe, responsable_tables, etc.) seront ajoutées phase par phase, en
-- même temps que les écrans qui en ont besoin.
-- =============================================================================

alter table public.club enable row level security;
alter table public.licencies enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;

-- -----------------------------------------------------------------------------
-- Fonction utilitaire : l'utilisateur courant a-t-il le rôle super_admin ?
--
-- SECURITY DEFINER + search_path fixé : nécessaire pour pouvoir interroger
-- user_roles depuis une policy SANS provoquer de récursion RLS infinie sur
-- user_roles lui-même (la fonction s'exécute avec les droits de son
-- propriétaire, donc en dehors de la RLS de l'appelant).
-- -----------------------------------------------------------------------------
create function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = auth.uid()
      and role = 'super_admin'
  );
$$;

comment on function public.is_super_admin() is
  'Vrai si l''utilisateur authentifié courant possède le rôle super_admin. Utilisée dans les policies RLS pour éviter la récursion sur user_roles.';

-- -----------------------------------------------------------------------------
-- club : référentiel en lecture seule pour tout utilisateur authentifié.
-- Aucune policy d'écriture : seule la service role (qui bypass RLS) peut
-- modifier le club ; il n'y a pas d'écran d'administration du club en Phase 0.
-- -----------------------------------------------------------------------------
create policy "club_select_authenticated"
  on public.club
  for select
  to authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- licencies : chacun peut lire son propre enregistrement (via son profil) ;
-- le super_admin lit/écrit tout. Pas encore de policy pour coach/
-- responsable_tables : elle arrivera avec les modules qui en ont besoin
-- (Phase 3+), pour ne pas écrire de règles pour des écrans qui n'existent pas.
-- -----------------------------------------------------------------------------
create policy "licencies_select_own"
  on public.licencies
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid() and p.licencie_id = licencies.id
    )
  );

create policy "licencies_all_super_admin"
  on public.licencies
  for all
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- -----------------------------------------------------------------------------
-- profiles : chacun lit et modifie son propre profil ; le super_admin lit/écrit
-- tout. Le rattachement à un licencié (licencie_id) est un acte d'administration
-- volontairement exclu du self-service : un utilisateur ne doit pas pouvoir se
-- rattacher lui-même à n'importe quel licencié (usurpation d'identité/de rôle).
-- On restreint donc, en plus de la policy de ligne, les colonnes modifiables en
-- self-service au niveau des privilèges PostgreSQL.
-- -----------------------------------------------------------------------------
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy "profiles_all_super_admin"
  on public.profiles
  for all
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- -----------------------------------------------------------------------------
-- user_roles : chacun peut lire ses propres rôles (utile pour l'UI) ; seul le
-- super_admin peut attribuer ou retirer des rôles.
-- -----------------------------------------------------------------------------
create policy "user_roles_select_own"
  on public.user_roles
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "user_roles_all_super_admin"
  on public.user_roles
  for all
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());
