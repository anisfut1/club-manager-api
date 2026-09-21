# API

Spec complète et à jour : `GET /openapi.json` (générée depuis `src/contracts/*.ts`
via `src/openapi.ts`) ou `GET /docs` (Swagger UI). Ce document donne la vue
d'ensemble ; ne le laisse pas diverger de la génération automatique — en
cas de doute, la spec générée fait foi.

## Versionnage

Toutes les routes destinées au frontend sont sous `/v1/...`. Une route
n'existe que si elle correspond à un vrai service déjà construit — voir
`docs/MIGRATION.md` pour ce qui a été volontairement laissé de côté.

## Routes `/v1`

| Méthode | Route | Rôle requis |
|---|---|---|
| GET | `/v1/me` | authentifié |
| GET | `/v1/clubs` | authentifié (clubs dont il est membre) |
| GET | `/v1/clubs/:clubId` | membre du club |
| GET | `/v1/clubs/:clubId/capabilities` | membre du club |
| GET | `/v1/clubs/:clubId/teams` | membre du club |
| GET | `/v1/clubs/:clubId/matches` | membre du club |
| GET | `/v1/clubs/:clubId/matches/:matchId` | membre du club |
| GET | `/v1/clubs/:clubId/matches/:matchId/documents` | membre du club (URL de téléchargement réservée à club_admin) |
| GET | `/v1/clubs/:clubId/integrations` | membre du club |
| POST | `/v1/clubs/:clubId/integrations/fbi` | club_admin |
| POST | `/v1/clubs/:clubId/integrations/fbi/test` | club_admin |
| POST | `/v1/clubs/:clubId/integrations/ffbb/sync` | club_admin |
| GET | `/v1/clubs/:clubId/sync-runs` | membre du club |
| GET | `/v1/clubs/:clubId/issues` | membre du club |
| POST | `/v1/clubs/:clubId/issues/:matchId/resolve` | club_admin |
| GET | `/v1/jobs/:jobId` | authentifié (RLS filtre par club) |
| GET | `/v1/platform/clubs` | platform_admin |
| POST | `/v1/platform/clubs` | platform_admin |

`:clubId` accepte un UUID ou un slug (voir `tenancy/club-context.ts`).

## Routes `/internal`

Jamais sous `/v1`, jamais appelables par un utilisateur classique — voir
`docs/JOBS.md`. Protégées par `Authorization: Bearer <CRON_SECRET>`.

| Route | Rôle |
|---|---|
| GET `/internal/cron/ffbb` | synchronise un petit lot de clubs dus |
| GET `/internal/cron/fbi-enqueue` | empile des jobs `discover_emarque` |
| GET `/internal/cron/fbi-jobs` | réclame et traite un petit lot de jobs FBI |
| GET `/internal/cron/emarque-parse` | parse les documents e-Marque téléchargés |

## Async (§36)

Une opération potentiellement longue (ex : test de connexion FBI par
navigateur en secours) répond `202 { jobId }` plutôt que de garder la
connexion HTTP ouverte. Le frontend interroge ensuite `GET /v1/jobs/:jobId`.

## Erreurs

Contrat uniforme, jamais de stack trace en production :

```json
{ "error": { "code": "FORBIDDEN", "message": "Ce rôle (club_admin) est requis sur ce club." } }
```

Codes : `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`BAD_REQUEST` (400), `CONFLICT` (409), `INTERNAL_ERROR` (500).

## CORS

`FRONTEND_ORIGINS` (liste séparée par des virgules) — jamais de wildcard
avec authentification (voir `src/app.ts`).
