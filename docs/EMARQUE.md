# e-Marque — documents et statistiques de match

Pipeline d'enrichissement, dépendant de FBI (`FBI_ENHANCED`) — jamais requis
pour qu'un club fonctionne (voir `docs/FBI.md`, `docs/FFBB.md`).

## Vue d'ensemble

```
BrowserFbiClient.findEmarqueDocuments()  (§ discover, job "discover_emarque")
  → téléchargement (context.request.get(), cookies de session réutilisés)
  → Supabase Storage (bucket privé "emarque")
  → match_documents (manifeste, un enregistrement par fichier)
  → job "parse_document" empilé
  → integrations/emarque/parser.ts (job "parse_document", cron emarque-parse)
  → extraction (participants, stats, officiels, OTM, avertissements qualité)
  → emarque_imports (ledger de cycle de vie du parse)
```

## Découverte et téléchargement

Uniquement via `BrowserFbiClient` (voir `docs/FBI.md` — `HttpFbiClient`
échoue explicitement avec `EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED`, aucun
endpoint HTTP e-Marque n'a jamais été confirmé). Le job
`discover_emarque` (`src/jobs/process-discover-emarque.ts`) :

1. réclame un job via `claim_next_fbi_job` (voir `docs/JOBS.md`) ;
2. lance `launchServerlessBrowser()`, se connecte avec les identifiants du
   club (`getFbiCredentials`) ;
3. navigue jusqu'à la page e-Marque du match et énumère les documents
   disponibles (feuille de match, fiche de rencontre, ce qui est exposé —
   jamais un nom de document deviné, voir `selectors.ts`) ;
4. télécharge chaque document via `context.request.get()` (cookies de
   session réutilisés, jamais un `page.waitForEvent('download')`) ;
5. upload vers Storage puis enregistre une ligne `match_documents` par
   fichier, idempotente sur `sha256` — un même fichier retéléchargé
   n'écrit jamais deux fois la même donnée.
6. si aucun document n'est encore disponible (match pas encore feuille de
   match remplie côté FBI), le job repasse en attente avec le backoff
   "attente" (voir `docs/JOBS.md`), jamais une erreur.

## Stockage — convention de chemin figée

`storage/emarque-storage.ts` — jamais d'URL publique permanente, toujours
signée à la demande (`createEmarqueSignedUrl`, TTL court) et uniquement
après vérification du rôle (`docs/API.md` — route documents réservée à
`club_admin` pour le téléchargement) :

```
private/emarque/{club_id}/{season}/{match_id}/{type}-{sha256}.{ext}
```

`resolveSeasonLabel` calcule `{season}` de façon déterministe à partir de
la date du match (même règle que le reste de l'app — une saison FFBB ne
suit pas l'année civile). Bucket `emarque` : privé, sans policy Storage
`authenticated` — accès uniquement via le client service role, jamais
directement par un utilisateur (voir `docs/AUTH.md`).

## `match_documents` vs `emarque_imports`

Deux tables à deux responsabilités distinctes, jamais fusionnées :

- **`match_documents`** — manifeste, un enregistrement par fichier
  physique réellement stocké. Unique sur `(club_id, match_id, type,
  sha256)` : un nouveau téléchargement du même contenu ne duplique rien.
- **`emarque_imports`** — ledger du cycle de vie du *parsing* d'un
  document (`pending` → `parsed` / `failed`), avec ses propres
  avertissements de qualité. Un document peut être re-parsé (nouvelle
  version du parser) sans re-télécharger.

## Parsing — pipeline OCR/PDF réutilisé sans changement

`integrations/emarque/parser.ts` orchestre, dans l'ordre : extraction du
texte structuré (extracteurs PDF texte natif puis, en repli, rastérisation
+ OCR via `pdf-raster-ocr-extractor.ts` + `tesseract.js` pour les scans),
normalisation (`normalizers/`), validation de schéma (`schemas/`), puis
persistance (`persist/`) :

- **participants** — joueurs de chaque équipe, numéros de licence si
  lisibles ;
- **statistiques** — par joueur (`PlayerMatchStatsDto`, voir
  `docs/API.md`) ;
- **officiels** — arbitres, table de marque ;
- **OTM** (Officiel de Table de Marque) — rôle spécifique tracé
  séparément des autres officiels ;
- **avertissements de qualité** (`quality/`) — un champ illisible ou
  incohérent (ex : score total qui ne correspond pas à la somme des points
  par joueur) est signalé, jamais silencieusement ignoré ni bloquant pour
  le reste de l'import.

Ce module est un report quasi verbatim de `src/server/emarque/**` de SCSB
(voir `docs/MIGRATION.md`) — la logique d'extraction ne dépend d'aucune
API Next.js, seul l'import `@/types/database` → `@/db/types` a changé.

## Cron

`GET /internal/cron/emarque-parse` (toutes les 10 minutes, voir
`vercel.json`) traite un petit lot de documents en attente de parsing —
jamais tous en une seule invocation (même philosophie que les crons FFBB
et FBI, voir `docs/JOBS.md`).

## Ce qui n'est PAS fait

Pas de module dérogations/tables de marque au sens FBI authentifié
au-delà de l'extension prévue mais non implémentée mentionnée dans
`docs/FBI.md` (`listDerogations()`).
