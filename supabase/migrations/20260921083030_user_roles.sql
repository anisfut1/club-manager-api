-- Rôles applicatifs définis dans ARCHITECTURE.md §7 / §6.
create type public.app_role as enum (
  'super_admin',
  'correspondant_club',
  'responsable_tables',
  'coach',
  'joueur',
  'parent'
);

comment on type public.app_role is
  'Rôles applicatifs du club. Un utilisateur peut cumuler plusieurs rôles (voir user_roles).';

-- Table many-to-many user <-> role.
-- Le scope (ex: coach limité à une équipe) sera ajouté par une future migration
-- (colonne scope_team_id) une fois la table `teams` créée en Phase 1 : le fait que
-- les rôles vivent déjà dans une table dédiée permet d'ajouter cette colonne plus
-- tard sans restructuration, conformément à ARCHITECTURE.md §8.
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

comment on table public.user_roles is
  'Rôles attribués à un compte utilisateur. Un utilisateur peut avoir plusieurs lignes (plusieurs rôles).';

create index user_roles_user_id_idx on public.user_roles (user_id);
