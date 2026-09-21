-- =============================================================================
-- MIGRATION SAAS MULTI-TENANT — Étape 4/10 : bascule des données existantes.
--
-- Aucun compte existant ne doit perdre ses droits. Toutes les lignes de
-- l'ancien `user_roles` (global) appartiennent aujourd'hui au tenant pilote
-- (SC Sète Basket, seul club existant) : on crée une `club_membership` pour
-- chaque utilisateur concerné, en reprenant son licencie_id éventuel
-- (`profiles.licencie_id`) et tous ses rôles ('super_admin' -> 'club_admin').
-- =============================================================================

do $$
declare
  sc_sete_id uuid;
begin
  select id into sc_sete_id from public.clubs where slug = 'sc-sete-basket';

  if sc_sete_id is null then
    raise exception 'Club pilote sc-sete-basket introuvable : migration 20260921100000 a-t-elle été appliquée ?';
  end if;

  -- Une appartenance par utilisateur ayant au moins un rôle OU un profil
  -- rattaché à un licencié du club (les deux cas observés en Phase 0/1).
  insert into public.club_memberships (club_id, user_id, licencie_id)
  select distinct sc_sete_id, u.user_id, p.licencie_id
  from (
    select user_id from public.user_roles
    union
    select user_id from public.profiles where licencie_id is not null
  ) u
  left join public.profiles p on p.user_id = u.user_id
  on conflict (club_id, user_id) do update set licencie_id = excluded.licencie_id
  where club_memberships.licencie_id is null;

  insert into public.membership_roles (membership_id, role, scope_team_id)
  select m.id,
         (case when ur.role = 'super_admin' then 'club_admin' else ur.role::text end)::public.club_role,
         ur.scope_team_id
  from public.user_roles ur
  join public.club_memberships m on m.club_id = sc_sete_id and m.user_id = ur.user_id
  on conflict do nothing;
end;
$$;
