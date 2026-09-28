-- =============================================================================
-- Import en masse des licenciés depuis un export FBI ("rechercherLicence.fbi",
-- critère "Validé") — demande du club, 2026-09-28 : "Voici la liste des
-- licenciés, ajoute les tous stp, a lavenir yen aura dautres, faudra ignorer
-- les doublons dans les exports."
--
-- `ffbb_licence_id` ("N° national" de l'export FBI, ex. "200000002740760" ou
-- "271056" pour un historique plus ancien) : identifiant FFBB STABLE d'une
-- personne physique, distinct de `license_number` ("Numéro", ex. "VT780264")
-- qui peut changer d'une saison à l'autre. Clé de DÉDOUBLONNAGE pour les
-- imports FUTURS (contrainte unique ci-dessous, par club — jamais globale,
-- une même personne physique pourrait légitimement exister dans deux clubs
-- distincts de ce SaaS). `null` pour les licenciés déjà auto-provisionnés
-- depuis un e-Marque avant cette migration (voir persist-emarque-match.ts) —
-- jamais rétro-rempli par un backfill deviné ici (fait manuellement en base,
-- par correspondance sur `license_number`, pour les quelques lignes
-- concernées).
--
-- `category_label` ("Catégorie" de l'export, ex. "Seniors", "U13") : pure
-- INFORMATION d'affichage pour aider l'admin à glisser la bonne carte vers
-- la bonne équipe (le club a plusieurs équipes par catégorie, ex. SM1/SM2/
-- SF — voir docs/TEAMS.md) — jamais une source de vérité pour `team_id`,
-- qui reste un choix manuel exclusif de club_admin.
--
-- `sexe` ("Sexe" de l'export) : même donnée FFBB fiable déjà utilisée côté
-- `teams.sexe` pour désambiguïser un nom d'équipe ambigu (voir
-- `util/team-name.ts`) — affichée ici sur la carte pour la même raison :
-- éviter qu'un admin glisse une joueuse vers une équipe masculine par
-- simple confusion de nom.
-- =============================================================================

alter table public.licencies add column ffbb_licence_id text;
alter table public.licencies add column category_label text;
alter table public.licencies add column sexe text check (sexe in ('M', 'F'));

comment on column public.licencies.ffbb_licence_id is
  '"N° national" FFBB (export rechercherLicence.fbi) — identifiant stable d''une personne physique, clé de dédoublonnage des imports (unique par club). NULL pour les licenciés auto-provisionnés avant cette migration.';
comment on column public.licencies.category_label is
  'Catégorie FFBB au moment de l''import (ex. "Seniors", "U13") — affichage seulement, jamais une source de vérité pour team_id.';
comment on column public.licencies.sexe is
  'Sexe FFBB (export rechercherLicence.fbi) — affichage seulement, même donnée que teams.sexe (voir util/team-name.ts côté application).';

create unique index licencies_club_id_ffbb_licence_id_key on public.licencies (club_id, ffbb_licence_id) where ffbb_licence_id is not null;
