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

**PREPARED** — la logique de mapping/diff/idempotence est testée
unitairement (`integrations/ffbb/mapping.test.ts`, 100% pur, aucun accès
réseau), mais aucun appel réel contre `api.ffbb.app` n'a été fait depuis un
environnement de développement (réseau `*.ffbb.com` bloqué dans tous les
environnements où ce code a été écrit — voir le premier spike côté SCSB,
`docs/FFBB_ECOSYSTEM_RESEARCH.md`, conservé dans SCSB). Les noms de champs
et endpoints sont ceux confirmés par recoupement de bibliothèques clientes
open source indépendantes dans ce même document, jamais observés en direct
depuis cette session.

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
