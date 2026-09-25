# Licenciés / fiche joueur

Demande directe du club (2026-09-25) : *"faudrait associer chaque joueur à
sa licence pour ensuite avoir une fiche joueur avec tous ses matchs et ses
stats par match"*, avec la possibilité d'enrichir cette fiche (photo,
infos persos) soit par un admin, soit par le·la licencié·e lui/elle-même
une fois rattaché·e à un compte.

## Le trou qu'il fallait combler d'abord

`licencies` (le modèle "personne physique du club", voir
`supabase/migrations/20260921083010_licencies.sql`) existait depuis la
Phase 0, mais **rien dans ce backend n'y insérait jamais de ligne** —
confirmé en production le 2026-09-25 : `select count(*) from licencies`
renvoyait `0` pour le club pilote, alors même que les numéros de licence
de ses joueuses étaient déjà correctement extraits par le pipeline
e-Marque (voir "Trente-quatrième déclenchement", `docs/FBI.md`). Sans
licenciés, `match_participants.licencie_id` ne pouvait donc JAMAIS être
renseigné, quelle que soit la qualité de l'OCR — la demande du club était
structurellement impossible à satisfaire.

**Corrigé** : `persist-emarque-match.ts#insertParticipants` auto-
provisionne désormais un `licencies` pour un·e joueur·se **du camp du
club lui-même** (jamais l'équipe adverse) quand son numéro de licence est
lu mais qu'aucun licencié existant ne correspond déjà. Le "camp du club"
est déterminé par `matches.is_home` (`true` → nos joueur·se·s sont
`teamSide: "home"` dans les données e-Marque, `false` → `"away"`) —
jamais une supposition : si `is_home` n'est pas renseigné, aucun
provisionnement n'a lieu. Exige un prénom ET un nom de famille lisibles
(jamais une identité devinée ou vide, ARCHITECTURE.md §22) ; en cas de
course avec un autre import créant le même numéro de licence entre-temps
(23505), le licencié déjà créé est simplement réutilisé, jamais un
doublon. Voir `autoProvisionLicencieId` dans
`src/integrations/emarque/persist/persist-emarque-match.ts`.

Portée explicitement limitée aux licencié·e·s **du club exploitant le
compte** (instruction du club, "si l'autre club veut ses stats il devra
faire son compte") : les joueur·se·s de l'équipe adverse ne sont jamais
auto-provisionné·e·s, même quand leur numéro de licence est parfaitement
lu.

## Modèle de rattachement à un compte

Déjà prévu dès la Phase 0, jamais implémenté avant cette demande : un
compte Supabase Auth peut se rattacher à UN `licencies` via
`club_memberships.licencie_id` (une ligne par club, voir
`supabase/migrations/20260921100020_club_memberships.sql` — remplace
l'ancien `profiles.licencie_id`, devenu obsolète depuis que le
rattachement est scopé par club et non plus global). Ce rattachement
lui-même (inviter un compte, le relier à un licencié) reste un geste
manuel de `club_admin` en base à ce stade — aucune UI dédiée n'a été
construite pour cette demande précise, seule la fiche joueur elle-même
(lecture + édition selon ce rattachement) l'a été.

## Sectorisation par équipe (voir docs/TEAMS.md)

`licencies.team_id` renseigné automatiquement depuis `matches.team_id` du
match d'origine à l'auto-provisionnement — jamais réécrit ensuite
automatiquement, modifiable uniquement par `club_admin` (jamais le
licencié lui-même, identité admin-contrôlée comme le reste). Détail
complet (dont un bug de fusion garçons/filles découvert et corrigé au
passage) : `docs/TEAMS.md`.

## Fiche joueur : lecture

`GET /v1/clubs/:clubId/licencies/:licencieId` — identité (nom, prénom,
licence, date de naissance, contact, photo) + l'historique complet des
matchs où ce·tte licencié·e a été `match_participants.licencie_id`, avec
ses statistiques par match si le document "résumé" e-Marque les a lues
(`stats: null` sinon, jamais une valeur devinée — même principe que
`parser/merge.ts`). Lisible par **tout membre actif du club** (nouvelle
policy RLS `licencies_select_member`, voir migration
`20260925090000_licencies_profile_and_member_read.sql`) — la RLS
précédente (`licencies_select_own`, club_admin ou le licencié lui-même
seulement) aurait rendu une fiche joueur invisible à un coéquipier ou un
coach, incohérent avec le reste de l'app (`match_participants`/
`player_match_stats` sont déjà lisibles par tout membre).

`GET /v1/clubs/:clubId/licencies` liste le roster complet du club (tri
alphabétique), point d'entrée pour naviguer vers une fiche.

## Fiche joueur : édition

`PATCH /v1/clubs/:clubId/licencies/:licencieId/profile` — deux
populations de champs distinctes, appliquées côté serveur (voir
`src/modules/licencies/profile-fields.ts`, fonction pure testée
indépendamment de toute IO) :

- **`club_admin`** : tous les champs (identité, licence, statut actif,
  contact, photo).
- **Le·la licencié·e lui/elle-même** (rattaché·e via
  `club_memberships.licencie_id`) : **uniquement** `photoUrl`/`email`/
  `phone` — jamais son propre nom, sa date de naissance, son numéro de
  licence ou son statut actif/inactif. L'identité d'un licencié est ce
  qui relie ses statistiques à travers les matchs (et, pour la licence,
  ce qui a permis l'auto-provisionnement lui-même) — jamais laissée à la
  merci d'une auto-modification.

Un champ hors de la population autorisée pour l'appelant est **rejeté
(400)**, jamais silencieusement ignoré : un appelant ne doit jamais
croire avoir modifié un champ qui ne l'a pas été.

Écrit **toujours via le rôle service**, après ces vérifications
applicatives : la RLS actuelle (`licencies_all_club_admin`) ne couvre que
le `club_admin`, jamais un·e licencié·e éditant sa propre fiche — et
PostgreSQL ne compare pas nativement une valeur `OLD` à une valeur `NEW`
par colonne dans une policy `WITH CHECK` (une policy self-service
"colonne par colonne" serait fragile à écrire et à auditer). Aucune
policy RLS UPDATE additionnelle n'a donc été ajoutée pour le
self-service : sans elle, un appel direct à l'API REST Supabase avec le
JWT du licencié serait de toute façon rejeté par la RLS — la restriction
de champs n'existe donc QUE dans ce endpoint applicatif, jamais comme un
filet de sécurité optionnel.

`photoUrl` suit exactement la même convention que `ClubDto.logoUrl`
(`modules/clubs/routes.ts`) : une simple URL validée, jamais un pipeline
d'upload de fichier dans ce backend.

## Frontend (SCSB)

- `GET /c/:clubSlug/joueurs` — roster du club, tri alphabétique, lien vers
  chaque fiche (`features/licencies` n'existe pas côté SCSB, tout vit dans
  `app/c/[clubSlug]/joueurs/`).
- `GET /c/:clubSlug/joueurs/:licencieId` — la fiche joueur elle-même :
  identité, tableau des matchs avec statistiques par match, et le
  formulaire d'édition (`LicencieProfileEditForm`, `features/licencies/`)
  quand `canEdit` — le `mode` ("admin" vs "self") est décidé CÔTÉ SERVEUR
  dans la page (`isClubAdmin(club.roles)` sinon `profile.isSelf`), jamais
  recalculé côté client : le formulaire n'affiche que les champs pertinents,
  mais c'est de toute façon club-manager-api qui reste la seule source de
  vérité sur ce qui est réellement accepté (rejet 400 sinon).
- Depuis l'onglet "Statistiques" d'un match (`matchs/[id]/page.tsx`), le
  nom d'un·e joueur·se devient un lien vers sa fiche dès que
  `PlayerMatchStatsDto.licencieId` est renseigné (ajouté à ce DTO pour
  cette demande — absent avant, voir `contracts/matches.ts`).
- Carte "Joueurs" ajoutée au dashboard du club, à côté de "Matchs".

## Ce qui n'est PAS fait

- Pas d'UI pour rattacher un compte Supabase Auth à un `licencies`
  (`club_memberships.licencie_id` reste un geste manuel en base) —
  point d'extension naturel si le club veut que les joueur·se·s
  s'auto-servent sans passer par un admin à chaque fois.
- Pas d'auto-provisionnement pour les entraîneurs (`match_coaches`),
  demande explicitement scopée aux joueurs ("associer chaque JOUEUR à sa
  licence") — même mécanisme trivialement extensible si demandé.
- Pas d'upload de photo (URL uniquement, voir plus haut) ni de pipeline de
  recadrage/redimensionnement.
