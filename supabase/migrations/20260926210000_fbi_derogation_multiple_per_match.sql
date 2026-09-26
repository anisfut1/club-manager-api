-- =============================================================================
-- Une rencontre peut avoir PLUSIEURS dérogations distinctes — preuve
-- directe : export Excel du VRAI FBI fourni par le club le 2026-09-27
-- (`rechercherDerogation.xlsx`), 82 lignes réelles pour seulement 51
-- numéros de rencontre UNIQUES. Jusqu'à 8 dérogations différentes pour la
-- même rencontre n°23 (dates de dépôt différentes, parfois des heures
-- proposées différentes) — la contrainte `unique (club_id, match_id)`
-- empêchait structurellement d'en stocker plus d'une par rencontre,
-- ÉCRASANT les autres à chaque vérification (cause racine du blocage
-- "toujours 51" alors que le club en attendait 82, "affiche les 82",
-- 2026-09-27).
--
-- Le club a AUSSI confirmé (même échange) que le numéro de rencontre
-- N'EST PAS unique au club : le numéro "23" existe à la fois en division
-- BU11FN23 et en BU11MN2, deux rencontres totalement distinctes qui
-- partagent coïncidentellement le même numéro. Voir
-- `process-check-all-derogations.ts` : le rapprochement dérogation → match
-- se fait maintenant par (numéro, division), jamais le numéro seul.
--
-- Remplace la clé d'upsert `(club_id, match_id)` par `(club_id,
-- fbi_row_key)` — `fbi_row_key` dérivé du jeton `idDerogation` porté par
-- le lien de détail de CHAQUE ligne du tableau de résultats FBI (voir
-- `derogationRowDetailHref`/`FbiDerogationRow.idDerogation`,
-- browser-client.ts) : un identifiant STABLE par VRAIE dérogation FBI,
-- jamais par rencontre. `match_id` reste une colonne obligatoire (chaque
-- dérogation appartient toujours à UNE rencontre), mais n'est plus
-- contrainte à l'unicité : une rencontre peut désormais avoir plusieurs
-- lignes `fbi_derogation_checks`.
-- =============================================================================

alter table public.fbi_derogation_checks
  drop constraint fbi_derogation_checks_club_id_match_id_key;

alter table public.fbi_derogation_checks
  add column fbi_row_key text;

-- Backfill des lignes déjà connues (au plus une par match avant cette
-- migration, voir l'ancienne contrainte) : aucun jeton `idDerogation`
-- d'origine n'a été capturé avant ce round, donc pas de valeur RÉELLEMENT
-- fiable à leur donner — dérivé de `match_id` pour rester unique par club
-- en attendant, remplacé par le vrai jeton dès la prochaine vérification
-- FBI (bulk ou par match) qui retrouve cette dérogation.
update public.fbi_derogation_checks set fbi_row_key = match_id::text where fbi_row_key is null;

alter table public.fbi_derogation_checks alter column fbi_row_key set not null;

alter table public.fbi_derogation_checks
  add constraint fbi_derogation_checks_club_id_fbi_row_key_key unique (club_id, fbi_row_key);

comment on column public.fbi_derogation_checks.fbi_row_key is
  'Identifiant STABLE d''une dérogation FBI précise — dérivé du jeton `idDerogation` porté par son lien de détail (`afficherDerogation.fbi?idDerogation=...`), voir `FbiDerogationRow.idDerogation` (browser-client.ts). Remplace `match_id` comme clé d''upsert (`unique (club_id, fbi_row_key)`) : une rencontre peut désormais avoir PLUSIEURS lignes, voir la doc de cette migration.';

-- `match_id` n'est plus couvert par un index unique — un index simple
-- reste utile pour les lectures groupées par match (page de détail d'une
-- rencontre, suppression en cascade côté `processCheckDerogationJob`).
create index fbi_derogation_checks_match_id_idx on public.fbi_derogation_checks (match_id);
