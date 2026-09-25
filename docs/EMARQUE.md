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

**Constaté en production le 2026-09-24 (rencontre n°1481) : le ZIP
e-Marque était bien téléchargé (§ "Vingt-neuvième déclenchement",
docs/FBI.md) mais son parsing échouait systématiquement sur Vercel** avec
`Setting up fake worker failed: Cannot find module
'/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'`. Cause :
`pdfjs-dist` (`legacy/build/pdf.mjs`) charge son worker via un
`import(this.workerSrc)` **dynamique et relatif**, invisible à l'analyse
statique de la pipeline de build Vercel (empaquetage esbuild d'une
Function unique, voir `docs/DEPLOYMENT.md`) — ce fichier n'est donc jamais
copié dans le déploiement. `pdfjs-dist` prévoit exactement ce cas :
`PDFWorker.#mainThreadWorkerMessageHandler` vérifie d'abord
`globalThis.pdfjsWorker?.WorkerMessageHandler` et ne tente l'import
dynamique QUE si ce global est absent. **Corrigé** dans
`pdfjs-loader.ts` : un import STATIQUE (littéral) du module worker,
correctement inclus par l'analyse statique, assigné à ce global avant
tout appel à `getDocument()` — l'import dynamique interne à `pdfjs-dist`
n'a alors jamais lieu.

**Deux bugs supplémentaires de la même famille, découverts juste après
(§ "Trentième déclenchement", docs/FBI.md, détail complet là-bas) :**
`tesseract.js-core` choisit lui aussi UN de ses 6 fichiers `.wasm` via un
`require()` dynamique basé sur une détection runtime du support SIMD —
jamais tracé statiquement non plus, et sans point d'extension équivalent
à `globalThis.pdfjsWorker` pour le contourner ; et le modèle de langue OCR
(`fra.traineddata`) n'avait en réalité **jamais été porté** depuis SCSB
lors de la migration (`OCR_LANG_PATH` pointait vers un chemin Next.js de
l'ancien monolithe qui n'a jamais existé dans ce repo). Corrigé : le
fichier est maintenant vendorisé sous
`src/integrations/emarque/ocr-data/` (voir son `README.md`), et
`vercel.json` (`functions."api/index.ts".includeFiles`) force
l'inclusion de tout `node_modules/tesseract.js-core/` ainsi que de ce
dossier — les deux catégories de fichiers lus dynamiquement par `fs`
plutôt que par `require`/`import` statique.

**Une fois le pipeline de parsing débloqué, le premier vrai document
"résumé" de production a révélé deux bugs de calibration des zones OCR
dans `resume-layout.ts`/`parse-resume.ts` (§ "Trente-et-unième
déclenchement", docs/FBI.md, détail complet là-bas) :** un décalage de
ligne complet (le premier joueur de l'équipe LOCAUX disparaissait
entièrement d'un relevé "résumé"), et une lecture ligne-entière (numéro +
nom + temps + 7 statistiques en un seul appel OCR) où un seul chiffre mal
lu n'importe où dans la ligne décalait silencieusement toutes les
statistiques. Corrigé : coordonnées re-calibrées pixel par pixel contre le
document réel fourni par le club, chaque colonne lue par un appel OCR
séparé (`extractSingleInteger`), et une seconde passe OCR ciblée
(agrandissement + alphabet restreint aux chiffres) quand la première ne
trouve aucun chiffre sur une cellule censée être numérique — taux de
lecture correcte mesuré à 89,2 % sur cet échantillon (contre un pipeline
essentiellement inutilisable avant, données décalées ou valeurs absurdes
comme "101 points"). Premier test de ce module contre un vrai document
(`parser/parse-resume.test.ts`, fixture `__fixtures__/resume-1481.pdf`).

**`feuillematch-layout.ts` — l'unique source des numéros de licence —
n'avait jamais reçu la même recalibration (§ "Trente-quatrième
déclenchement", docs/FBI.md, détail complet là-bas) :** les colonnes
LICENCE/Nom de l'équipe VISITEURS tronquaient systématiquement le préfixe
à deux lettres de la licence (les deux encadrés d'équipe du gabarit FFBB
ont des largeurs de colonnes différentes, jamais mesurées séparément
avant), et la confusion OCR "O"/"0" à l'intérieur d'un numéro de licence
isolé était bidirectionnelle (un "0" réel lu "O" ET un "O" réel lu "0"
selon le cas) — corrigée par une correction positionnelle plutôt
qu'aveugle. Un bug de repli distinct affectait aussi la lecture des
entraîneurs (`break` sur le premier trouvé, `role` toujours codé en dur).
Validé à 15/15 numéros de licence exacts contre la liste fournie par le
club (rencontre n°1481), nouveau test contre le document réel
(`parser/parse-feuillematch.test.ts`, fixture
`__fixtures__/feuillematch-1481.pdf`). Débloque la demande du club de
relier chaque joueur/joueuse à sa licence FFBB ; scope explicitement
limité aux licencié(e)s du club exploitant le compte FBI, jamais ceux du
club adverse d'une rencontre.

## Cron

`GET /internal/cron/emarque-parse` (toutes les 10 minutes, voir
`vercel.json`) traite un petit lot de documents en attente de parsing —
jamais tous en une seule invocation (même philosophie que les crons FFBB
et FBI, voir `docs/JOBS.md`).

## API frontend (gaps 5 et 6 résolus)

Liste tenant-scopée des imports e-Marque, filtrée et paginée (défaut 20,
max 100, jamais un dump complet) :

```
GET /v1/clubs/:clubId/emarque-imports?matchId=&status=&from=&to=&limit=&offset=
```

Réponse : `EmarqueImportDto[]` (`id`, `matchId`, `status`, `source`,
`parserVersion`, `discoveredAt`/`downloadedAt`/`importedAt`,
`qualityWarnings`, `lastError`, `attemptCount`, `nextAttemptAt`) — jamais
de chemin de stockage interne, de stack trace, ni le contenu brut d'un
ZIP/PDF. Le détail d'un match (`GET .../matches/:matchId`) expose le même
niveau de détail e-Marque directement dans sa section `emarque`.

`lastError` est toujours **assaini** (`integrations/emarque/sanitize-error.ts`) :
`emarque_imports.last_error`/`match_documents.last_error` peuvent contenir
un message d'exception brut (`error.message` capturé tel quel côté job,
voir `src/jobs/parse-downloaded-documents.ts`) — jamais renvoyé au
frontend tel quel, uniquement une classification générique
(`SanitizedErrorDto { code, message }`) sûre à afficher.

`IssueDto` (`GET /v1/clubs/:clubId/issues`) est enrichi de la même
philosophie : `type`/`severity`/`status`, un `message` utilisateur séparé
de `technicalCode` (machine), `matchId`, `integration`, `qualityWarnings`,
`createdAt`/`resolvedAt` — jamais une erreur interne brute exposée telle
quelle. Exemple :

```json
{ "technicalCode": "EMARQUE_SCORE_MISMATCH", "message": "Le score e-Marque ne correspond pas au score FFBB." }
```

## Ce qui n'est PAS fait

Pas de module dérogations/tables de marque au sens FBI authentifié
au-delà de l'extension prévue mais non implémentée mentionnée dans
`docs/FBI.md` (`listDerogations()`).
