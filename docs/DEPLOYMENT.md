# Déploiement — Vercel + Supabase, rien d'autre

Aucune infrastructure externe. Pas de Railway, Render, Fly.io, ni aucun
serveur à provisionner (§ contrainte fondamentale de cette migration).

## Prérequis

- Un projet Vercel (import direct du repository GitHub
  `club-manager-api`, sans étape supplémentaire).
- **Le même projet Supabase que le frontend `SCSB`** — pas un nouveau
  projet. La séparation introduite par cette migration concerne le code,
  jamais les données (§ instruction explicite de la demande).
- Les migrations `supabase/migrations/` de ce repository doivent être
  appliquées sur ce projet Supabase (via `supabase db push` ou la CLI
  habituelle) — elles reprennent l'historique complet depuis SCSB, jamais
  fusionnées en un seul fichier (voir `docs/MIGRATION.md`).

## Étapes

1. **Importer** le repository dans Vercel (Nouveau projet → sélectionner
   `club-manager-api`). Aucune configuration de build particulière n'est
   requise au-delà de ce que `vercel.json` fournit déjà.
2. **Renseigner les variables d'environnement** (voir la liste complète
   ci-dessous et `.env.example`) dans les réglages du projet Vercel —
   jamais committées.
3. **Déployer**. Vercel construit `api/index.ts` comme Function unique
   (voir `vercel.json` — `rewrites` route tout vers `/api`,
   `functions."api/index.ts".maxDuration: 300`) et active automatiquement
   les 4 crons déclarés dans `vercel.json`.
4. **Configurer `FRONTEND_ORIGINS`** avec l'URL du déploiement Vercel du
   frontend SCSB (jamais de wildcard, voir `docs/API.md`).
5. **Vérifier** `GET /health` (sans authentification) puis
   `GET /openapi.json`.

`npm run build` en local est une vérification de compilation uniquement
(`tsc --noEmit` + vérification que `dist/` se génère) — Vercel bundle
`api/index.ts` lui-même avec son propre pipeline (esbuild) au moment du
déploiement ; le `dist/` local n'est jamais déployé tel quel (voir
`.gitignore`).

## Variables d'environnement requises

| Variable | Rôle |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase (le même que SCSB) |
| `SUPABASE_ANON_KEY` | Clé anonyme — utilisée avec le JWT utilisateur pour les requêtes "au nom de l'utilisateur" (voir `docs/AUTH.md`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service role — jamais exposée au frontend, utilisée uniquement pour les tables sans policy `authenticated` et Storage |
| `FBI_CREDENTIALS_ENCRYPTION_KEY` | Clé AES-256-GCM (32 octets) pour `fbi_credentials` |
| `CRON_SECRET` | Secret partagé (min. 16 caractères) protégeant `/internal/*` — Vercel Cron l'envoie automatiquement en `Authorization: Bearer` pour ses propres appels programmés |
| `FRONTEND_ORIGINS` | Liste d'origines autorisées en CORS, séparées par des virgules |
| `BROWSER_FBI_ENABLED` | `true`/`false` (défaut `false`) — active `BrowserFbiClient` (voir `docs/FBI.md`) |
| `FBI_BASE_URL` | URL de base FBI (a une valeur par défaut, surchargeable) |

Validées au démarrage par `src/config/env.ts` (zod) — une variable
manquante ou invalide fait échouer le démarrage immédiatement plutôt
qu'en cours de requête.

## Crons (déjà déclarés dans `vercel.json`)

```json
"crons": [
  { "path": "/internal/cron/ffbb", "schedule": "*/15 * * * *" },
  { "path": "/internal/cron/fbi-enqueue", "schedule": "0 * * * *" },
  { "path": "/internal/cron/fbi-jobs", "schedule": "*/5 * * * *" },
  { "path": "/internal/cron/emarque-parse", "schedule": "*/10 * * * *" }
]
```

Rien à configurer côté Vercel au-delà de l'import — les crons sont créés
automatiquement au déploiement à partir de ce fichier.

## Ce que ce déploiement NE fait PAS

- Ne crée pas de nouveau projet Supabase.
- Ne provisionne rien en dehors de Vercel (pas de VM, pas de container
  long-running, pas de queue externe).
- Le frontend SCSB n'est pas concerné par ce déploiement — c'est un
  projet Vercel strictement séparé (§ "Ne modifie PAS encore le
  frontend").
