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
`LOGIN_FORM_NOT_RECOGNIZED` ou `LOGIN_FAILED` ET que
`BROWSER_FBI_ENABLED=true`, un login navigateur (`attemptBrowserFbiLogin`,
`BrowserFbiClient`) est tenté DANS LA MÊME REQUÊTE (2026-09-24 — voir
"Huitième déclenchement" plus bas ; jusque-là un job `test_connection`
était empilé et son id renvoyé en `202` pour suivi via
`GET /v1/jobs/:jobId`, retiré).

**Premier test réel, identifiants corrects côté club, échoue avec
`LOGIN_FAILED` ("identifiant ou mot de passe incorrect").** Comme pour
FFBB (voir docs/FFBB.md), ce chemin n'avait jamais été exécuté contre le
vrai FBI depuis aucun environnement de développement — un `LOGIN_FAILED`
avec de vrais identifiants est donc a priori un mauvais diagnostic du
code (mauvais champ détecté, redirection non suivie, page intermédiaire
non anticipée), pas forcément un mauvais mot de passe.

**Diagnostic ajouté** (`http-client.ts`, `login()`) : chaque `FbiError`
(`LOGIN_FORM_NOT_RECOGNIZED`, `LOGIN_FAILED`) embarque désormais dans son
message les champs de formulaire réellement détectés (action, nom du
champ identifiant, nom du champ mot de passe), le statut HTTP de la
réponse de soumission, et un extrait borné (500 caractères, aplati) de la
page HTML concernée — jamais le mot de passe, un cookie ou un jeton.
Nécessaire car `logError` (`logger.ts`) ne capture que
`error.message`/`.stack`, jamais `.cause` : c'est le seul moyen pour ce
détail de survivre jusqu'aux logs Vercel (`vercel logs ... --json | grep
"fbi/test"`), même méthode que `directus-client.ts` côté FFBB. Corrigé au
passage : une réponse de soumission ni redirigée ni 2xx (ex. 403
applicatif) était silencieusement traitée comme un succès potentiel
(`landingHtml` vide → `looksLikeLoginPage("")` → `false`) — lève
maintenant `LOGIN_FAILED` explicitement. Couvert par 2 nouveaux tests
(`http-client.test.ts`).

**Prochaine étape** : relancer "Tester la connexion" depuis
`/admin/intégrations/fbi`, puis lire le message complet dans les logs
Vercel de club-manager-api pour voir exactement quel formulaire/champ a
été détecté et pourquoi le site l'a refusé — jamais deviner un nouveau
nom de champ sans ce retour, comme pour FFBB.

**Deuxième déclenchement réel : cause trouvée grâce au diagnostic
ci-dessus.** Le formulaire est correctement détecté (`action=
https://extranet.ffbb.com/fbi/identification.fbi;jsessionid=...`, champs
`identificationForm.identificationBean.identifiant`/`...mdp` — noms
typiques d'un bean Struts, cohérents), et la soumission répond `HTTP 200`
**directement, sans redirection**. Le bug était dans notre propre code,
pas côté FBI : quand la soumission ne redirige pas, `login()` faisait un
SECOND appel GET vers CETTE MÊME URL d'action pour lire "la page
d'atterrissage" — hors contexte du POST, sans session encore établie côté
serveur pour cette requête. Pour une appli Java classique qui rend le
résultat directement dans la réponse du POST (au lieu de rediriger après
un login réussi), ce second GET renvoie le formulaire de connexion vierge
de départ, **quels que soient les identifiants**, un ou de mauvais — CE
GET, jamais notre POST, était la cause du `LOGIN_FAILED` systématique.

**Corrigé** (`http-client.ts`) : quand la soumission répond `200` sans
`Location`, `login()` lit maintenant le corps de LA RÉPONSE DE SOUMISSION
ELLE-MÊME (`submitResponse.text()`) au lieu de relancer un GET séparé — un
second GET n'est fait QUE quand le serveur redirige réellement (3xx +
`Location`), pour suivre cette redirection. Couvert par 2 nouveaux tests
(`http-client.test.ts`) : succès en 200 direct (vérifie qu'aucun second
appel réseau n'est fait vers la même URL), et échec en 200 direct avec le
formulaire de connexion dans le corps de LA RÉPONSE DE SOUMISSION
elle-même. **Non encore reconfirmé en direct** après ce correctif — à
valider au prochain "Tester la connexion".

**Troisième déclenchement réel : correctif confirmé actif, mais toujours
`LOGIN_FAILED`.** Le titre de la page d'atterrissage est bien `FBI -
Identification` cette fois (preuve que c'est désormais le corps RÉEL de
la réponse au POST, plus un second GET parasite) — mais le diagnostic
n'affichait que les 500 premiers caractères du `<head>` brut (balises
`<meta>`/`<link>` de mise en page, quasi identiques sur TOUTE page FBI,
succès ou échec) : aucune valeur diagnostique, le vrai contenu (message
d'erreur, ou à l'inverse le nom du club si connecté) est dans `<body>`,
jamais atteint dans les 500 premiers caractères de balisage brut.

**Corrigé** (`http-client.ts`) : `visibleBodyText()` remplace
`truncateHtml()` — extrait le texte VISIBLE de `<body>` (balises
retirées via cheerio, déjà utilisé pour le parsing) plutôt que le
balisage brut, avant troncature à 500 caractères. Couvert par un nouveau
test qui vérifie qu'un message d'erreur placé dans le corps ressort bien
dans le diagnostic, et que le `<head>` (ex: `fonts.googleapis.com`) n'y
apparaît plus.

**Quatrième déclenchement réel : le correctif ci-dessus tombait sur du
JavaScript inline, pas du texte lisible.** `.text()` de cheerio inclut le
contenu textuel des `<script>`/`<style>` (jamais visible dans un
navigateur, mais bien du texte du point de vue du DOM) — les 500 premiers
caractères capturés n'étaient que du JS (`$(document).ready(...)`,
gestion de `#loginList`/`#loginEntete`/`#utilisateurId` via
`connexionEntete('identificationEntete')`). **Piste ouverte, non
confirmée** : ces noms (liste de comptes, "entête" à choisir) suggèrent
que FBI présente une étape de SÉLECTION DE COMPTE/ENTITÉ après un login
par ailleurs réussi (cas d'un identifiant associé à plusieurs structures)
— auquel cas `LOGIN_FAILED` serait un faux négatif : `looksLikeLoginPage`
trouve un `input[type=password]` sur cette page intermédiaire (peut-être
un formulaire de re-confirmation) alors que les identifiants étaient
corrects. À confirmer par le prochain texte visible, script exclu.

**Corrigé** (`http-client.ts`) : `visibleBodyText()` retire désormais
`<script>`/`<style>` (`$("script, style").remove()`) avant d'extraire le
texte — jamais de code JS/CSS à la place du texte réellement visible.
Couvert par un nouveau test (page avec message d'erreur ET `<script>`
volumineux, vérifie que seul le message ressort).

**Cinquième déclenchement réel : le texte visible confirme un vrai
message FBI, texte français lisible.** Diagnostic complet obtenu :
*"FBI 2026-2027 [...] Identifiant ou e-mail Mot de passe **Vos
identifiants ne sont pas corrects** CONNEXION Mot de passe oublié ?
[...]"*. La piste "sélection de compte" (déclenchement précédent) est
écartée : c'est bien le message de refus standard FBI, retourné
directement dans le corps du POST (confirmé par le diagnostic
maintenant fiable de bout en bout). Le club confirme avoir re-saisi et
réenregistré le mot de passe juste avant ce test — donc soit les
identifiants sont réellement incorrects côté FBI, soit notre POST omet
encore quelque chose que le navigateur envoie.

**Piste retenue** : le bouton de soumission n'était jusqu'ici PAS inclus
dans le POST — seuls les champs `hidden`/texte/mot de passe l'étaient.
Beaucoup d'applis Java (Struts/JSF, cohérent avec les noms de champs
`identificationForm.identificationBean.*` déjà observés) exigent le
couple nom/valeur du bouton cliqué (ex: `method:connexion=Connexion`)
dans le corps du POST pour router vers la bonne action côté serveur —
sans lui, le serveur peut traiter la requête comme incomplète et
retomber sur le message de refus générique, quels que soient les
identifiants envoyés.

**Corrigé** (`http-client.ts`) : `parseLoginForm` détecte maintenant
aussi `button[type="submit"]`/`input[type="submit"]` dans le formulaire
et, s'il porte un `name`, son couple nom/valeur est ajouté au corps du
POST (et au diagnostic, pour voir si aucun bouton nommé n'est trouvé).
Couvert par un nouveau test.

**Sixième déclenchement réel : le bouton n'était pas la cause — aucun
bouton nommé sur ce formulaire** (diagnostic : `bouton de soumission=
aucun trouvé`), le correctif est un no-op ici (harmless, mais pas la
solution). Le club confirme via une question directe que ces mêmes
identifiants fonctionnent en se connectant à la main sur
`extranet.ffbb.com/fbi`, écartant un vrai mot de passe incorrect ou une
erreur de chiffrement côté club-manager-api (le round-trip AES-256-GCM
est testé unitairement — unicode, chaîne vide, isolation par AAD — et
toute incohérence de clé/AAD lèverait `DecryptionError`, une erreur
distincte, jamais un `LOGIN_FAILED` silencieux ; la longueur du
ciphertext en base est cohérente avec un mot de passe normal).

**Piste retenue** : la page affiche explicitement *"Votre navigateur
n'est pas recommandé pour utiliser FBI. Nous vous recommandons Google
Chrome"* — preuve d'une détection de navigateur côté serveur. Aucune de
nos requêtes n'envoyait de `User-Agent` (le `fetch` de Node/undici n'en
envoie pas un qui ressemble à un vrai navigateur) : cohérent avec une
protection anti-bot basique et silencieuse (rejet de connexion sans le
révéler explicitement), fréquente sur ce type d'appli legacy.

**Corrigé** (`http-client.ts`) : `FBI_REQUEST_HEADERS` (User-Agent
Chrome/Windows réaliste + `Accept-Language: fr-FR`) appliqué à TOUTE
requête vers FBI (login, landing, `isSessionValid`,
`downloadDocument`) — pas seulement le login, une incohérence de
user-agent au fil d'une session étant elle-même un signal de détection
courant. Couvert par un nouveau test qui vérifie qu'un User-Agent
contenant "Chrome" est envoyé sur les 3 requêtes d'un login réussi.

**Septième déclenchement réel : `LOGIN_FAILED` persiste, identique au
mot près, MALGRÉ le User-Agent de navigateur.** Le bandeau "navigateur
non recommandé" reste affiché même avec un User-Agent Chrome — affaiblit
la piste "détection par User-Agent seul" : soit le bandeau est statique
(toujours affiché, pas une vraie détection), soit la détection va plus
loin qu'un simple en-tête (empreinte TLS/JA3, exécution JS, fingerprinting
navigateur) — rien qu'un `fetch()` Node ne peut reproduire. Round-trip de
chiffrement écarté indépendamment (voir plus haut). Avec des identifiants
confirmés deux fois par le club (login manuel réussi), l'explication la
plus probable devient une protection anti-bot qu'un client HTTP direct ne
peut structurellement pas franchir.

**Corrigé** (`routes.ts`) : le repli vers `BrowserFbiClient` (job
`test_connection`, `BROWSER_FBI_ENABLED=true`) se déclenchait
uniquement sur `LOGIN_FORM_NOT_RECOGNIZED` — jamais sur `LOGIN_FAILED`,
alors que c'est exactement le code d'erreur rencontré ici. Élargi aux
deux codes : un vrai Chromium a une empreinte de navigateur qu'un
`fetch` ne peut pas imiter, donc plus susceptible de franchir cette
protection si c'en est une ; un `LOGIN_FAILED` du navigateur reste
possible (vraiment mauvais identifiants), mais devient alors un signal
nettement plus fiable que celui du client HTTP seul. **Nécessite
`BROWSER_FBI_ENABLED=true` en production** (variable d'environnement
Vercel côté club-manager-api) pour se déclencher — à vérifier/activer
avant de retester. Pas de nouveau test route-level ajouté (la route
`/fbi/test` n'a aucune couverture existante nécessitant de mocker
`HttpFbiClient`/`fbi_jobs` — lift disproportionné pour ce correctif
d'une ligne, urgence du diagnostic en direct).

**Sixième déclenchement réel : succès, via le job navigateur.** Après
avoir déclenché manuellement `/internal/cron/fbi-jobs` depuis le
dashboard Vercel (le cron ne tourne qu'une fois par jour, voir
vercel.json), le job navigateur confirme `loginStatus: "CONNECTED"` — le
club a bien les bons identifiants, HTTP direct était structurellement
bloqué (protection anti-bot). `fbi_integration_status.last_login_success`
passe à `true`.

**Septième correctif : `last_error` restait affiché malgré le succès.**
Les deux chemins de succès (`routes.ts` synchrone, `process-test-
connection.ts` asynchrone) ne réinitialisaient jamais `last_error` —
`/admin/intégrations` aurait affiché "Connecté ✅" à côté du message
d'erreur HTTP périmé. Corrigé : `last_error: null` explicite sur les
deux chemins de succès. Nettoyage ponctuel en production (SQL direct)
de la ligne déjà incohérente pour le club pilote.

**Huitième déclenchement — retour du club : "je ne veux pas que ça
marche avec le bouton Vercel, je veux que tout passe par l'appli".**
Juste après confirmation du succès, devoir déclencher manuellement le
cron depuis le dashboard Vercel à chaque test (et pour chaque futur
`discover_emarque` en attente, même limitation) est exactement ce que
le pattern job+cron devait éviter pour une action interactive — un
admin qui clique "Tester la connexion" attend un résultat immédiat.

**Corrigé** : `attemptBrowserFbiLogin` (nouveau module
`integrations/fbi/browser-login-attempt.ts`, factorisé depuis
`process-test-connection.ts`) est appelé DIRECTEMENT et de façon
SYNCHRONE par `POST .../fbi/test` — plus de job `fbi_jobs` créé pour ce
type d'appel, plus de `202`/`jobId`, plus besoin du cron. Vérifié :
`maxDuration: 300` (vercel.json) laisse largement la place pour un
login navigateur (`launchServerlessBrowser` + `BrowserFbiClient.login`),
qui prend quelques secondes en pratique (voir déclenchements
précédents). `TestFbiConnectionButton.tsx` (SCSB) n'a nécessité AUCUN
changement : il gérait déjà les deux cas (`result.jobId` → polling,
sinon → résultat direct), donc le cas direct fonctionne immédiatement.

`processTestConnectionJob`/le traitement `test_connection` du cron
`/internal/cron/fbi-jobs` restent en place (refactorés pour réutiliser
`attemptBrowserFbiLogin`) — plus rien ne crée ce type de job aujourd'hui,
mais rien n'empêche un futur appelant (retry différé en arrière-plan) de
le faire plutôt que d'utiliser le chemin synchrone. La synchronisation
FFBB (`POST .../ffbb/sync`, bouton "Relancer maintenant") était déjà
entièrement synchrone, sans dépendance à un job/cron — aucun changement
nécessaire là. Couvert par 2 nouveaux tests route-level (`BROWSER_FBI_
ENABLED=true` + `resetEnvCacheForTests()`, mock de
`attemptBrowserFbiLogin`) : succès navigateur sans `jobId` dans la
réponse, échec navigateur enregistré comme `last_error`.

**Neuvième déclenchement — "et maintenant que FBI est connecté, ça me
sert à quoi ? ça ne change rien alors que ça doit tout récupérer".**
Question légitime : `POST .../fbi/test` (huitième déclenchement)
prouve seulement que les identifiants FBI sont valides. La récupération
RÉELLE des documents e-Marque (feuilles de match, compositions,
statistiques) est un traitement séparé — les jobs `discover_emarque`
(un par match, voir `process-discover-emarque.ts`), qui utilisent
TOUJOURS `BrowserFbiClient` (jamais `HttpFbiClient` : `findEmarqueDocuments`
n'a aucune implémentation HTTP directe, voir plus haut). Constaté en
production le 2026-09-24 : 8 jobs `discover_emarque` (+ 2 `test_connection`,
créés avant le huitième correctif) en attente depuis plus d'une journée,
`claimed_at: null` — parce que ces jobs dépendent du même
`/internal/cron/fbi-jobs` qui ne tourne qu'une fois par jour, la seule
façon de les faire avancer plus tôt étant, jusqu'ici, le déclenchement
manuel du dashboard Vercel — exactement ce que le club a demandé
d'éviter au déclenchement précédent, mais qui ne concernait alors que le
test de connexion, pas la file `discover_emarque`.

**Corrigé** : nouvelle route `POST .../fbi/process-jobs`
(`club_admin`), traitant DANS LA REQUÊTE un petit lot (`CLUB_JOB_BATCH_SIZE
= 3`, même taille que le cron) des jobs FBI en attente **de ce club
uniquement**. Nouvelle fonction SQL `claim_next_fbi_job_for_club(p_club_id,
p_worker_id)` (migration `20260924100000_fbi_jobs_claim_for_club.sql`),
copie de `claim_next_fbi_job` avec un filtre `club_id = p_club_id` en
plus — nécessaire car `claim_next_fbi_job` réclame GLOBALEMENT (n'importe
quel club) : l'exposer tel quel depuis une route `/v1/clubs/:clubId/*`
aurait traité les jobs d'un AUTRE club à l'insu de l'appelant. Même
politique d'accès que l'original (`revoke all ... from public, anon,
authenticated` — service role uniquement, depuis le code serveur, après
que `requireClubRole("club_admin")` a vérifié le rôle).

La logique de réclamation+dispatch (réclamer jusqu'à `batchSize` jobs,
`import()` dynamique de `processTestConnectionJob`/`processDiscoverEmarqueJob`
selon `job.type`, comptage `claimed/succeeded/failed`) était dupliquée
dans `/internal/cron/fbi-jobs` : factorisée dans `jobs/process-batch.ts`
(`processJobBatch`), réutilisée par le cron (avec `claimNextJob`, global)
et par la nouvelle route (avec `claimNextJobForClub(clubId)`, scopée).

Côté SCSB : `ProcessFbiJobsButton.tsx`, nouvelle carte "Documents
e-Marque en attente" sur `/admin/intégrations/fbi` (visible dès que FBI
est configuré), expliquant explicitement que "Connecté" ne récupère rien
tout seul. Réponse `{ claimed, succeeded, failed }` affichée directement
(jamais de polling — un lot de 3 jobs traite en pratique en quelques
secondes à quelques dizaines de secondes selon le nombre de documents,
largement sous `maxDuration: 300`).

À noter : un lot de 3 ne vide pas forcément la file d'un coup si plus de
3 jobs sont en attente — l'admin reclique, ou attend la prochaine passe
du cron quotidien qui continuera à réclamer globalement (les deux
mécanismes cohabitent sans conflit, `FOR UPDATE SKIP LOCKED` empêchant
toute réclamation en double).

**Dixième déclenchement — "on a récupéré quoi là, je veux check en
front, sauf qu'on a juste les matchs à venir et pas les passés".** Deux
diagnostics distincts, tous deux constatés en production le 2026-09-24 :

1. **Timeout client trop court.** `POST .../fbi/process-jobs` réussissait
   bien côté serveur (logs : job réclamé, Chromium lancé, documents
   téléchargés — ~28s pour UN SEUL job) mais SCSB affichait "Traitement
   impossible" : le client HTTP (`src/lib/api/client.ts`) avait un
   timeout fixe de 20s, systématiquement dépassé par un lot de jobs
   navigateur. Corrigé côté SCSB : `timeoutMs` configurable par appel
   (`ApiRequestInit`), `processFbiJobs` passe désormais 280s (sous
   `maxDuration: 300`).

2. **Téléchargé ≠ affichable, et le calendrier de la saison en cours est
   vide.** Deux causes cumulées expliquaient l'absence totale de contenu
   visible :
   - Le pipeline e-Marque a DEUX étapes séparées (commentaire déjà présent
     dans `parse-downloaded-documents.ts`) : `discover_emarque`
     (Playwright, télécharge) puis le PARSING (OCR/PDF,
     `parseDownloadedEmarqueDocuments`, jusqu'ici UNIQUEMENT via
     `/internal/cron/emarque-parse`, une fois par jour). Un document
     `emarque_status: downloaded` ne devient `imported` (composition/
     stats/officiels persistés, donc affichables) qu'après cette seconde
     étape — jamais automatique en dehors du cron. Constaté : 14
     documents `downloaded`, `0` ligne dans `emarque_imports`.
   - `currentSeasonStart()` (SCSB, `/matchs` et `/admin/sync`) filtre par
     défaut sur la saison en cours (1er août → ...). La saison 2026-2027
     vient de commencer (aucun match encore joué dessus : `0` match
     `played` depuis le 1er août 2026) — les 97 matchs déjà joués de la
     saison précédente (2025-2026, tous encore `emarque_status: pending`
     faute d'avoir été enqueués avant que FBI soit connecté) sont donc
     invisibles sur `/matchs`, quel que soit leur statut e-Marque. La
     fiche détail (`/matchs/[id]`) n'a elle AUCUN filtre de saison — un
     match hors saison en cours reste consultable par lien direct, juste
     absent de la liste.

   **Corrigé** : nouvelle route `POST .../fbi/parse-documents`
   (`club_admin`), même principe que `process-jobs` mais pour l'étape
   PARSING — `parseDownloadedEmarqueDocuments` accepte désormais
   `{ clubId, limit }` (filtre + plafond de lot, `CLUB_PARSE_BATCH_SIZE =
   10` : pas de navigateur ici, un OCR/PDF coûte nettement moins cher
   qu'un login+scrape FBI, d'où un lot plus grand). Le cron
   (`/internal/cron/emarque-parse`) continue d'appeler la fonction SANS
   options (tout traiter, tous clubs). Côté SCSB : `ParseFbiDocumentsButton.tsx`,
   deuxième bouton dans la même carte "Documents e-Marque en attente",
   étiquetée en deux étapes numérotées (1. Télécharger / 2. Traiter).

   Le filtre de saison, lui, N'A PAS été changé — comportement voulu
   (§ "Vue 'Ce week-end' + filtres" du commentaire de `/matchs/page.tsx` :
   éviter de charger l'historique complet à chaque visite). Pour vérifier
   le rendu d'une feuille de match réelle dès maintenant : ouvrir
   directement `/c/<slug>/matchs/<matchId>` d'un match de la saison
   2025-2026 déjà `imported` (pas besoin d'attendre un match de la
   nouvelle saison).

   **Débit constaté** : 416 jobs `discover_emarque` `pending` pour le
   club pilote (créés d'un coup par `/internal/cron/fbi-enqueue` une fois
   FBI connecté, couvrant tout l'historique de matchs joués jamais
   synchronisé) — à raison de `CLUB_JOB_BATCH_SIZE = 3` par appel, vider
   cette file aurait demandé des dizaines de clics manuels. Voir "Onzième
   déclenchement" plus bas : `ProcessFbiJobsButton`/`ParseFbiDocumentsButton`
   relancent désormais l'appel automatiquement tant qu'il reste des
   candidats, plus besoin de recliquer.

**Onzième déclenchement — "on a récupéré quoi là" (suite) : les
documents téléchargés n'étaient PAS de vrais documents e-Marque.**
En creusant pourquoi `parse-documents` répondait systématiquement "rien
à parser" malgré des dizaines de documents `downloaded`, inspection
directe de `match_documents` en base : tous les documents partagent EXACTEMENT
les mêmes noms de fichier ("e-Marque.pdf", "Télécharger_e-Marque_V2.pdf",
"Télécharger_e-Marque_MiniBasket.pdf"), pour des dizaines de numéros de
rencontre DIFFÉRENTS, tous classés `type: "other"` (jamais `emarque_zip`).
Ces noms sont ceux des liens de téléchargement du LOGICIEL e-Marque
(l'appli de saisie desktop), pas des documents d'UN match — un contenu
permanent, identique sur n'importe quelle page FBI.

**Cause racine** : `findEmarqueDocuments` (`browser-client.ts`) enchaîne
trois étapes de navigation volontairement "best effort" (`tryNavigate
ToSearchScreen`/`trySearchByMatchNumber`/`tryOpenMatchResult`, chacune
avale ses propres erreurs — conçu ainsi faute d'avoir pu observer le vrai
markup FBI, voir plus haut) puis scanne la page COURANTE, quelle qu'elle
soit, via `findDocumentLinks` — dont `DOCUMENT_EXTENSION_PATTERN` matche
N'IMPORTE QUEL lien `.pdf`/`.zip` sur la page, indépendamment du texte.
Si les trois étapes échouent silencieusement (sélecteurs qui ne
correspondent pas au vrai FBI), on reste sur la page où on était déjà
(probablement l'accueil post-login) — et ses liens permanents
"Télécharger e-Marque" matchent l'extension `.pdf`, remontés à tort comme
documents DE LA rencontre demandée. Le job se marquait alors "réussi" à
chaque fois : succès silencieux sur des données fausses, pire qu'un échec
visible.

**Corrigé** : `findEmarqueDocuments` vérifie maintenant explicitement
(`selectors.pageMentionsMatchNumber`) que la page atteinte mentionne bien
le numéro de rencontre demandé AVANT de faire confiance à
`findDocumentLinks` — sinon elle lève `EMARQUE_MATCH_PAGE_NOT_REACHED`
(diagnostic : titre + URL de la page réellement atteinte, exploitable
depuis les logs Vercel exactement comme pour le diagnostic de login
plus haut dans ce document). Le job passe alors en erreur/replanifié
(`emarque_status: error`, `last_error` renseigné) plutôt qu'en faux
succès. Les sélecteurs de navigation réels (pourquoi les trois étapes
échouent) restent À DÉTERMINER — cette correction ne les répare pas,
elle empêche seulement l'échec de navigation de produire des données
fausses. Prochaine étape si le problème persiste après ce correctif :
récupérer le diagnostic (titre/URL de la page réellement atteinte) depuis
les logs Vercel d'un prochain job en échec, pour ajuster les sélecteurs
de `tryNavigateToSearchScreen`/`trySearchByMatchNumber`/`tryOpenMatchResult`
sur le VRAI markup FBI (même méthode que pour le formulaire de login).

**Nettoyage** : les documents déjà téléchargés à tort (type `other`,
noms génériques) n'ont pas été supprimés en base à ce stade — ils sont
inertes (jamais matchés par `parseDownloadedEmarqueDocuments`, qui ne
regarde que `type = emarque_zip`), donc sans risque immédiat, mais
polluent `match_documents`. Nettoyage différé, pas demandé.

**Incident — la boucle auto (§10 de la demande, SCSB) a fait échouer ~190
connexions FBI en quelques minutes.** Livré sans aucun garde-fou de
rythme : `ProcessFbiJobsButton` rappelait `POST .../fbi/process-jobs` en
boucle immédiatement après chaque réponse, sans pause. Constaté en
production quelques minutes après déploiement : `fbi_integration_status.
last_error` passe de "Connecté ✅" à "Formulaire de connexion FBI non
reconnu (aucun champ mot de passe trouvé)" — `LOGIN_FORM_NOT_RECOGNIZED`
au niveau du LOGIN lui-même (`HttpFbiClient`/`BrowserFbiClient`), pas de
la découverte de documents. Classé `AUTH_FLOW_CHANGED` par
`classifyFbiLoginStatus` → jamais retried automatiquement (§ commentaire
`process-discover-emarque.ts` : "ne se corrigera jamais tout seul en
réessayant") → ~190 jobs `discover_emarque` marqués `failed`
PERMANENTS en quelques minutes, alors que des dizaines de connexions
manuelles espacées (~30s+ entre clics) n'avaient jamais déclenché cette
erreur. Signature cohérente avec un blocage anti-bot FBI déclenché par le
rythme (jamais confirmé formellement — aucun accès pour inspecter la
réponse FBI réelle reçue à ce moment-là).

**Réaction immédiate** (pendant l'incident, avant le correctif) :
`fbi_jobs.scheduled_at` des jobs `pending` restants repoussé de 2h en
base directement (arrête la boucle proprement : le prochain lot réclamé
renvoie `claimed: 0`, la boucle s'arrête d'elle-même) ; les ~190 jobs
`failed` par cette erreur précise remis en `pending` (`attempt_count`,
`last_error`, `finished_at` réinitialisés, `scheduled_at` +2h) — la cause
la plus probable étant transitoire (rythme), pas un vrai changement
définitif du formulaire FBI.

**Corrigé** : `ProcessFbiJobsButton` (le seul des deux boutons qui pilote
un vrai login FBI — `ParseFbiDocumentsButton` ne fait que de l'OCR/PDF
local, aucun risque équivalent) ajoute désormais `ROUND_DELAY_MS = 5000`
(pause entre deux lots) ET un coupe-circuit : `MAX_CONSECUTIVE_FULL_
FAILURES = 2` lots consécutifs entièrement en échec (`succeeded === 0`
alors que `claimed > 0`) interrompt la boucle plutôt que de vider toute
la file restante en échecs — un vrai blocage ne se corrige jamais en
insistant plus vite.

**Douzième déclenchement — la boucle auto ne s'arrêtait jamais (même
avec 0 job réellement disponible) : "ligne fantôme" de PostgREST.**
Repéré via les logs Vercel collés par le club juste après le repoussement
des `scheduled_at` (déclenchement précédent) : `"Job FBI réclamé"` avec
`jobId: null, clubId: null, type: null` — alors que `processJobBatch`
vérifie `if (!job) break;` avant de logger quoi que ce soit. Vérifié
directement en SQL : `select * from claim_next_fbi_job_for_club(...)`
quand rien n'est disponible renvoie **une ligne** dont CHAQUE colonne
vaut `null` (`{ id: null, club_id: null, ... }`), jamais zéro ligne — une
fonction PL/pgSQL `returns public.fbi_jobs` (composite, pas `SETOF`) est
appelée comme une fonction SCALAIRE : elle produit toujours exactement
une valeur de sortie, y compris quand cette valeur EST `null` en interne
(`if claimed_job.id is null then return null`) ; PostgREST sérialise
alors un objet aux champs tous `null`, jamais un `null` JSON bare. Ce
même bug affecte `claim_next_fbi_job` (le cron global) depuis le début —
jamais détecté car les tests unitaires existants mockent `{ data: null }`
directement, sans jamais exercer la vraie sérialisation PostgREST.

Conséquence concrète : `processJobBatch`'s `if (!job) break;` ne se
déclenchait JAMAIS (un objet est toujours "truthy" en JS) — `claimed`
était incrémenté à tort à chaque appel, la boucle continuait indéfiniment
(jusqu'à `MAX_ROUNDS`/le coupe-circuit du déclenchement précédent), et
chaque "job fantôme" partait en traitement avec `match_id: null` →
`processDiscoverEmarqueJob` échouait immédiatement à l'étape "Match
introuvable" (AVANT tout contact FBI, donc sans risque de blocage
anti-bot cette fois — les timestamps très rapprochés dans les logs du
club, ~200ms d'écart, en étaient déjà la preuve).

**Corrigé** : `claimNextJob`/`claimNextJobForClub` (`jobs/claim.ts`)
détectent maintenant cette ligne fantôme via `row.id === null` (même
sentinel que la fonction SQL elle-même) et renvoient `null` — jamais une
correction de la fonction SQL (compliquée à faire proprement pour une
fonction à ligne unique appelée via PostgREST), le garde-fou côté
application est plus simple et suffisant. Couvert par un test dans
`claim.test.ts` reproduisant exactement cette forme de réponse.

**Treizième déclenchement — le correctif `EMARQUE_MATCH_PAGE_NOT_REACHED`
avait lui-même un faux positif pour un numéro de rencontre court.** Une
fois les deux correctifs précédents déployés, le club a débloqué 3 jobs
réels pour tester (rencontres n°1, 4516, 1481). Résultat : n°1481 a
correctement échoué avec le diagnostic attendu (page restée sur "FBI -
Accueil") — mais n°1 a "réussi", en remontant EXACTEMENT les mêmes 5
documents génériques que ceux du bug initial ("e-Marque.pdf" ×3,
"Télécharger_e-Marque_V2/MiniBasket.pdf"). Cause : `pageMentionsMatchNumber`
utilisait `.includes(matchNumber)` — un simple test de sous-chaîne. Pour
un numéro à un seul chiffre comme "1", ce test réussit sur N'IMPORTE
QUELLE page contenant un nombre qui contient "1" (ici "2813", visible sur
la page de résultats de recherche par défaut) — donc quasiment n'importe
quelle page, vidant le garde-fou de son utilité pour ce cas.

**Corrigé** : `pageMentionsMatchNumber` recherche maintenant le numéro
comme un nombre ISOLÉ (`(?<!\d)matchNumber(?!\d)`, bordures non-chiffres
des deux côtés) plutôt qu'une sous-chaîne brute — "1" ne matche plus
l'intérieur de "2813" ou "1481". Reste imparfait par construction pour un
numéro à 1-2 chiffres très court (un vrai chiffre isolé identique
ailleurs sur la page resterait un faux positif possible), mais nettement
plus fiable qu'un `.includes()` nu. Testé explicitement contre ce cas
précis (numéro "1", page contenant "2813"). Le job de la rencontre n°1
déjà "réussi" à tort (5 documents génériques déjà en base) devra être
nettoyé et retenté manuellement une fois ce correctif déployé — pas fait
automatiquement, aucun mécanisme de nettoyage rétroactif construit à ce
stade.

## Dérogations / licenciés FBI

Non développé (§60/§40/§41 de la demande — pas de module tables de marque
ni de dérogations à ce stade). Un export XLSX des dérogations et des
routes AJAX de consultation (ex. `afficherLicenceStatistiqueAjax.fbi`,
classée READ_ONLY par `action-classification.ts`) ont été rapportés lors
d'un spike antérieur côté SCSB (`docs/FBI_AUTHENTICATED_SPIKE.md`, jamais
confirmé indépendamment). Point d'extension prévu mais non implémenté :
une méthode `listDerogations()` sur l'interface `FbiAutomationClient`.
