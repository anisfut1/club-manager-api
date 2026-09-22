# FBI — enrichissement optionnel

FBI (mode `FBI_ENHANCED`) ajoute, par-dessus le calendrier FFBB déjà
fonctionnel : feuille de match, composition, OTM, statistiques, documents
e-Marque. **FBI ne devient jamais le calendrier principal** et n'est
**jamais requis** pour qu'un club fonctionne — voir `tenancy/club-capabilities.ts`
et le pattern explicitement demandé :

```ts
if (!fbiCredentials) {
  // utiliser uniquement FFBBPublicProvider, ignorer les jobs FBI/e-Marque
  // — jamais "application inutilisable"
}
```

## Deux stratégies derrière une interface commune

| | `HttpFbiClient` (`integrations/fbi/http-client.ts`) | `BrowserFbiClient` (`integrations/fbi/browser-client.ts`) |
|---|---|---|
| Mécanisme | `fetch` + cookie jar (`SimpleCookieJar`) | Chromium headless (Playwright) |
| Rôle | **Stratégie PRINCIPALE** — login, cookie de session (JSESSIONID), GET, POST de lecture, téléchargement | **Stratégie DE SECOURS** — utilisée uniquement là où HTTP direct est confirmé insuffisant |
| Login | PREPARED — détection dynamique du formulaire (cheerio), jamais de nom de champ deviné | PREPARED — mêmes heuristiques (voir `selectors.ts`), transposées en Playwright |
| Découverte e-Marque | Échoue explicitement (`EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED`) — aucun endpoint HTTP confirmé, jamais inventé | Voie fonctionnelle — navigue et scanne la page comme le ferait un humain |
| Où | N'importe quelle route `/v1/*` ou `/internal/*` (léger, rapide) | Uniquement `/internal/*` (jamais un chemin utilisateur) |

`isFbiRequestAllowed`/`classifyFbiAction` (`action-classification.ts`)
classent chaque action FBI en READ_ONLY/WRITE/UNKNOWN à partir du nom
d'action extrait de l'URL — une action UNKNOWN n'est jamais auto-appelée,
et FBI reste strictement en lecture dans les deux clients.

## Login — jamais un simple code 200

Un HTTP 200 ne prouve rien pour une appli Java legacy qui peut très bien
renvoyer 200 sur sa propre page de connexion en cas d'échec. La preuve
utilisée est l'ABSENCE d'un champ `input[type=password]` sur la page
d'atterrissage (`looksLikeLoginPage`). `classifyFbiLoginStatus`
(`errors.ts`) traduit en `CONNECTED` / `INVALID_CREDENTIALS` (jamais
retenté) / `FBI_UNAVAILABLE` (retry avec backoff) / `AUTH_FLOW_CHANGED`
(structure de page changée, surfacé via `fbi_integration_status.last_error`)
/ `UNKNOWN_ERROR`.

## BrowserFbiClient sur Vercel — analyse réelle, pas une hypothèse

Avant d'implémenter quoi que ce soit, les contraintes Vercel actuelles
(2026) ont été vérifiées explicitement plutôt que supposées :

| Contrainte | Valeur constatée | Source |
|---|---|---|
| Durée max d'une Function | Sans Fluid Compute (legacy) : Pro 300s. **Avec Fluid Compute (activé par défaut désormais)** : Pro 800s, extensible à 1800s (bêta) | docs Vercel (functions/limitations, functions/configuring-functions/duration) |
| Mémoire | Fluid Compute : 2GB/1vCPU par défaut, jusqu'à 4GB/2vCPU en option Performance | docs Vercel (functions/configuring-functions/memory) |
| Taille de bundle par fonction | 250MB décompressé (pas 50MB, chiffre souvent confondu avec la taille compressée) — `@sparticuz/chromium` fait ~130MB décompressé, tient largement dedans | vercel.com/kb/guide/troubleshooting-function-250mb-limit |
| `/tmp` | Disponible, éphémère, non partagé entre invocations — taille exacte non confirmée depuis une page officielle directement lue dans cette session (souvent citée à 512MB, non garanti ici) | non confirmé à 100% — voir limitation ci-dessous |
| Runtime requis | Node.js (Edge runtime EXCLU : ne peut pas exécuter de binaire natif ni spawn de process) | docs Vercel (functions/runtimes/node-js) |
| `@sparticuz/chromium` | Activement maintenu (v153.x), mais son propre README ne mentionne **jamais Vercel** comme plateforme supportée (seulement AWS Lambda, Netlify) | github.com/Sparticuz/chromium |
| Retours communautaires | Plusieurs rapports de succès `@sparticuz/chromium` + `playwright-core`/`puppeteer-core` sur Vercel, MAIS aussi des erreurs récurrentes de bibliothèques partagées manquantes (`libnspr4.so`, `libnss3.so`) sur le runtime Node 22.x de Vercel, et au moins un rapport de Fluid Compute cassant une configuration Playwright qui fonctionnait auparavant | community.vercel.com (threads cités dans la recherche), dev.to |

**Conclusion retenue** : techniquement viable sur un plan Vercel Pro avec
Fluid Compute pour un usage occasionnel (pas de scraping haute fréquence),
mais **non officiellement supporté** ni par Vercel ni par
`@sparticuz/chromium`. C'est du "ça marche, avec des pièges documentés par
la communauté", pas une garantie de production. D'où le garde-fou
`BROWSER_FBI_ENABLED` (défaut `false`) : la capability reste explicitement
opt-in, jamais activée silencieusement.

### Ce qui est implémenté

- `integrations/fbi/browser-launcher.ts#launchServerlessBrowser()` —
  lance `playwright-core` + `@sparticuz/chromium` (jamais le paquet
  `playwright` complet, qui embarque un Chromium desktop bien plus lourd)
  UNIQUEMENT si `BROWSER_FBI_ENABLED=true`, sinon lève
  `BrowserFbiUnavailableError` immédiatement — jamais une tentative
  silencieuse.
- `integrations/fbi/browser-client.ts` (`BrowserFbiClient`) — identique en
  substance à ce qui aurait tourné sur un worker séparé : un
  `BrowserContext` Playwright ISOLÉ par connexion (jamais de cookie
  partagé entre deux clubs), sélecteurs centralisés et robustes (jamais de
  position, voir `selectors.ts`), téléchargement via
  `context.request.get()` (réutilise les cookies de la session
  authentifiée, jamais un `page.waitForEvent('download')` qui toucherait
  un fichier temporaire — le seul stockage temporaire réel du binaire
  Chromium lui-même, extrait par `@sparticuz/chromium` dans `/tmp`).
- `src/jobs/process-discover-emarque.ts` / `process-test-connection.ts` —
  lancent le navigateur, l'utilisent, le ferment systématiquement (`finally`)
  À CHAQUE invocation de Vercel Function — jamais de processus long-running
  partagé entre requêtes (§24 de la demande : uniquement `/tmp`, puis
  suppression — ici, rien n'est même écrit ailleurs que par le binaire
  Chromium lui-même).
- Route : `GET /internal/cron/fbi-jobs`, protégée par `CRON_SECRET`, jamais
  un chemin utilisateur. Flux : `claimNextJob` → `getFbiCredentials` →
  `BrowserFbiClient` → login → découverte/téléchargement → Storage →
  `match_documents` → job terminé.

### Supporté / préparé / non testé live / impossible

- **Supporté** : `HttpFbiClient` (login, cookie jar, GET/POST lecture,
  téléchargement) — chemin HTTP, aucune dépendance Vercel spécifique.
- **Préparé, non testé live** : `BrowserFbiClient` complet (login,
  découverte, téléchargement) — testé uniquement contre des pages HTML
  locales synthétiques avec un vrai Chromium (voir
  `integrations/fbi/browser-client.test.ts`), jamais contre le vrai FBI
  (réseau `*.ffbb.com` bloqué dans tous les environnements où ce code a
  été écrit) NI contre un vrai déploiement Vercel avec
  `@sparticuz/chromium` (jamais déployé depuis cette session).
- **Non confirmé** : la taille exacte de `/tmp` sur les runtimes Vercel
  actuels, et la stabilité de `@sparticuz/chromium` face à un changement
  futur de runtime Node côté Vercel (les rapports communautaires
  documentent des ruptures passées).
- **Impossible aujourd'hui** : rien n'a été jugé impossible — l'exploration
  sérieuse demandée avant de conclure a été faite (voir tableau ci-dessus)
  et n'a pas éliminé l'approche. Si un déploiement réel révèle
  l'incompatibilité (ex : `libnspr4.so` manquant sur le runtime effectif),
  la marche à suivre reste : garder `BrowserFbiClient` dans le code comme
  secours expérimental, désactiver `BROWSER_FBI_ENABLED`, continuer avec
  `HttpFbiClient` seul, sans jamais casser FFBB ni le reste du produit —
  jamais Railway/Render/Fly.io.

## Identifiants

AES-256-GCM, AAD = `club_id` (`security/crypto.ts`) — un ciphertext déplacé
vers un autre club ne se déchiffre jamais. `fbi_credentials` n'a AUCUNE
policy RLS `authenticated` : lu/écrit uniquement via le client service
role, après vérification du rôle `club_admin` par la RLS (voir
`docs/AUTH.md`).

`POST /v1/clubs/:clubId/integrations/fbi` enregistre `username` +
`password` (chiffré) — le mot de passe n'est jamais renvoyé en réponse.

## API frontend (gaps 4 et 8 résolus)

`GET /v1/clubs/:clubId/integrations` expose le `username` FBI configuré
**en clair** (jamais masqué) pour `club_admin`/`platform_admin` — utile
pour que l'admin sache quel compte est configuré sans devoir le
redemander — mais jamais `password`/ciphertext/IV/auth tag :

```json
{ "fbi": { "configured": true, "username": "club-a-fbi", "status": "connected", "autoImportEmarque": true, "lastSuccessfulLoginAt": "2026-09-01T10:00:00.000Z" } }
```

Activer/désactiver l'intégration ou l'auto-import sans jamais redemander
username/password :

```
PATCH /v1/clubs/:clubId/integrations/fbi
{ "enabled"?: boolean, "autoImportEmarque"?: boolean }
```

`club_admin` uniquement. `enabled: false` est toujours permis (même sans
identifiants). Activer (`enabled: true` ou `autoImportEmarque: true`) sans
identifiants déjà enregistrés renvoie `409 FBI_NOT_CONFIGURED` — jamais un
409 générique, le frontend peut distinguer ce cas et rediriger vers le
formulaire d'identifiants.

## Test de connexion

`POST /v1/clubs/:clubId/integrations/fbi/test` teste réellement
`HttpFbiClient` (chemin synchrone, rapide). Si l'échec est
`LOGIN_FORM_NOT_RECOGNIZED` (structure de page changée) ET que
`BROWSER_FBI_ENABLED=true`, un job `test_connection` (navigateur) est
empilé en secours et son id renvoyé (`202`) pour suivi via
`GET /v1/jobs/:jobId` — voir `docs/API.md` §Async.

## Dérogations / licenciés FBI

Non développé (§60/§40/§41 de la demande — pas de module tables de marque
ni de dérogations à ce stade). Un export XLSX des dérogations et des
routes AJAX de consultation (ex. `afficherLicenceStatistiqueAjax.fbi`,
classée READ_ONLY par `action-classification.ts`) ont été rapportés lors
d'un spike antérieur côté SCSB (`docs/FBI_AUTHENTICATED_SPIKE.md`, jamais
confirmé indépendamment). Point d'extension prévu mais non implémenté :
une méthode `listDerogations()` sur l'interface `FbiAutomationClient`.
