-- =============================================================================
-- MIGRATION SAAS MULTI-TENANT — Étape 10/10 : RLS multi-tenant + nettoyage.
--
-- Remplace TOUTES les policies "authenticated peut tout lire" / "super_admin
-- peut tout faire" (globales, Phase 0/1) par une isolation stricte par club
-- (§11 du brief SaaS). Supprime aussi les mécanismes globaux devenus
-- obsolètes (user_roles, app_role, is_super_admin(), profiles.licencie_id)
-- une fois leurs données déjà migrées (voir 20260921100030).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Supprimer les anciennes policies (avant de casser leurs dépendances).
-- -----------------------------------------------------------------------------
drop policy if exists "club_select_authenticated" on public.clubs;

drop policy if exists "licencies_select_own" on public.licencies;
drop policy if exists "licencies_all_super_admin" on public.licencies;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_all_super_admin" on public.profiles;

drop policy if exists "user_roles_select_own" on public.user_roles;
drop policy if exists "user_roles_all_super_admin" on public.user_roles;

drop policy if exists "teams_select_authenticated" on public.teams;
drop policy if exists "teams_all_super_admin" on public.teams;

drop policy if exists "competitions_select_authenticated" on public.competitions;
drop policy if exists "competitions_all_super_admin" on public.competitions;

drop policy if exists "pools_select_authenticated" on public.pools;
drop policy if exists "pools_all_super_admin" on public.pools;

drop policy if exists "venues_select_authenticated" on public.venues;
drop policy if exists "venues_all_super_admin" on public.venues;

drop policy if exists "ffbb_team_engagements_select_authenticated" on public.ffbb_team_engagements;
drop policy if exists "ffbb_team_engagements_all_super_admin" on public.ffbb_team_engagements;

drop policy if exists "matches_select_authenticated" on public.matches;
drop policy if exists "matches_all_super_admin" on public.matches;

drop policy if exists "match_change_history_select_authenticated" on public.match_change_history;
drop policy if exists "match_change_history_all_super_admin" on public.match_change_history;

drop policy if exists "sync_runs_select_super_admin" on public.sync_runs;

drop policy if exists "fbi_integration_status_select_super_admin" on public.fbi_integration_status;

drop policy if exists "emarque_imports_select_authenticated" on public.emarque_imports;
drop policy if exists "emarque_imports_all_super_admin" on public.emarque_imports;

drop policy if exists "match_participants_select_authenticated" on public.match_participants;
drop policy if exists "match_participants_all_super_admin" on public.match_participants;

drop policy if exists "match_coaches_select_authenticated" on public.match_coaches;
drop policy if exists "match_coaches_all_super_admin" on public.match_coaches;

drop policy if exists "match_officials_select_authenticated" on public.match_officials;
drop policy if exists "match_officials_all_super_admin" on public.match_officials;

drop policy if exists "match_table_officials_select_authenticated" on public.match_table_officials;
drop policy if exists "match_table_officials_all_super_admin" on public.match_table_officials;

drop policy if exists "player_match_stats_select_authenticated" on public.player_match_stats;
drop policy if exists "player_match_stats_all_super_admin" on public.player_match_stats;

drop policy if exists "shot_events_select_authenticated" on public.shot_events;
drop policy if exists "shot_events_all_super_admin" on public.shot_events;

-- -----------------------------------------------------------------------------
-- 2) Supprimer les mécanismes globaux obsolètes (données déjà migrées vers
--    club_memberships / membership_roles, voir 20260921100030).
-- -----------------------------------------------------------------------------
drop function if exists public.is_super_admin();
drop table if exists public.user_roles;
drop type if exists public.app_role;

alter table public.profiles drop column if exists licencie_id;

comment on table public.profiles is
  'Profil applicatif global d''un compte Supabase Auth (nom affiché). Le rattachement à un licencié est désormais tenant-scoped : voir club_memberships.licencie_id.';

-- -----------------------------------------------------------------------------
-- 3) Helpers RLS multi-tenant.
-- -----------------------------------------------------------------------------
create function public.is_club_member(target_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.club_memberships
    where club_id = target_club_id
      and user_id = auth.uid()
      and status = 'active'
  );
$$;

comment on function public.is_club_member(uuid) is
  'Vrai si l''utilisateur authentifié courant est membre actif du club donné. SECURITY DEFINER + search_path fixé (évite la récursion RLS et toute résolution de fonction homonyme malveillante).';

create function public.has_club_role(target_club_id uuid, target_role public.club_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.club_memberships m
    join public.membership_roles r on r.membership_id = m.id
    where m.club_id = target_club_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and r.role = target_role
  );
$$;

comment on function public.has_club_role(uuid, public.club_role) is
  'Vrai si l''utilisateur authentifié courant a CE rôle sur CE club (portée club entière ou scopée équipe confondues). SECURITY DEFINER + search_path fixé.';

-- -----------------------------------------------------------------------------
-- 4) Nouvelles policies, toutes explicitement scopées au club.
-- -----------------------------------------------------------------------------

-- clubs : lecture ouverte (branding/slug non sensibles, nécessaires pour
-- résoudre /c/{slug} avant même de savoir si l'utilisateur est membre).
-- Écriture des champs sensibles (slug, statut, code FFBB) réservée au
-- platform_admin ; un club_admin peut modifier le branding de SON club via
-- un privilège de colonne restreint (voir grants ci-dessous).
create policy "clubs_select_authenticated" on public.clubs for select to authenticated using (true);
create policy "clubs_all_platform_admin" on public.clubs for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy "clubs_update_club_admin" on public.clubs for update to authenticated
  using (public.has_club_role(id, 'club_admin'))
  with check (public.has_club_role(id, 'club_admin'));

revoke update on public.clubs from authenticated;
grant update (name, short_name, logo_url, accent_color, timezone) on public.clubs to authenticated;

-- club_memberships
create policy "club_memberships_select" on public.club_memberships for select to authenticated
  using (user_id = auth.uid() or public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());
create policy "club_memberships_write" on public.club_memberships for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

-- membership_roles (via la membership parente)
create policy "membership_roles_select" on public.membership_roles for select to authenticated
  using (
    exists (
      select 1 from public.club_memberships m
      where m.id = membership_id
        and (m.user_id = auth.uid() or public.has_club_role(m.club_id, 'club_admin') or public.is_platform_admin())
    )
  );
create policy "membership_roles_write" on public.membership_roles for all to authenticated
  using (
    exists (
      select 1 from public.club_memberships m
      where m.id = membership_id and (public.has_club_role(m.club_id, 'club_admin') or public.is_platform_admin())
    )
  )
  with check (
    exists (
      select 1 from public.club_memberships m
      where m.id = membership_id and (public.has_club_role(m.club_id, 'club_admin') or public.is_platform_admin())
    )
  );

-- profiles : chacun lit/modifie son propre profil ; le platform_admin gère
-- le reste (support). Plus de notion de "super_admin de club" ici : le nom
-- affiché est global, pas une donnée de club.
create policy "profiles_select_own" on public.profiles for select to authenticated using (user_id = auth.uid());
create policy "profiles_update_own" on public.profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "profiles_all_platform_admin" on public.profiles for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

-- licencies : un licencié ne se lit que via SON rattachement (club_memberships),
-- le club_admin lit/écrit tout ce qui appartient à son club (RGPD, ARCHITECTURE.md §26).
create policy "licencies_select_own" on public.licencies for select to authenticated
  using (exists (select 1 from public.club_memberships m where m.user_id = auth.uid() and m.licencie_id = licencies.id));
create policy "licencies_all_club_admin" on public.licencies for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

-- teams
create policy "teams_select_member" on public.teams for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "teams_all_club_admin" on public.teams for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

-- competitions / pools / venues : référentiel FFBB GLOBAL partagé entre
-- clubs (voir 20260921100040) — lecture ouverte, écriture réservée au
-- service de synchronisation (service role) et au platform_admin (correction manuelle).
create policy "competitions_select_authenticated" on public.competitions for select to authenticated using (true);
create policy "competitions_all_platform_admin" on public.competitions for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy "pools_select_authenticated" on public.pools for select to authenticated using (true);
create policy "pools_all_platform_admin" on public.pools for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy "venues_select_authenticated" on public.venues for select to authenticated using (true);
create policy "venues_all_platform_admin" on public.venues for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

-- ffbb_team_engagements / matches / match_change_history : club-scopées.
create policy "ffbb_team_engagements_select_member" on public.ffbb_team_engagements for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "ffbb_team_engagements_all_club_admin" on public.ffbb_team_engagements for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

create policy "matches_select_member" on public.matches for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "matches_all_club_admin" on public.matches for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

create policy "match_change_history_select_member" on public.match_change_history for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "match_change_history_all_club_admin" on public.match_change_history for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

-- sync_runs : diagnostic technique, réservé aux admins (club ou plateforme).
create policy "sync_runs_select_club_admin" on public.sync_runs for select to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

-- fbi_integration_status : statut (jamais de secret), réservé aux admins.
create policy "fbi_integration_status_select_club_admin" on public.fbi_integration_status for select to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

-- Données de match e-Marque : lecture pour tout membre du club, écriture
-- (corrections /admin/issues) réservée aux admins.
create policy "emarque_imports_select_member" on public.emarque_imports for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "emarque_imports_all_club_admin" on public.emarque_imports for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

create policy "match_participants_select_member" on public.match_participants for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "match_participants_all_club_admin" on public.match_participants for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

create policy "match_coaches_select_member" on public.match_coaches for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "match_coaches_all_club_admin" on public.match_coaches for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

create policy "match_officials_select_member" on public.match_officials for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "match_officials_all_club_admin" on public.match_officials for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

create policy "match_table_officials_select_member" on public.match_table_officials for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "match_table_officials_all_club_admin" on public.match_table_officials for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

create policy "player_match_stats_select_member" on public.player_match_stats for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "player_match_stats_all_club_admin" on public.player_match_stats for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

create policy "shot_events_select_member" on public.shot_events for select to authenticated using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "shot_events_all_club_admin" on public.shot_events for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());
