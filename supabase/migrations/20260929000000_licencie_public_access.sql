-- =============================================================================
-- Accès public sans compte aux Tables de marque (retour du club,
-- 2026-09-29) : "je vais envoyer le lien à tout le monde et ils se
-- positionneront... une fois positionné, ils ne doivent plus pouvoir être
-- modifiés par qqn d'autre, mais peuvent se supprimer eux-mêmes si le
-- token est tjr actif, sinon faut faire une demande admin (car l'accès se
-- fera sans création de compte)".
--
-- Un seul lien est envoyé à tout le club. À la première visite, la
-- personne choisit son nom dans la liste des licenciés actifs (jamais de
-- mot de passe) : ce choix mint un jeton personnel secret (haché ici,
-- jamais stocké en clair — même précaution que fbi_credentials) qui
-- l'identifie ensuite. Un nom déjà choisi ne peut plus l'être une 2e fois
-- (index unique PARTIEL ci-dessous, sur les jetons encore actifs
-- uniquement) tant qu'un club_admin ne le réinitialise pas explicitement
-- (POST .../licencies/:licencieId/public-access/reset).
--
-- PRINCIPE : ce jeton authentifie UNIQUEMENT "je suis ce licencié précis
-- de ce club" — jamais un rôle ni un droit d'administration. Il ne donne
-- accès QU'à modules/public-tables/routes.ts (self-service sur SES
-- propres affectations), jamais aux routes admin authentifiées par
-- Supabase Auth.
-- =============================================================================

create table public.licencie_public_tokens (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  -- Haché (SHA-256), jamais le jeton en clair — une fuite de la base ne
  -- permet pas de rejouer directement les liens personnels déjà distribués.
  token_hash text not null,
  -- Optionnel (retour du club : "et oui, on peut mettre un mail") — simple
  -- coordonnée de contact conservée pour un club_admin, aucune vérification
  -- d'adresse en V1 (pas d'envoi d'email automatique, voir docs).
  email text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null
);

comment on table public.licencie_public_tokens is
  'Jetons personnels sans compte donnant accès en libre-service à SES PROPRES affectations Tables de marque (retour du club, 2026-09-29). Jamais un rôle applicatif : authentifie uniquement "je suis ce licencié", rien de plus.';
comment on column public.licencie_public_tokens.token_hash is
  'SHA-256 du jeton distribué dans le lien personnel — le jeton en clair n''existe QUE côté client, jamais stocké ni loggé côté serveur.';
comment on column public.licencie_public_tokens.revoked_at is
  'NULL = jeton actif. Rempli uniquement par une réinitialisation admin explicite (licencié qui a perdu son lien, quitté le club, etc.) — jamais d''expiration automatique (retour du club : "jamais sauf révocation manuelle par un admin").';

-- Un seul jeton ACTIF par licencié à la fois (le nom ne peut être choisi
-- qu'une fois tant qu'il n'est pas explicitement libéré) — index PARTIEL :
-- une réinitialisation admin (revoked_at rempli) libère immédiatement le
-- nom pour une nouvelle revendication, sans jamais supprimer l'historique.
create unique index licencie_public_tokens_active_licencie_idx on public.licencie_public_tokens (club_id, licencie_id) where revoked_at is null;
create unique index licencie_public_tokens_token_hash_idx on public.licencie_public_tokens (token_hash);
create index licencie_public_tokens_club_id_idx on public.licencie_public_tokens (club_id);

alter table public.licencie_public_tokens enable row level security;

-- Réservé à club_admin (gestion d'accès/identité, plus sensible que la
-- table de marque elle-même — jamais responsable_tables ici). Le flux
-- PUBLIC (choix du nom, auto-affectation) passe TOUJOURS par le rôle
-- service côté API (modules/public-tables/routes.ts), jamais par une
-- policy "anon" : cette RLS ne protège que la vue/gestion ADMIN de ces
-- jetons, pas le flux public lui-même (vérification manuelle du token dans
-- le code applicatif, même raisonnement que fbi_credentials).
create policy "licencie_public_tokens_all_club_admin" on public.licencie_public_tokens for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());
