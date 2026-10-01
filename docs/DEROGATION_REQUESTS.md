# Demandes de dérogation internes (coach → coordinateur)

Retour du club, 2026-10-01. Une **demande de dérogation** est une demande
INTERNE faite par un coach au coordinateur du club. Ce n'est **pas** la
dérogation officielle FFBB/FBI (`fbi_derogation_checks`, voir `FBI.md`).

> Le logiciel ORGANISE, VÉRIFIE et FACILITE LA COMMUNICATION.
> Le coordinateur DÉCIDE et effectue la dérogation officielle.

Aucune route de ce module n'écrit sur FFBB/FBI, n'enfile de job FBI ni ne
modifie `matches` (testé : `routes.test.ts`, « aucune écriture externe »).

## Rôles (RBAC existant `membership_roles`)

| Acteur | Rôle technique | Droits |
|---|---|---|
| Coach | `coach` (`scope_team_id` = équipe, `NULL` = toutes) | crée, suit, répond, repropose, annule les demandes de ses équipes |
| Coordinateur (libellé UI) | `correspondant_club` | inbox de toutes les demandes du club, « Je m'en occupe », « Pas possible », « Traitée » |
| Administrateur | `club_admin` | mêmes droits que le coordinateur + création |

Les rôles s'attribuent via `GET/POST /v1/clubs/:clubId/members` et
`PUT /v1/clubs/:clubId/members/:membershipId/roles` (`club_admin`). Sans
aucun `correspondant_club` actif, la création est refusée :
« Aucun coordinateur n'est actuellement configuré pour recevoir les demandes de dérogation. »

## Modèle

- `club_venues` — gymnases du club, reliés au référentiel FFBB `venues`
  (`venue_id`, jamais dupliqué). Rempli depuis les matchs à domicile (migration
  + chaque synchronisation FFBB, `ensureClubVenues`) ; multi-club (1…n gymnases).
- `club_scheduling_rules` — plage d'heures de DÉPART par jour (0 = dimanche).
  SC Sète : samedi 13:00 → 21:00, dimanche 09:00 → 16:00. Jour sans règle :
  aucune restriction horaire (semaine en V1).
- `derogation_requests` — une demande ; **une seule ACTIVE par match** (index
  unique partiel sur `REQUESTED|IN_PROGRESS|NEEDS_CHANGE`). Snapshot :
  `original_scheduled_at`, `original_venue_id`, `requester_display_name`.
- `derogation_proposals` — historique des créneaux proposés (jamais écrasé).
- `derogation_messages` — conversation `USER` + événements `SYSTEM`, immuable.

## Créneaux — source de vérité unique

`src/scheduling/match-slot.ts` (partagé avec les Tables de marque et les
dérogations FBI) : un match occupe `[start ; start + 120 min)`, conflit si
`aStart < bEnd && bStart < aEnd` (15h–17h et 17h–19h compatibles ; 15h–17h et
16h–18h en conflit). Pas des heures proposées : 60 min.

## Disponibilité (`availability.ts`, fonctions pures)

- **Hard conflict** `VENUE_MATCH` : match programmé dans le même gymnase qui chevauche.
- **Hard conflict** `TEAM_MATCH` : l'équipe a déjà un autre match qui chevauche (domicile ou extérieur).
- **Soft warning** `PENDING_REQUEST` : une autre demande active vise ce gymnase/créneau (le créneau reste sélectionnable).
- Le match cible est toujours exclu de l'occupation.
- Domicile : gymnase obligatoire + plage du jour si configurée. Extérieur : pas
  de gymnase ni de plage, seul le conflit d'équipe compte.
- Toute création / nouvelle proposition **recalcule** la disponibilité côté
  serveur : `409 DEROGATION_SLOT_CONFLICT` (avec `error.details.conflicts`).
- Dates/heures calculées dans `clubs.timezone` (jamais le fuseau du navigateur).

## Statuts

| Action | Depuis | Vers | Qui |
|---|---|---|---|
| (création) | — | `REQUESTED` | coach / admin |
| `TAKE_IN_CHARGE` | `REQUESTED`, `NEEDS_CHANGE` | `IN_PROGRESS` | coordinateur / admin |
| `REQUEST_CHANGE` (message obligatoire, sinon 422) | `REQUESTED`, `IN_PROGRESS` | `NEEDS_CHANGE` | coordinateur / admin |
| `COMPLETE` | `IN_PROGRESS` | `COMPLETED` | coordinateur / admin |
| `CANCEL` | actifs | `CANCELLED` | demandeur, coach de l'équipe, coordinateur |
| nouvelle proposition | `REQUESTED`, `NEEDS_CHANGE` | `REQUESTED` | côté coach |

`COMPLETED` = workflow interne terminé (jamais une confirmation FFBB simulée).
Si la FFBB synchronise ensuite une nouvelle date, `officialSchedule` l'indique
(`changedSinceRequest`, `matchesCurrentProposal`) sans changer le statut.

## API

- `GET /v1/clubs/:clubId/derogation-requests/context`
- `GET|POST /v1/clubs/:clubId/derogation-requests`
- `GET /v1/clubs/:clubId/derogation-requests/:requestId`
- `POST .../:requestId/messages` · `.../:requestId/actions` · `.../:requestId/proposals`
- `GET /v1/clubs/:clubId/matches/:matchId/derogation-availability?date=YYYY-MM-DD`
- `GET /v1/clubs/:clubId/matches/:matchId/derogation-slot-check?startAt=&venueId=`

## RLS

Lecture : `can_read_derogation_request(club_id, team_id, created_by)` (coordinateur
/ club_admin du club, auteur, coach de l'équipe). Aucune écriture directe pour
`authenticated` (tout passe par l'API, rôle service). Testé contre PostgreSQL :
`supabase/tests/isolation_test.sql`, scénario 10.
