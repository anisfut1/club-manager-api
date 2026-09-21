-- =============================================================================
-- MIGRATION SAAS MULTI-TENANT — Étape 1/10 : le club devient un vrai tenant.
--
-- Jusqu'ici `club` était une table à une seule ligne (SC Sète Basket),
-- point d'ancrage de `licencies`/`teams`/`fbi_credentials` mais jamais
-- pensée comme un tenant parmi d'autres. Cette migration la transforme en
-- `clubs` (pluriel, cohérent avec le reste du schéma) sans perdre aucune
-- donnée : RENAME TABLE préserve automatiquement toutes les FK, index et
-- contraintes existants (voir docs/MULTI_TENANCY.md).
-- =============================================================================

alter table public.club rename to clubs;

alter table public.clubs
  add column slug text,
  add column timezone text not null default 'Europe/Paris',
  add column status text not null default 'active' check (status in ('active', 'suspended')),
  add column short_name text,
  add column logo_url text,
  add column accent_color text;

comment on table public.clubs is
  'Un tenant de la plateforme (un club de basket). SC Sète Basket est le tenant pilote, pas un cas particulier du code.';
comment on column public.clubs.slug is
  'Identifiant lisible utilisé dans les URLs (/c/{slug}/...). Jamais utilisé comme clé étrangère : les relations internes utilisent toujours clubs.id (UUID).';
comment on column public.clubs.ffbb_club_id is
  'Code FFBB de CE club (ex: OCC0034008). Configuration du tenant, plus jamais une constante globale dans le code applicatif.';
comment on column public.clubs.status is
  'active: fonctionne normalement. suspended: synchronisations FFBB/FBI arrêtées, accès applicatif bloqué (pas de billing pour l''instant, voir docs/MULTI_TENANCY.md).';

-- Backfill du tenant pilote (donnée de migration, pas une hypothèse métier).
update public.clubs
set slug = 'sc-sete-basket', timezone = 'Europe/Paris', status = 'active'
where ffbb_club_id = 'OCC0034008' and slug is null;

alter table public.clubs
  alter column slug set not null,
  add constraint clubs_slug_unique unique (slug),
  add constraint clubs_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

create index clubs_status_idx on public.clubs (status);
