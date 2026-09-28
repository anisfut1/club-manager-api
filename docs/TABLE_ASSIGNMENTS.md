# Tables de marque

Module métier majeur (demande du club, 2026-09-28) : pour chaque match du
club joué **à domicile**, affecter un licencié à chacun des 3 postes :
**marqueur** (`SCORER`), **chronométreur** (`TIMEKEEPER`) et **délégué de
club** (`CLUB_DELEGATE`).

## Principe fondamental — le logiciel suggère, le responsable décide

Le système **n'affecte jamais automatiquement** un licencié. Il calcule des
**suggestions** classées et expliquées ; seule une action humaine explicite
(un clic "Choisir" côté frontend, `PUT .../table-assignments/:role`) crée
une **affectation** réelle en base. Il n'existe :

- aucun auto-assign ;
- aucun cron d'affectation ;
- aucun job qui remplit automatiquement `table_assignments` ;
- aucun bouton/route qui affecte plusieurs postes en un seul appel.

`GET .../table-suggestions` est **strictement en lecture** : il appelle
uniquement `computeTableSuggestions` (fonction pure, aucun accès Supabase) —
voir `src/modules/tables/table-suggestion-service.ts`. Aucune ligne
`table_assignments` n'est jamais créée par un `GET`.

## Matchs à domicile uniquement

Une table de marque n'est gérée que pour les matchs du club joués **à
domicile**. Un match extérieur ne peut jamais avoir de table : le backend
refuse toute lecture (`GET .../table-suggestions`) ET écriture
(`PUT`/`DELETE .../table-assignments/:role`) pour un match dont
`is_home !== true`, avec `409 AWAY_MATCH_NOT_SUPPORTED` — jamais une
convention laissée au seul frontend. Les matchs extérieurs restent
utilisés pour détecter les indisponibilités (un licencié dont l'équipe
joue à l'extérieur au même horaire est indisponible pour une table).

## Durée d'un match — 120 minutes

Constante centralisée : `DEFAULT_MATCH_DURATION_MINUTES = 120`
(`src/modules/tables/suggestion-policy.ts`). Un match à 15:00 occupe le
créneau 15:00→17:00. `computeMatchWindow` (`match-window.ts`) est la seule
fonction qui calcule cette fenêtre — jamais un `+ 2 hours` dispersé
ailleurs dans le code.

## Détection de chevauchement

`intervalsOverlap(aStart, aEnd, bStart, bEnd)` (`match-window.ts`) :
`aStart < bEnd ET bStart < aEnd`. **Volontairement strict** (pas `<=`) :
deux créneaux qui se touchent exactement (15:00-17:00 et 17:00-19:00) ne
se chevauchent **pas** — une équipe qui joue à 17h peut faire la table du
match de 15h. C'est ce qui rend possible tout le système de priorité
"équipe adjacente" ci-dessous.

## Éligibilité (conflits durs)

`determineEligibility` (`table-suggestion-service.ts`) vérifie, dans cet
ordre :

1. **`ALREADY_ASSIGNED_ON_MATCH`** — le licencié occupe déjà un AUTRE rôle
   sur CE match (un licencié ne peut jamais cumuler 2 postes sur le même
   match). Le titulaire ACTUEL du rôle demandé n'est PAS un conflit avec
   lui-même (`isCurrentHolder: true`, utile pour "Modifier").
2. **`MATCH_CONFLICT`** — un match (domicile OU extérieur) d'une des
   équipes du licencié chevauche la fenêtre cible. C'est ce mécanisme qui
   rend l'équipe qui joue le match cible indisponible pour SA PROPRE table
   — jamais un `if candidate.team == match.team` codé en dur, ça découle
   du calcul de calendrier (le match cible est simplement l'une des
   occurrences de l'équipe qui le joue).
3. **`TABLE_ASSIGNMENT_CONFLICT`** — le licencié est déjà affecté à une
   AUTRE table de marque dont le créneau chevauche.

**Une personne peut appartenir à plusieurs équipes** : le modèle actuel
(`licencies.team_id`) ne permet qu'UNE SEULE équipe par licencié
aujourd'hui, mais le moteur est architecturé pour un tableau `teamIds:
string[]` dès maintenant — un conflit sur N'IMPORTE LAQUELLE des équipes
d'un licencié suffit à le rendre indisponible (voir le test dédié
`table-suggestion-service.test.ts`, "§8"). Aucun changement de moteur ne
sera nécessaire si le modèle de données évolue vers un rattachement
multiple.

## Classement (priority tiers)

`determinePriorityTier` classe chaque candidat SANS conflit dans l'un de
3 tiers, dans cet ordre de priorité :

1. **`ADJACENT_NEXT_HOME`** — une équipe du candidat joue à domicile juste
   APRÈS la table (le match adjacent HOME le plus proche après la fenêtre
   cible, sans chevauchement). Ex : table 15h-17h, son équipe joue
   17h-19h → "Joue juste après à 17:00".
2. **`ADJACENT_PREVIOUS_HOME`** — une équipe du candidat vient de jouer à
   domicile juste AVANT. Ex : son équipe a joué 13h-15h, table 15h-17h →
   "Vient de jouer à 13:00".
3. **`AVAILABLE_OTHER`** — aucun conflit, aucune proximité particulière.
   `POTENTIALLY_AVAILABLE`, jamais présenté comme "disponible confirmé"
   (le moteur ne connaît pas la vie personnelle du licencié).

`eligibility` exposé au frontend : `RECOMMENDED` = un des 2 tiers
adjacents ; `POTENTIALLY_AVAILABLE` = `AVAILABLE_OTHER` ; `UNAVAILABLE` =
conflit dur (avec `reasonCode` structuré, jamais juste `eligible: false`).

À priorité de tier égale, le lieu compte : un match adjacent au MÊME
gymnase (comparaison texte tolérante, `venue_raw_label`) prime sur un
match adjacent à un gymnase différent — mais ne bloque JAMAIS le candidat,
juste un bonus secondaire moindre.

## Équité, puis tie-break déterministe

Au sein d'un même tier (et à bonus de lieu égal), le nombre d'affectations
**RÉELLEMENT effectuées** cette saison (jamais les suggestions) départage
les candidats — moins de tables cette saison passe devant. Puis le nombre
d'affectations déjà faites le MÊME JOUR. Puis un tie-break déterministe
(nom, prénom, id) : à données identiques, l'ordre est toujours identique
(`rankCandidates`, comparateur multi-clés explicite — jamais une
soustraction de score, voir §22 de la demande : "pas un simple
`candidateScore = 183.742` incompréhensible").

**Ordre général complet** (§21 de la demande) :

1. élimination des conflits (`determineEligibility`)
2. équipe qui joue à domicile juste après (`ADJACENT_NEXT_HOME`)
3. équipe qui vient de jouer à domicile juste avant (`ADJACENT_PREVIOUS_HOME`)
4. même gymnase / proximité (bonus secondaire)
5. équité — nombre de tables cette saison
6. nombre de tables déjà effectuées le même jour
7. tie-break déterministe (nom, prénom, id)

La priorité métier (proximité d'un match à domicile) passe TOUJOURS avant
l'équité — un joueur jamais sollicité mais sans aucune proximité ne double
jamais un joueur déjà présent au gymnase qui joue juste après.

Le `score` numérique renvoyé dans le DTO est **cosmétique uniquement**
(`SUGGESTION_SCORE`, `suggestion-policy.ts`) : il ne sert jamais de base
au tri, qui reste toujours le comparateur explicite ci-dessus.

## Périmètre "même jour calendaire"

Le chargement des données (`load-suggestion-data.ts`) borne les matchs et
affectations pris en compte au **jour calendaire du match cible, dans le
fuseau du club** (`computeDayRange`, `util/timezone.ts`) — les exemples
métier de la demande (enchaînements 13h/15h/17h) sont toujours
intra-journée, et `intervalsOverlap` sur des fenêtres de 120 min ne peut
de toute façon jamais faire chevaucher deux jours différents.

## Absence d'auto-assignment — garanties de code

- `computeTableSuggestions`/`determineEligibility`/`rankCandidates`
  (`table-suggestion-service.ts`) sont des fonctions **pures** : aucun
  import Supabase, aucun accès réseau, aucune écriture possible même en
  théorie.
- `GET .../table-suggestions` (`routes.ts`) n'appelle QUE ces fonctions
  pures + des lectures Supabase — zéro `.insert()`/`.update()`/`.upsert()`
  dans ce handler.
- Testé explicitement : `routes.test.ts`, "§57" — le nombre de lignes
  `table_assignments` est identique avant/après plusieurs appels `GET
  .../table-suggestions`.
- La SEULE route qui écrit est `PUT .../table-assignments/:role`,
  déclenchée uniquement par une action HTTP explicite (jamais un cron,
  jamais un job interne — aucune route sous `/internal/*` ne touche
  `table_assignments`).

## Validation au moment de l'affectation (jamais de confiance différée)

`PUT .../table-assignments/:role` **recalcule toujours** les conflits au
moment de l'écriture via `determineEligibility` — jamais confiance dans le
fait qu'un candidat était disponible quelques secondes plus tôt (suggestion
périmée). En cas de conflit détecté : `409` avec le `reasonCode` structuré
(`MATCH_CONFLICT`/`TABLE_ASSIGNMENT_CONFLICT`/`ALREADY_ASSIGNED_ON_MATCH`)
et une explication humaine. **Aucun "force"/override en V1** : impossible
de créer une affectation ayant un conflit dur, même volontairement.

Réaffecter le même rôle à un AUTRE licencié **remplace** le titulaire
précédent (`upsert` sur `UNIQUE(club_id, match_id, role)`) — c'est le
mécanisme de "Modifier" côté frontend, jamais une 2e ligne.

## Conflits après modification FFBB — jamais de remplacement automatique

Si une affectation existante devient incompatible après coup (ex : FFBB
déplace le match de l'équipe du titulaire), le backend ne supprime ni ne
remplace JAMAIS cette affectation automatiquement. `GET
.../table-assignments` recalcule le conflit à CHAQUE lecture (même moteur
`determineEligibility` que les suggestions, appliqué au titulaire actuel)
et le signale (`hasConflict: true`, `conflictReason`) — le responsable
décide ensuite quoi faire, en choisissant lui-même un remplaçant via le
panel de suggestions habituel.

## Multi-tenant

`club_id` obligatoire sur `table_assignments`, RLS stricte (migration
`20260928100000_table_assignments.sql`) : lecture et écriture réservées à
`club_admin` OU `responsable_tables` du club concerné (ou
`platform_admin`) — jamais un autre club, même avec un UUID connu. Un
licencié d'un autre club référencé dans le body d'un `PUT` échoue en
`404` (recherche explicitement scopée à `club_id = ce club` avant tout
`insert`/`upsert`), jamais une affectation cross-tenant silencieuse. Voir
`supabase/tests/isolation_test.sql`, "Scénario 8" (6 assertions
PostgreSQL réelles).

## Rôle `responsable_tables`

`responsable_tables` existait déjà dans `club_role` depuis la migration
multi-tenant (2026-09-21) mais n'avait encore jamais été exploité par
aucun module. C'est ce module qui l'active pour la première fois
(`requireAnyClubRole(["club_admin", "responsable_tables"])`,
`auth/middleware.ts`) — pas de nouveau système de rôles créé.

## API

- `GET /v1/clubs/:clubId/table-assignments?from=&to=` — matchs à domicile
  du club (par défaut : à venir), avec leurs 3 postes (affectés ou "à
  attribuer") et un `hasConflict` par match.
- `GET /v1/clubs/:clubId/matches/:matchId/table-suggestions?role=SCORER` —
  candidats classés (recommandés/disponibles/indisponibles) pour ce rôle
  sur ce match. `role` obligatoire (une route par rôle, contrat le plus
  simple pour le frontend qui ouvre toujours un panel pour UN rôle à la
  fois).
- `PUT /v1/clubs/:clubId/matches/:matchId/table-assignments/:role` (body
  `{ licencieId }`) — crée/remplace l'affectation. `409` en cas de
  conflit recalculé.
- `DELETE /v1/clubs/:clubId/matches/:matchId/table-assignments/:role` —
  remet le poste à "à attribuer".

## Base de données

Table `table_assignments` (migration `20260928100000_table_assignments.sql`) :
`id`, `club_id`, `match_id`, `licencie_id`, `role`
(`SCORER`/`TIMEKEEPER`/`CLUB_DELEGATE`), `created_by`, `created_at`,
`updated_at`. Deux contraintes `UNIQUE` :

- `(club_id, match_id, role)` — un seul licencié par poste.
- `(club_id, match_id, licencie_id)` — un licencié ne peut jamais cumuler
  2 postes sur le même match.

Toute affectation est **MANUELLE** par construction en V1 : pas de colonne
`source` (elle ne vaudrait jamais que `'MANUAL'`, information sans valeur
ajoutée).

## Points d'extension futurs (documentés, non implémentés en V1)

- **Temps de trajet** (§15 de la demande) : `DEFAULT_TRAVEL_BUFFER_MINUTES
  = 0` (`suggestion-policy.ts`). `computeMatchWindow` accepte déjà un
  3e paramètre `travelBufferMinutes` qui étend la fenêtre des deux côtés
  avant le test de chevauchement — le jour où une valeur
  club/équipe/type-de-match existera, il suffira de la passer à cette
  fonction, aucun autre changement de moteur.
- **Compétences par poste** (§25) : aucune donnée de compétence n'existe
  aujourd'hui (pas de "sait faire marqueur"/"niveau e-Marque"). Le moteur
  n'en a pas besoin pour fonctionner (il reste "role-aware" via
  `targetRole`, sans jamais fabriquer de compétence fictive) ; une future
  table de compétences pourrait filtrer/pondérer `candidates` en amont de
  `computeTableSuggestions` sans changer sa signature.
- **Délégué de club** (§26) : aucune règle FFBB d'âge/qualification
  n'est appliquée en V1 — un licencié potentiellement disponible peut être
  suggéré pour `CLUB_DELEGATE` comme pour les 2 autres rôles. Une future
  règle d'éligibilité spécifique se brancherait dans
  `determineEligibility` sans changer le reste du moteur.

## Non fait volontairement en V1

Notifications (email/WhatsApp/SMS), disponibilités déclaratives joueur,
validation joueur, échange de table entre joueurs, temps de trajet
automatique, règles d'âge complexes, IA/LLM, affectation automatique ou
en masse.
