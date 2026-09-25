# Équipes

Demande du club (2026-09-25) : sectoriser le roster (licenciés) et le
calendrier (matchs) par équipe — 14 catégories au club pilote (U9,
U11M-1, U11M-2, U11F, U13M, U13F, U15M-1, U15M-2, U15F, U18M, U18F, SM1,
SM2, SM3, SF), dont certaines n'ont pas encore d'engagement FFBB confirmé
en début de saison (phase de "brassage").

## Le bug découvert avant de construire quoi que ce soit

`teams` (une équipe interne au club, existe indépendamment de tout
engagement FFBB — voir `supabase/migrations/20260921090000_teams.sql`)
était auto-créée à la volée par la synchro FFBB
(`resolveTeamForEngagement`, `src/integrations/ffbb/sync.ts`), résolue et
créée par un NOM dérivé UNIQUEMENT de la catégorie + numéro d'équipe
(ex. "U11 1") — **jamais le sexe**. Deux engagements FFBB de sexes
différents partageant le même numéro (ex. Seniors 1 masculine ET
féminine) généraient donc le MÊME nom et fusionnaient silencieusement
dans LA MÊME ligne `teams`, donc sous le même `matches.team_id`.

Constaté en production sur le club pilote : **5 équipes fusionnées à
tort** (Seniors 1, U11 1, U13 1, U15 1, U18 1), 57 matchs au total
mal regroupés — jamais perdus : `matches.competition_id` a toujours
pointé vers la bonne compétition (donc le bon sexe), indépendamment de ce
bug de regroupement, ce qui a permis une correction sans aucune perte de
donnée.

**Corrigé** :
- `teams` gagne deux colonnes, `sexe` (`'M'`/`'F'`/`null`) et
  `numero_equipe` (texte libre, ex. `"1"`) — voir migration
  `20260925100000_teams_gender_split_and_licencie_team.sql`.
- `resolveTeamForEngagement` résout/crée désormais par
  **(club_id, category, sexe, numero_equipe)**, jamais par le nom :
  `teams.name` redevient un simple libellé affichable, librement
  renommable par un·e club_admin sans jamais casser la synchro FFBB
  (contrairement à avant, où renommer une équipe aurait fait perdre sa
  correspondance avec les futurs engagements).
- La même migration **sépare** les 5 équipes déjà fusionnées : le sexe
  totalisant le plus de matchs reste sur la ligne existante (nom
  inchangé, aucune rupture pour l'historique déjà affiché), l'autre sexe
  migre vers une nouvelle ligne — ses engagements et ses matchs
  réaffectés via leur compétition d'origine.
- Régression testée : `src/integrations/ffbb/sync.test.ts`
  (`resolveTeamForEngagement`), notamment le cas exact du bug (deux
  sexes, même numéro → deux équipes distinctes).

## Enregistrer une équipe AVANT tout engagement FFBB (brassage)

Nouvelles routes (`club_admin`, `src/modules/clubs/routes.ts`) :

```
GET   /v1/clubs/:clubId/teams              -- TOUTES les équipes, y compris sans aucun match
POST  /v1/clubs/:clubId/teams              -- créer manuellement
PATCH /v1/clubs/:clubId/teams/:teamId      -- renommer/reclasser/activer-désactiver
```

`POST`/`PATCH` acceptent `category`/`sexe`/`numeroEquipe` — les renseigner
dès la création manuelle permet à `resolveTeamForEngagement` de
**retrouver et réutiliser cette même équipe** une fois l'engagement FFBB
confirmé (brassage terminé), plutôt que d'en créer une en double.

RLS inchangée pour ces routes (`teams_all_club_admin`, déjà en place
depuis la migration multi-tenant) : écrites via le client "au nom de
l'utilisateur", jamais le rôle service — la RLS garantit déjà qu'un seul
`club_admin` de CE club peut écrire.

## Roster sectorisé par équipe

`licencies` gagne `team_id` (nullable, `on delete set null`). Renseigné
**automatiquement** à l'auto-provisionnement d'un licencié depuis
e-Marque (voir `docs/LICENCIES.md`) : `persist-emarque-match.ts` lit
`matches.team_id` du match d'origine et le reporte directement sur le
nouveau `licencies` — jamais réécrit ensuite automatiquement (un·e
joueur·se qui joue occasionnellement dans une autre catégorie ne doit
jamais voir son équipe "principale" silencieusement changée par un match
ponctuel).

Modifiable via `PATCH .../licencies/:licencieId/profile` (`teamId`,
champ **admin uniquement** — jamais le licencié lui-même, voir
`docs/LICENCIES.md`) : le serveur vérifie que l'équipe fournie appartient
bien à CE club avant d'écrire (jamais un rattachement cross-tenant
silencieux, même par erreur d'un club_admin).

## Ce qui n'est PAS fait

- Le calendrier (liste des matchs) accepte déjà `?teamId=` en filtre
  (`GET /v1/clubs/:clubId/matches`, voir `docs/API.md`) — une équipe
  créée manuellement sans engagement apparaît donc dans ce filtre, mais
  n'aura évidemment aucun match tant qu'aucun n'est synchronisé.
- Pas de fusion/suppression d'équipe depuis l'API (seulement
  création/renommage/désactivation) — une équipe mal créée reste
  visible (désactivable via `active: false`), jamais supprimée
  automatiquement.
