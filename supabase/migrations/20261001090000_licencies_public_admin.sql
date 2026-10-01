-- Retour du club, 2026-10-01 : "dans la liste /joueurs avoir la possibilité
-- pour l'admin de mettre un profil admin et qu'il ait accès aux dérogs".
--
-- Un licencié n'a pas forcément de compte (club_memberships exige un
-- auth.users) : ce drapeau, posé par un club_admin, ouvre au licencié
-- l'espace public "admin" (dérogations en lecture seule) via son lien
-- personnel. Il ne donne AUCUN droit dans l'espace connecté (/c/...), qui
-- reste régi par membership_roles. Écrit uniquement par l'API
-- (PATCH /v1/clubs/:clubId/licencies/:id, club_admin), déjà couvert par la
-- policy licencies_all_club_admin.
alter table public.licencies
  add column if not exists public_admin boolean not null default false;

comment on column public.licencies.public_admin is
  'Accès "admin" à l''espace public sans compte (dérogations en lecture seule), donné par un club_admin. Aucun droit dans l''espace connecté.';
