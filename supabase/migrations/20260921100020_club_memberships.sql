-- =============================================================================
-- MIGRATION SAAS MULTI-TENANT — Étape 3/10 : appartenance et rôles club-scopés.
--
-- Remplace le futur ex-`user_roles` (global) par un modèle à deux niveaux :
--   club_memberships   un utilisateur appartient (ou non) à un club donné
--   membership_roles    les rôles de CETTE appartenance (jamais globaux)
--
-- Un même compte Supabase Auth (global) peut ainsi avoir une ligne
-- club_memberships par club auquel il appartient, chacune avec ses propres
-- rôles (ARCHITECTURE.md / docs/MULTI_TENANCY.md, §7-9 du brief SaaS).
-- =============================================================================

-- club_admin remplace l'ancien super_admin : "tous les droits SUR CE CLUB",
-- explicitement distinct de platform_admin (tous les droits sur la
-- plateforme, voir migration précédente). Renommé maintenant plutôt que de
-- garder un nom ambigu pour toute la durée de vie du produit : aucune
-- donnée réelle en production à ce stade, le coût de renommer est nul.
create type public.club_role as enum (
  'club_admin',
  'correspondant_club',
  'responsable_tables',
  'coach',
  'joueur',
  'parent'
);

comment on type public.club_role is
  'Rôles applicatifs au sein d''UN club. club_admin = tous les droits sur ce club (ex-super_admin) ; ne pas confondre avec platform_admin (opérateur SaaS, table séparée).';

create table public.club_memberships (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  licencie_id uuid references public.licencies (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, user_id)
);

comment on table public.club_memberships is
  'Appartenance d''un compte utilisateur à un club. Un compte peut avoir plusieurs lignes (un club B, un club A, ...) — voir docs/MULTI_TENANCY.md.';
comment on column public.club_memberships.licencie_id is
  'Rattachement optionnel à un licencié DU MÊME CLUB (voir la contrainte club_memberships_licencie_same_club ci-dessous). Un même compte peut donc être licencié dans un club et pas dans un autre.';

create index club_memberships_user_id_idx on public.club_memberships (user_id);
create index club_memberships_club_id_idx on public.club_memberships (club_id);

-- Empêche structurellement "membership Club A + licencié Club B" (§7/§44 du
-- brief SaaS) : PostgreSQL protège aussi contre les erreurs de code, pas
-- seulement le frontend.
create function public.check_membership_licencie_same_club()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  licencie_club_id uuid;
begin
  if new.licencie_id is null then
    return new;
  end if;

  select club_id into licencie_club_id from public.licencies where id = new.licencie_id;

  if licencie_club_id is null or licencie_club_id <> new.club_id then
    raise exception 'club_memberships.licencie_id doit appartenir au même club_id (membership club=%, licencie club=%)', new.club_id, licencie_club_id;
  end if;

  return new;
end;
$$;

create trigger club_memberships_licencie_same_club
  before insert or update of licencie_id, club_id on public.club_memberships
  for each row
  execute function public.check_membership_licencie_same_club();

create table public.membership_roles (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.club_memberships (id) on delete cascade,
  role public.club_role not null,
  scope_team_id uuid references public.teams (id) on delete cascade,
  -- Les NULL de scope_team_id sont tous "distincts" pour une contrainte
  -- UNIQUE classique en SQL (deux rôles globaux identiques pourraient donc
  -- coexister). On matérialise un sentinel non-NULL à la place de NULL dans
  -- une colonne générée dédiée à l'unicité, pour pouvoir utiliser une
  -- contrainte UNIQUE simple (colonnes physiques, sans clause WHERE) — plus
  -- portable pour un upsert (`ON CONFLICT (colonnes)`, voir
  -- src/server/actions/platform-clubs.ts) qu'un index partiel.
  scope_key uuid generated always as (coalesce(scope_team_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  created_at timestamptz not null default now(),
  unique (membership_id, role, scope_key)
);

comment on table public.membership_roles is
  'Rôle(s) d''une appartenance à un club. scope_team_id restreint le rôle à une équipe (ex: coach limité à SM2) ; NULL = portée club entière.';
comment on column public.membership_roles.scope_key is
  'Colonne technique (scope_team_id ou sentinel si NULL) portant la contrainte UNIQUE. Ne jamais l''utiliser comme donnée métier.';

create index membership_roles_membership_id_idx on public.membership_roles (membership_id);

-- Empêche structurellement "membership Club A + scope_team_id Club B"
-- (§43 du brief SaaS).
create function public.check_membership_role_scope_same_club()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  membership_club_id uuid;
  team_club_id uuid;
begin
  if new.scope_team_id is null then
    return new;
  end if;

  select club_id into membership_club_id from public.club_memberships where id = new.membership_id;
  select club_id into team_club_id from public.teams where id = new.scope_team_id;

  if membership_club_id is null or team_club_id is null or membership_club_id <> team_club_id then
    raise exception 'membership_roles.scope_team_id doit appartenir au même club que le membership (membership club=%, team club=%)', membership_club_id, team_club_id;
  end if;

  return new;
end;
$$;

create trigger membership_roles_scope_same_club
  before insert or update of scope_team_id, membership_id on public.membership_roles
  for each row
  execute function public.check_membership_role_scope_same_club();
