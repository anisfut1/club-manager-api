# Accès public sans compte aux Tables de marque

Retour du club, 2026-09-29 : "il faut un système où la personne qui va se
mettre sur un match ne peut pas être supprimée par quelqu'un d'autre sauf
un admin (sur demande). Car je vais envoyer le lien à tout le monde et ils
se positionneront, et une fois positionné, ils ne doivent plus pouvoir
être modifiés par qqn d'autre, mais peuvent se supprimer eux-mêmes si le
token est tjr actif, sinon faut faire une demande admin (car l'accès se
fera sans création de compte)".

Ce document décrit le mécanisme d'auto-affectation sans compte qui vient
compléter le module Tables de marque (voir `docs/TABLE_ASSIGNMENTS.md`,
qui reste la référence pour la règle des 120 minutes, la détection de
conflit, le ranking et l'équité — ce document-ci ne couvre QUE l'accès et
la propriété des affectations, jamais l'algorithme lui-même, identique des
deux côtés).

## Principe : un lien commun, un jeton personnel

Le club distribue **un seul lien**, commun à tout le monde (WhatsApp,
email de groupe, etc.) : `https://.../public/{clubSlug}/tables`. Il n'y a
**aucune création de compte, aucun mot de passe**.

À la première visite, la personne **choisit son nom** dans la liste des
licenciés actifs du club (`GET /v1/public/clubs/:clubSlug/licencies`, qui
renvoie `claimed: true/false` par licencié — jamais qui a déjà choisi
quoi, seulement si c'est encore possible). Ce choix
(`POST .../licencies/:licencieId/claim`) **mint un jeton personnel secret**
à haute entropie (32 octets aléatoires), renvoyé **une seule fois** dans la
réponse — seul son hash SHA-256 est stocké côté serveur
(`licencie_public_tokens.token_hash`), jamais le jeton en clair (même
précaution que `fbi_credentials`, voir `docs/MULTI_TENANCY.md`). Le
frontend doit immédiatement inviter la personne à **conserver ce lien**
(bookmark) : c'est sa seule preuve d'identité pour la suite, il n'existe
aucun mécanisme de récupération automatique (pas d'envoi d'email en V1,
voir "Hors périmètre V1" ci-dessous).

**Un nom ne peut être choisi qu'une seule fois** tant qu'il est actif — un
index UNIQUE PARTIEL en base (`(club_id, licencie_id) WHERE revoked_at IS
NULL`) garantit cette règle de façon atomique, y compris en cas de double
clic simultané par deux personnes sur le même nom (jamais un
SELECT-puis-INSERT applicatif, qui laisserait une fenêtre de course).

## Ce que le jeton authentifie — et ce qu'il n'autorise jamais

Le jeton prouve **uniquement** "je suis ce licencié précis, de ce club" —
jamais un rôle applicatif, jamais un droit d'administration. Il donne
accès **exclusivement** aux routes du module `modules/public-tables/`
(auto-affectation sur SES propres postes) — jamais aux routes admin
authentifiées par Supabase Auth (`club_admin`/`responsable_tables`), qui
restent inchangées et peuvent toujours tout faire (voir plus bas).

## Propriété d'une affectation — le cœur de la demande

Une fois qu'une personne s'est affectée elle-même à un poste :

- **Personne d'autre, via le flux public, ne peut la remplacer ou la
  retirer.** `PUT .../table-assignments/:role?token=` refuse (409
  `ALREADY_TAKEN_BY_SOMEONE_ELSE`) si le poste est déjà occupé par un
  licencié différent de celui du jeton — contrairement au `PUT` admin
  (authentifié), qui peut toujours remplacer n'importe qui (§77 "Modifier"
  de `docs/TABLE_ASSIGNMENTS.md`). `DELETE .../table-assignments/:role?token=`
  refuse (403) de retirer l'affectation de quelqu'un d'autre, quelle que
  soit la raison.
- **La personne elle-même peut toujours se retirer**, tant que son jeton
  est actif — `DELETE` avec son propre jeton réussit toujours sur SON
  poste.
- **Un admin peut toujours tout faire** — les routes admin authentifiées
  (`PUT`/`DELETE .../table-assignments/:role` sous `/v1/clubs/:clubId/...`)
  ne changent pas : un club_admin ou responsable_tables peut remplacer ou
  retirer n'importe quelle affectation, quelle que soit son origine
  (créée par un admin ou auto-affectée). C'est la voie "demande admin"
  mentionnée dans la demande du club, pour tout cas que le flux public ne
  couvre pas.

Ces deux comportements (public restreint / admin toujours permissif)
partagent le **même moteur de conflit** (`determineEligibility`,
`assignTableRole`/`removeTableRole` dans `modules/tables/shared.ts`) —
jamais deux implémentations séparées des mêmes règles. Seul un paramètre
change : `blockIfHeldBySomeoneElse` (écriture) et `onlyIfLicencieId`
(retrait), tous deux `undefined`/absents côté admin.

## Jeton "toujours actif" vs "demande admin"

Tant que le jeton n'est pas révoqué, la personne peut se gérer elle-même
(auto-affectation, self-delete). Il **n'expire jamais automatiquement**
(retour du club : "jamais sauf révocation manuelle par un admin") — la
seule façon de le rendre inactif est une action explicite d'un
`club_admin` :

`POST /v1/clubs/:clubId/table-assignments/public-access/:licencieId/reset`
révoque le jeton actif du licencié (`revoked_at` rempli). Conséquences :

- Le lien personnel perdu/révoqué ne fonctionne plus (401 sur toute route
  publique).
- Le nom redevient choisissable (`claimed: false`) — la personne (ou
  quelqu'un en son nom, à vérifier hors outil) doit repasser par le lien
  commun et re-choisir son nom pour obtenir un nouveau jeton.
- **Les affectations déjà existantes de ce licencié ne sont JAMAIS
  touchées par une réinitialisation d'accès** — seul le moyen d'y accéder
  change, jamais les données elles-mêmes. Une fois qu'un nouveau jeton est
  émis pour ce même licencié, la personne peut de nouveau gérer ses
  affectations existantes normalement (l'appartenance se vérifie par
  `licencie_id`, jamais par l'identité du jeton lui-même).

`GET /v1/clubs/:clubId/table-assignments/public-access` liste, pour un
admin, qui a déjà revendiqué son nom (`claimed`, `email` optionnel fourni
à la revendication, `claimedAt`) — pour savoir qui réinitialiser en cas de
lien perdu signalé. Ces deux routes sont réservées à `club_admin`
uniquement (jamais `responsable_tables`) : c'est de la gestion
d'accès/identité, plus sensible que la simple gestion des postes.

## Base de données

Migration `20260929000000_licencie_public_access.sql` — table
`licencie_public_tokens` : `id`, `club_id`, `licencie_id`, `token_hash`,
`email` (optionnel, jamais vérifié en V1), `created_at`, `revoked_at`,
`revoked_by`.

- Index UNIQUE PARTIEL `(club_id, licencie_id) WHERE revoked_at IS NULL` —
  un seul jeton actif par licencié, une révocation libère immédiatement le
  nom pour une nouvelle revendication.
- Index UNIQUE sur `token_hash`.
- RLS activée, réservée à `club_admin` (`licencie_public_tokens_all_club_admin`)
  — **cette policy ne couvre que la gestion ADMIN**, jamais le flux public
  lui-même : celui-ci passe toujours par `createServiceSupabaseClient()`
  (bypass RLS), avec vérification manuelle du club/token dans le code
  applicatif (`modules/public-tables/routes.ts`), même précaution que
  `fbi_credentials` — voir `docs/MULTI_TENANCY.md`.

Isolation vérifiée contre un vrai PostgreSQL 16 (`supabase/tests/isolation_test.sql`,
Scénario 9) : `club_admin` peut créer/lire ses jetons, un autre club ne
les voit jamais même avec un UUID connu, un simple membre (coach) n'y a
aucun accès, et la contrainte UNIQUE partielle refuse bien un second
jeton actif pour le même licencié.

## API

Toutes les routes ci-dessous sont montées sous `/v1/public/clubs/:clubSlug`
(**jamais** `:clubId` — le slug seul est distribué dans le lien) et
n'exigent **aucun** header `Authorization` :

- `GET /` — infos club minimales (`slug`, `name`, `logoUrl`, `timezone`),
  jamais de données membre/rôle/FFBB.
- `GET /licencies` — roster pour choisir son nom (`claimed` seulement).
- `POST /licencies/:licencieId/claim` (body `{ email? }`) — mint le jeton
  personnel, renvoyé une seule fois.
- `GET /me?token=` — résout l'identité (vérification d'un lien déjà en
  poche).
- `GET /table-assignments?token=&from=&to=` — même contenu que la vue
  admin (`GET /v1/clubs/:clubId/table-assignments`), avec `me` en plus.
- `PUT /matches/:matchId/table-assignments/:role?token=` — auto-
  affectation. Le `licencieId` vient TOUJOURS du jeton, jamais du corps de
  la requête. `409 ALREADY_TAKEN_BY_SOMEONE_ELSE` si le poste appartient à
  quelqu'un d'autre.
- `DELETE /matches/:matchId/table-assignments/:role?token=` — retrait de
  SA PROPRE affectation. `403` si le poste appartient à quelqu'un d'autre.

Côté admin authentifié (sous `/v1/clubs/:clubId/table-assignments`) :

- `GET /public-access` — état des accès publics (`club_admin` uniquement).
- `POST /public-access/:licencieId/reset` — révoque le jeton actif
  (`club_admin` uniquement).

## Hors périmètre V1 (documenté, non implémenté)

- **Aucun envoi d'email automatique** du lien personnel — l'adresse email
  optionnelle collectée à la revendication est un simple champ de contact
  pour un admin, jamais utilisée pour un envoi (aucun fournisseur
  transactionnel configuré dans ce projet). Le frontend doit clairement
  inviter la personne à conserver son lien elle-même.
- **Aucune expiration automatique** du jeton — seule une révocation admin
  explicite le rend inactif (choix confirmé par le club).
- **Aucune vérification de l'identité** au moment du choix du nom — rien
  n'empêche techniquement quelqu'un de choisir le nom d'un autre licencié
  du même club avant lui ; c'est un compromis assumé pour un outil interne
  à faible enjeu (choix confirmé par le club : "il choisit son nom dans la
  liste", sans étape de vérification supplémentaire). La réinitialisation
  admin reste le filet de sécurité en cas d'usurpation constatée.
- **Aucune limitation de débit** (rate limiting) sur `POST .../claim` — un
  visiteur du lien pourrait en théorie revendiquer tous les noms restants
  avant les autres. Risque jugé faible pour un lien distribué en interne à
  un club, mais non mitigé techniquement en V1.
- Le flux public **n'expose jamais** la bascule "pas besoin d'arbitre"
  (`referee-status`) — décision organisationnelle réservée à l'admin, voir
  `docs/TABLE_ASSIGNMENTS.md`.
