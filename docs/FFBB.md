# FFBB — intégration de base (obligatoire)

Chaque club fonctionne avec UNIQUEMENT FFBB (mode `PUBLIC_ONLY`) : calendrier,
équipes, compétitions, dates/horaires/salles, adversaires, scores,
classements si disponibles. Aucune erreur parce que FBI est absent — voir
`docs/FBI.md`.

## Composants

- `integrations/ffbb/directus-client.ts` — client HTTP bas niveau vers
  l'API publique Directus de FFBB (`api.ffbb.app`), jeton public mis en
  cache en mémoire (15 min).
- `integrations/ffbb/public-provider.ts` (`FfbbPublicProvider`) — normalise
  les formes brutes Directus en DTO stables (`NormalizedMatch`,
  `NormalizedCompetition`, ...). Le reste de l'app ne connaît jamais le
  format brut FFBB.
- `integrations/ffbb/mapping.ts` — fonctions pures : `NormalizedMatch` →
  ligne `matches` upsertable, détection de changement de champ suivi
  (`diffTrackedFields`), déclenchement e-Marque (`shouldRequestEmarque`).
- `integrations/ffbb/sync.ts` (`syncFfbb`) — orchestration pour UN club :
  upsert idempotent (jamais de `DELETE`+`INSERT`), historise chaque
  changement détecté dans `match_change_history`.
- `integrations/ffbb/scheduler.ts` (`syncAllDueClubs`) — sélectionne les
  clubs dus (`ffbb_enabled = true AND next_sync_at <= now()`), verrouille
  chacun (`try_acquire_sync_lock`), synchronise, décale son échéance.

## Statut

**PREPARED, corrigé après 4 déclenchements réels en production (à
reconfirmer par un cron réussi)** — la logique de mapping/diff/idempotence
est testée unitairement
(`integrations/ffbb/mapping.test.ts`, 100% pur, aucun accès réseau), mais
aucun appel réel contre `api.ffbb.app` n'a pu être fait depuis un
environnement de développement (réseau `*.ffbb.app` bloqué dans tous les
environnements où ce code a été écrit et testé, y compris les sandbox
utilisées pour le déploiement — voir le premier spike côté SCSB,
`docs/FFBB_ECOSYSTEM_RESEARCH.md`, conservé dans SCSB). Les noms de champs
et endpoints sont ceux confirmés par recoupement de bibliothèques clientes
open source indépendantes dans ce même document, jamais observés en direct.

Premier déclenchement réel du cron `/internal/cron/ffbb` en production :
échec avec `FfbbApiError: Jeton API absent de la réponse de configuration
FFBB`. Un premier renforcement diagnostique (lecture du corps en texte brut
avant `JSON.parse`, recherche par motif de clé) a confirmé, via les logs
Vercel du déclenchement suivant, que **`data.api_bearer_token` n'existe
tout simplement pas** dans la vraie réponse de `items/configuration`. Les
clés réellement présentes (2026-09-22, en production) :

```text
date_created, date_updated, id, key_dh, key_ms, user_created, user_updated,
ios_version, android_version, key_directus_website, key_directus_competitions,
force_ms_reindex
```

Aucune ne contient littéralement le mot "token" — la forme documentée dans
`docs/FFBB_ECOSYSTEM_RESEARCH.md` §3.2 (déduite par recoupement de 3
bibliothèques clientes tierces) ne correspond pas au contrat réel actuel.
`key_ms` est manifestement le jeton Meilisearch (hors périmètre
`items/*`) ; les 3 autres candidats plausibles pour l'authentification des
collections `items/ffbbserver_*` sont `key_dh` ("Data Hub", terme employé
dans la recherche §2), `key_directus_website` et `key_directus_competitions`
— sans certitude sur lequel est le bon pour quelle collection.

**Solution retenue : découverte automatique, pas une nouvelle supposition
figée.** `FfbbDirectusClient.listItems` essaie chaque candidat
(`key_directus_competitions`, `key_dh`, `key_directus_website`, `key_ms`,
dans cet ordre) **contre le vrai endpoint demandé** jusqu'à obtenir un
succès HTTP, met en cache le champ gagnant (`logInfo("Jeton API FFBB
confirmé", { fieldName })` — à chercher dans les logs pour confirmer
lequel fonctionne réellement), et retente une découverte complète si le
jeton en cache se met soudain à échouer en 401/403 (rotation côté FFBB).
Si aucun candidat n'authentifie, l'erreur reste exploitable (dernière
erreur HTTP rencontrée). Voir `directus-client.test.ts` pour la couverture
de cette logique (mock de `fetchImpl`, aucun accès réseau réel).

**Deuxième déclenchement réel (même jour) : `key_dh` confirmé sur
`items/ffbbserver_organismes`, puis 401 sur TOUS les candidats pour
`items/ffbbserver_rencontres` immédiatement après** (log `"Jeton API FFBB
confirmé"` avec `fieldName: "key_dh"` suivi, moins d'une seconde plus tard,
de l'échec total de `listMatchesForOrganisme`). Signature typique d'un
throttling passager (voir §10 de la recherche : "aucune documentation de
rate-limit trouvée") plutôt qu'un vrai jeton invalide — le jeton qui vient
de réussir ne peut pas être structurellement interdit sur une collection
sœur une seconde plus tard. Cause la plus probable : `fetchClubSnapshot`
lançait `listEngagements` et `listMatchesForOrganisme` en **parallèle**
(`Promise.all`) juste après l'appel `organismes`, créant une rafale de
requêtes. Deux corrections complémentaires :
1. `fetchClubSnapshot` (public-provider.ts) n'utilise plus `Promise.all` —
   tous les appels sont désormais strictement séquentiels, espacés de
   `FFBB_REQUEST_SPACING_MS` (200 ms).
2. `listItems` espace ses tentatives de candidats successives
   (`candidateRetryDelayMs`, 300 ms par défaut) et, lors d'une
   redécouverte, retente en PREMIER le dernier champ qui a fonctionné
   (`lastKnownGoodField`) plutôt que de repartir de l'ordre fixe — moins de
   requêtes en rafale si la cause est bien un throttling passager.

**Troisième déclenchement réel (même jour, après déploiement des
espacements) : échec IDENTIQUE** — `key_dh` confirmé sur `organismes`,
puis 401 sur les 4 candidats pour `rencontres`, malgré des appels
strictement séquentiels (plus de `Promise.all`, confirmé par la stack
trace qui ne mentionne plus `Promise.all`) et des délais de 200 ms/300 ms
entre chaque tentative. **La piste throttling est donc écartée** : un
throttling passager n'aurait pas dû résister à trois tentatives espacées
de plusieurs secondes chacune. Le 401 sur `items/ffbbserver_rencontres`
est reproductible et spécifique à cette collection/requête, pas à une
histoire de cadence.

Hypothèse retenue, non encore confirmée (réseau `api.ffbb.app` toujours
inaccessible depuis tous les environnements de développement disponibles) :
`listMatchesForOrganisme` est le seul appel à demander des champs de
relation imbriqués sur 2 niveaux (`salle.commune.libelle`, voir
`RENCONTRE_FIELDS`) et un filtre `_or` combinant deux conditions — tous
les autres appels (`organismes`, `engagements`, `competitions`, `poules`)
utilisent des champs plats et un filtre `_eq`/`_in` simple. Le système de
permissions Directus est fin (par champ, par relation) : il est plausible
que le rôle public associé à ces jetons n'autorise pas la traversée de
relation `salle → commune → libelle`, et que Directus rejette alors TOUTE
la requête plutôt que d'omettre silencieusement le champ non autorisé.

**Corrigé en conséquence** (`directus-client.ts`, `request()`) : le corps
de la réponse d'erreur Directus (400 premiers caractères) est maintenant
inclus dans le message de `FfbbApiError`, et chaque candidat rejeté est
loggé individuellement (`logInfo("Jeton API FFBB candidat rejeté", {
fieldName, errorMessage })`) — Directus renvoie quasi toujours
`errors[].message`/`extensions.code` qui nomme explicitement la vraie
cause (permission refusée sur tel champ, filtre non autorisé, jeton
invalide...). **Ceci est la seule vraie inconnue restante** : le prochain
déclenchement donnera enfin le texte d'erreur réel de Directus au lieu
d'un simple code 401 — à lire en priorité avant toute nouvelle
supposition sur les champs/filtre.

**Quatrième déclenchement réel : cause confirmée avec certitude, hypothèse
validée.** Le corps de réponse Directus (candidat `key_directus_website`,
403) :

```json
{"errors":[{"message":"You don't have permission to access field \"nom\" in collection \"ffbbserver_salles\" or it does not exist. Queried in \"salle\".","extensions":{"code":"FORBIDDEN"}}]}
```

Confirme exactement l'hypothèse ci-dessus : le rôle public associé à ces
jetons n'a pas le droit de lire les champs de la relation `salle` (au
minimum `nom`, probablement aussi `commune.libelle`), et Directus rejette
alors TOUTE la requête `items/ffbbserver_rencontres` plutôt que d'omettre
silencieusement le champ non autorisé. (Le candidat `key_ms` a échoué
séparément avec `"Invalid user credentials."` / `INVALID_CREDENTIALS` —
attendu, `key_ms` est le jeton Meilisearch, hors périmètre `items/*`, voir
plus haut.)

**Corrigé** (`public-provider.ts`, `RENCONTRE_FIELDS`) : les champs
`salle.id`/`salle.nom`/`salle.commune.libelle` sont retirés, remplacés par
le champ plat `salle` seul — Directus renvoie alors l'identifiant brut de
la relation (FK) sans l'étendre, un cas déjà géré par `normalizeVenue()`
(dégrade proprement : `venue.ffbbId` renseigné, `name`/`commune` à
`null`, plutôt que de faire échouer tout `syncFfbb` pour un champ annexe).
Couvert par `public-provider.test.ts` : vérifie que la requête générée ne
contient plus `salle.nom`/`salle.commune`/`salle.id`, et que la
normalisation d'une salle reçue comme FK brute ne plante pas.

Salle/commune du gymnase resteront `null` tant que cette permission n'est
pas élargie côté FFBB (hors de notre contrôle) — n'affecte ni le
calendrier, ni les scores, ni les adversaires, le cœur du Module 1.

**Piste documentée pour une amélioration future (nom/adresse des
salles) :** la page PyPI du SDK tiers `ffbb-data-client` (2026, non
auditée, à vérifier avant tout usage) sépare explicitement l'API Directus
(`items/*`, ce que ce projet utilise) de la **recherche Meilisearch**
(`search_salles()`, "Résolution physique complète : Gymnase, Rue, CP,
Ville") — cohérent avec `key_ms` (déjà identifié comme jeton Meilisearch,
distinct de `key_dh`/`key_directus_competitions`/`key_directus_website`).
Hypothèse : le nom/l'adresse d'une salle se résout via une requête vers
`https://meilisearch-prod.ffbb.app/` (base URL différente de
`api.ffbb.app`, format de requête Meilisearch, pas Directus REST) avec
`key_ms`, plutôt que via la relation Directus qu'on vient de désactiver.
Non implémenté ici (nouveau client HTTP, nouveau format de requête,
scope distinct) — à construire séparément si le nom des gymnases devient
un besoin réel, jamais avant d'avoir confirmé que le cœur du sync
(calendrier/scores/adversaires) fonctionne.

**Cinquième déclenchement réel : le fetch FFBB passe entièrement**
(`organismes`, `engagements`, `rencontres`, `competitions`, `poules` — plus
aucune erreur 401/403) — nouvel échec, cette fois dans NOTRE code
d'écriture en base : `Upsert compétition ... échoué : invalid input
syntax for type boolean: "AFF"`. `RawCompetition.publicationInternet`
était déclaré `boolean` (doc tierce jamais vérifiée en direct, comme
`api_bearer_token` et `salle.nom` avant lui) mais la vraie API renvoie une
**chaîne** (`"AFF"`, vraisemblablement "Affiché") — passée telle quelle à
`publication_internet boolean not null default true` (colonne Postgres),
elle fait planter l'upsert.

**Corrigé** (`public-provider.ts`) : `liveStat`/`emarqueV2`/
`publicationInternet` typés `unknown` (plus `boolean`) dans
`RawCompetition`, et `publicationInternet` converti explicitement
(`row.publicationInternet == null ? true : Boolean(row.publicationInternet)`)
au lieu du `?? true` seul qui laissait passer toute valeur non-null telle
quelle. Ce champ n'est stocké qu'à titre informatif (jamais utilisé pour
filtrer, voir `sync.ts`) : `Boolean("AFF")` → `true` est acceptable sans
connaître tous les codes possibles. Couvert par 2 nouveaux tests
(`public-provider.test.ts`) : conversion d'une chaîne reçue en vrai
booléen, et valeur par défaut quand le champ est absent.

## Cron

`GET /internal/cron/ffbb` (toutes les 15 minutes, voir `vercel.json`) :

```sql
select id, ffbb_club_id from clubs
where status = 'active' and ffbb_enabled = true
  and (ffbb_next_sync_at is null or ffbb_next_sync_at <= now())
limit 20  -- FFBB_SYNC_BATCH_SIZE, voir integrations/ffbb/config.ts
```

Batch volontairement petit (§27/§29 de la demande) : le cron suivant
reprend les clubs non traités, jamais une boucle qui traite tout en une
seule invocation.

## API frontend (gap 2 résolu)

`ClubDto` expose le code club FFBB sous le nom explicite `ffbbClubCode`
(jamais `ffbbClubId`, pour ne pas le confondre avec l'UUID interne du
club). Le changer passe par une route dédiée, pas par
`PATCH /v1/clubs/:clubId` :

```
PATCH /v1/clubs/:clubId/integrations/ffbb
{ "clubCode"?: string, "enabled"?: boolean }
```

`club_admin` uniquement (service role côté serveur : `ffbb_club_id`/
`ffbb_enabled`/`ffbb_next_sync_at` ne sont pas des colonnes accordées à
`authenticated`, voir `docs/API.md`). Ne supprime jamais l'historique déjà
synchronisé (aucun `DELETE` sur `matches`) ; un changement de code
replanifie `ffbb_next_sync_at = now()` pour resynchroniser au prochain
passage du cron. Voir `docs/API.md` pour le détail des 8 gaps résolus.
