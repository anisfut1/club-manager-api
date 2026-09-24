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
déjà "réussi" à tort (5 documents génériques déjà en base) a été nettoyé
manuellement en base (SQL direct) et remis en attente.

**Quatorzième déclenchement — même faux positif persistant après le
correctif ci-dessus, toujours sur la rencontre n°1.** Une fois le
correctif "nombre isolé" déployé, la rencontre n°1 a de nouveau "réussi"
avec EXACTEMENT les mêmes 5 documents génériques — alors que n°4516 et
n°1481, elles, échouaient correctement avec le diagnostic attendu. Cause
trouvée : `pageMentionsMatchNumber` protège bien la vérification FINALE,
mais `tryOpenMatchResult` (l'étape de navigation qui clique sur le
résultat de recherche) utilisait ENCORE `getByText(matchNumber, { exact:
false })` — un test de sous-chaîne — AVANT cette vérification. Pour "1",
ça cliquait le premier élément de la page contenant "1" n'importe où (ex:
un lien de pagination "page 10"), atterrissant sur une page DIFFÉRENTE de
la page d'accueil (donc pas rattrapée par le garde-fou précédent) mais
qui n'est toujours pas la vraie page de la rencontre — et qui contenait,
par coïncidence ou par structure de page générique, de quoi passer aussi
le test "nombre isolé" (une page réellement inconnue peut légitimement
contenir un "1" isolé n'importe où : numéro de version, élément de liste,
etc.).

**Corrigé** : nouvelle fonction partagée `selectors.matchNumberAsIsolatedText`
(même regex bordures non-chiffres que `pageMentionsMatchNumber`, factorisée)
— `tryOpenMatchResult` l'utilise maintenant pour son `getByText(...)` AU
LIEU de `{ exact: false }`, donc ne clique plus jamais un élément dont le
texte ne contient le numéro que comme fragment d'un nombre plus grand.
Testé explicitement : une page de résultats sans correspondance réelle
mais contenant un lien décorateur "Voir la page 10" ne doit jamais être
cliquée pour la rencontre "1", jamais aboutir à `EMARQUE_MATCH_PAGE_NOT_
REACHED` cette fois via un vrai chemin de clic plutôt qu'une coïncidence
de texte. Rencontre n°1 de nouveau nettoyée en base — À CONFIRMER une
fois ce troisième correctif déployé : si le problème persiste encore
pour ce numéro précis, la piste la plus probable devient l'observation
directe du VRAI markup FBI (impossible depuis cet environnement, réseau
*.ffbb.com bloqué) plutôt qu'un nouvel ajustement de regex à l'aveugle —
les numéros n°4516/n°1481 étant, eux, correctement diagnostiqués à
chaque tentative, le cœur du correctif (distinguer succès réel d'échec
silencieux) est validé ; seule la fragilité inhérente d'un numéro à un
seul chiffre reste en jeu.

**Quinzième déclenchement — "3 jobs traités, 3 réussis" affiché côté
SCSB alors qu'un seul avait réellement abouti.** Après déploiement des
correctifs ci-dessus, le club a reclique sur "Traiter les jobs FBI en
attente" : le bouton a affiché un succès complet pour un lot de 3, mais
les logs Vercel montraient deux `FbiError EMARQUE_MATCH_PAGE_NOT_REACHED`
(n°1481 et n°4516) DANS CE MÊME LOT, et la base ne montrait qu'UN SEUL
job réellement `finished_at`/`succeeded` (n°1) sur toute la fenêtre —
les deux autres étaient simplement repassés en `pending` (replanifiés).

**Cause** : `processDiscoverEmarqueJob`/`processTestConnectionJob` gèrent
LEURS PROPRES échecs en interne (`rescheduleJob`/`failJob`, voir plus
haut) et ne lèvent JAMAIS d'exception vers leur appelant, par design (pour
que la boucle de `processJobBatch` ne plante jamais sur un job en
particulier). Mais `processJobBatch` comptait `succeeded += 1` dès que
l'appel `await processXxxJob(...)` se terminait SANS lever d'exception —
confondant "n'a pas crashé" avec "a réellement réussi". Un job simplement
replanifié (page introuvable, rien à télécharger pour l'instant) se
comptait donc TOUJOURS comme un succès dans le résultat agrégé renvoyé à
SCSB, même si la vraie ligne `fbi_jobs` repassait en `pending`.

**Corrigé** : les deux fonctions renvoient maintenant `Promise<boolean>`
(`true` UNIQUEMENT sur le chemin qui atteint réellement `status:
"succeeded"`, `false` sur tout chemin de reschedule/fail interne) au lieu
de `Promise<void>` — `processJobBatch` utilise cette valeur de retour au
lieu de la simple absence d'exception. Le `catch` autour de l'appel reste
en place pour le cas vraiment inattendu (crash avant que la fonction
gère elle-même son erreur). Couvert par deux tests dans
`process-batch.test.ts` : un job qui lève toujours compté en échec
(inchangé), et un NOUVEAU test explicite pour un job qui renvoie `false`
SANS lever d'exception — le vrai scénario de cette régression.

**Seizième déclenchement — le blocage ne dépend pas du numéro de
rencontre : TOUS les matchs testés restent sur "FBI - Accueil".** Une
fois le correctif de comptage déployé, le club a de nouveau cliqué
"Traiter les jobs FBI en attente" : la file globale (416 jobs, backlog
complet, plus seulement les 3 numéros de test) a recommencé à défiler.
Nouvel échec observé, rencontre n°752 (jamais testée avant, numéro à 3
chiffres, aucune ambiguïté possible avec un chiffre isolé) — même
diagnostic EXACT que n°1481/n°4516 : page actuelle "FBI - Accueil",
`https://extranet.ffbb.com/fbi/accueil.fbi`. Ce n'est donc PAS un
problème de longueur de numéro (les correctifs précédents sur ce point
restent corrects et nécessaires, mais ne sont pas la cause racine) : la
navigation ne quitte JAMAIS la page d'accueil post-login, pour AUCUN
numéro testé jusqu'ici. Suspect le plus probable :
`tryNavigateToSearchScreen` (`browser-client.ts`), le tout premier clic
best-effort — `page.getByRole("link", { name: /rencontre|compétition|
calendrier/i })` — ne trouve rien sur le VRAI accueil FBI (libellé
différent, élément qui n'est pas un `role=link`, etc.), jamais observable
depuis cet environnement (réseau `*.ffbb.com` bloqué).

**Corrigé (diagnostic, pas une correction de sélecteur — pas assez
d'évidence pour deviner un quatrième correctif à l'aveugle)** :
`EMARQUE_MATCH_PAGE_NOT_REACHED` inclut désormais la liste des liens
RÉELLEMENT visibles sur la page bloquée (`selectors.listVisibleLinks`,
texte + href, plafonné à 25) dans son message. Le prochain échec en
production révélera les libellés réels de navigation disponibles sur
l'accueil FBI, permettant d'ajuster `tryNavigateToSearchScreen` sur le
VRAI markup plutôt que sur une hypothèse — même méthode que celle qui a
permis de corriger le formulaire de login au tout début de cette
intégration. **Prochaine étape explicite** : récupérer le message
d'erreur complet du prochain job en échec (logs Vercel ou colonne
`fbi_jobs.last_error`) et l'analyser avant tout nouveau correctif de
sélecteur.

**Dix-septième déclenchement — le dump de liens révèle le MENU GLOBAL
ffbb.com, pas la navigation FBI ; trace étape par étape ajoutée.** Le
diagnostic ci-dessus a livré ses premiers résultats en production
(rencontre n°178) : les 25 premiers liens de la page "FBI - Accueil"
sont "Fédération", "Compétitions", "La Boulangère Wonderligue", "Ligue
Féminine 2", "Coupe de France", "Billetterie", "FFBB Store", "e-Marque"
(→ `ffbb.com/e-marque-v2`, confirme définitivement l'origine des
documents génériques du tout premier bug de cette section), "Calendriers",
"Désignations arbitrage" (→ pointe vers `connexion.fbi`, pas une page
FBI authentifiée), etc. — c'est le MENU GLOBAL du portail ffbb.com
(fédération, compétitions, boutique...), embarqué comme en-tête
persistant sur la page FBI, pas une navigation spécifique à l'extranet
FBI. Il matche `/compétition|calendrier/i` (§ `tryNavigateToSearchScreen`)
alors que ce lien mène à un AUTRE DOMAINE (`competitions.ffbb.com`),
jamais la recherche de rencontre FBI elle-même.

Ce dump de liens (plafonné à 25) ne suffisait PAS à savoir si le clic
avait seulement échoué, ou avait réussi mais changé de domaine sans
jamais revenir sur une page utile : il manquait une TRACE de ce que
chaque étape avait réellement fait. **Corrigé** : `tryNavigateToSearchScreen`/
`trySearchByMatchNumber`/`tryOpenMatchResult` renvoient chacune une
phrase de diagnostic (élément trouvé ou non, clic réussi ou non, URL
avant/après) au lieu de `Promise<void>` — la prochaine
`EMARQUE_MATCH_PAGE_NOT_REACHED` inclura une "Trace de navigation : [1]
... — [2] ... — [3] ..." précise, en plus de la liste de liens (portée à
60 pour dépasser le menu global répété et atteindre, si elle existe,
une vraie navigation FBI plus bas dans le DOM). **Prochaine étape** :
lire cette trace sur le prochain échec — si l'étape [1] montre que le
clic change bien de domaine vers `competitions.ffbb.com` (confirmant
l'hypothèse ci-dessus), la vraie correction sera de RETIRER
`compétition|calendrier` du regex de `tryNavigateToSearchScreen` (garder
`rencontre` seul, ou cibler un lien spécifiquement DANS le domaine
`extranet.ffbb.com`) et/ou chercher directement le champ de recherche
sans cette étape de clic intermédiaire, désormais contre-productive.

**Dix-huitième déclenchement — navigation reconstruite à partir d'une
capture d'écran du VRAI FBI, plus jamais devinée.** Après dix-sept
tentatives de correctifs basés uniquement sur des messages d'erreur et
des dumps de liens (jamais le markup réel, le réseau `*.ffbb.com` étant
bloqué depuis cet environnement — voir `docs/FBI_AUTHENTICATED_SPIKE.md`),
le club a fourni la première preuve visuelle directe de cette
intégration : deux captures d'écran de
`https://extranet.ffbb.com/fbi/rechercherRencontreSaisieResultat.fbi`
(l'écran de recherche de rencontre lui-même, et son tableau de
résultats). Elles révèlent :

- L'URL exacte de l'écran de recherche : `rechercherRencontreSaisieResultat.fbi`
  — jamais un lien à deviner/cliquer depuis l'accueil.
- Le tableau de résultats a des colonnes `Division | N° | Equipe 1 |
  Equipe 2 | Date de rencontre | Heure | Salle | EM | Score...`.
- La colonne **"EM"** contient le document e-Marque : un code cliquable
  (ex. "DCBLRCA7") ou une icône "FDM" pour une rencontre déjà jouée avec
  un e-Marque disponible, **vide** sinon (rencontre pas encore jouée, ou
  sans e-Marque) — ce n'était PAS un lien texte générique ("feuille de
  match", etc.) à chercher n'importe où sur la ligne ou la page, comme le
  supposait tout le code précédent.

**Corrigé — réécriture complète des trois étapes de navigation sur cette
base, jamais sur une hypothèse** :

- `tryNavigateToSearchScreen` navigue maintenant DIRECTEMENT vers
  `{baseUrl}/rechercherRencontreSaisieResultat.fbi` (`page.goto`) au lieu
  de chercher un lien à cliquer depuis l'accueil — élimine d'un coup
  toute la classe de bugs des seizième/dix-septième déclenchements
  (lien introuvable, ou menu global ffbb.com cliqué par erreur). L'ancien
  clic sur un lien de même origine reste en repli si cette URL directe
  échoue, au cas où elle ne serait pas valide pour tous les
  rôles/contextes FBI.
- `trySearchByMatchNumber` clique désormais le bouton "RECHERCHER"
  (`selectors.searchSubmitControl`, type submit en priorité) plutôt que
  de compter sur `Enter` seul (un formulaire non natif peut intercepter
  la soumission en JS).
- `tryOpenMatchResult` utilise un nouveau sélecteur
  `selectors.emarqueColumnLinkForMatch` : il lit l'index des colonnes
  "N°" et "EM" depuis les EN-TÊTES du tableau (jamais une position
  `nth-child` câblée en dur, conformément à la philosophie du fichier —
  voir l'en-tête de `selectors.ts`), trouve la ligne dont la cellule "N°"
  correspond EXACTEMENT (pas une sous-chaîne) au numéro recherché, puis
  clique le lien/bouton de SA cellule "EM" — renvoie `null` (jamais une
  erreur) si le tableau n'a pas cette forme, si la ligne n'existe pas, ou
  si sa colonne EM est vide (match pas encore joué : cas légitime, pas un
  échec).

**Découvert en écrivant les tests contre cette nouvelle logique (jamais
en production) — deux bugs supplémentaires, corrigés avant tout
déploiement** :

1. Le serveur HTTP de test synthétique (`src/test-support/static-server.ts`,
   utilisé UNIQUEMENT par les tests, jamais par le vrai FBI) ne déclarait
   pas `charset=utf-8` sur ses réponses `text/html` : Chromium décodait
   alors les octets UTF-8 du fichier fixture avec un autre charset par
   défaut, transformant "N°" en "NÂ°" — la recherche de colonne par
   libellé échouait donc silencieusement même avec la bonne logique.
   Corrigé en ajoutant `; charset=utf-8` aux réponses textuelles qui n'en
   déclarent pas déjà un.
2. Une fois ce problème d'encodage réglé, un test délibérément conçu pour
   piéger un faux positif de numéro court ("1") a quand même échoué :
   rester sur la page de résultats (ligne "1" introuvable, donc
   `emarqueColumnLinkForMatch` renvoie `null`) puis vérifier avec
   `pageMentionsMatchNumber` sur le texte ENTIER de la page matchait à
   tort — l'en-tête de colonne **"Score 1"** contient lui-même un "1"
   isolé (précédé d'un espace, suivi d'un saut de ligne), sans rapport
   avec le numéro de rencontre recherché. Corrigé avec un nouveau
   sélecteur `matchNumberInResultsTable` : quand un tableau de résultats
   est présent sur la page courante, la vérification finale de
   `findEmarqueDocuments` compare désormais la cellule "N°" de chaque
   ligne EXACTEMENT au numéro recherché (aucun risque de faux positif
   textuel) plutôt que de scanner tout le texte de la page ; le texte de
   page libre (`pageMentionsMatchNumber`) reste le seul recours sur une
   page SANS tableau (ex. la page de détail atteinte après un clic sur le
   lien EM).

Couvert par une réécriture complète de la fixture de test
(`__fixtures__/rechercher-rencontre.html`, qui reproduit fidèlement la
structure de colonnes observée) et du bloc de tests
`BrowserFbiClient.findEmarqueDocuments` (`browser-client.test.ts`) :
succès (colonne EM avec code cliquable), liste vide sans erreur (colonne
EM vide, rencontre pas encore jouée), `EMARQUE_MATCH_PAGE_NOT_REACHED`
pour une rencontre absente du tableau, et spécifiquement la régression du
faux positif "1"/"Score 1" décrite ci-dessus. C'est la première
correction de cette section entièrement basée sur une observation directe
du vrai FBI plutôt que sur une inférence à partir de logs d'erreur —
confiance nettement plus élevée que les dix-sept précédentes, mais reste
non confirmée en production tant que le prochain déploiement n'aura pas
été testé sur un vrai match SC Sète.

**Dix-neuvième déclenchement — la navigation directe fonctionne enfin
(première fois que la page réelle de recherche est atteinte en
production), mais le champ de recherche sélectionné est une checkbox.**
Test isolé sur 3 matchs réels (2813, 1481, 4516, file d'attente réduite
volontairement à ces 3 jobs pour ne pas bombarder FBI de requêtes
pendant le débogage) après déploiement du correctif précédent :

- **Étape [1] (navigation) RÉUSSIE** pour la première fois de toute cette
  série de corrections — `page.title()` confirme "FBI - Rechercher une
  rencontre pour la saisie des résultats", exactement la page attendue.
  Valide définitivement l'URL `rechercherRencontreSaisieResultat.fbi` et
  l'abandon de l'ancienne stratégie de clic sur un lien depuis l'accueil.
- **Étape [2] (remplissage du champ) EN ÉCHEC** : `locator.fill: Error:
  Input of type "checkbox" cannot be filled`. Le formulaire réel contient
  une checkbox "non joué" avec l'attribut
  `name="rechercheRencontreSaisieResultatForm.rechercherRencontreSaisieResultatBean.nonJoue"`
  — elle matche le motif `input[name*="rencontre" i]` de
  `selectors.matchNumberSearchInput` tout autant qu'un vrai champ texte.
  Playwright résout une liste de sélecteurs CSS séparés par des virgules
  dans l'ORDRE DU DOM (comme `querySelectorAll`), jamais dans l'ordre
  d'écriture des alternatives du code : cette checkbox apparaît AVANT le
  vrai champ numéro dans le markup réel, donc `.first()` la sélectionnait
  à tort.

**Corrigé** : `matchNumberSearchInput` exclut désormais explicitement les
types non-texte (`checkbox`, `radio`, `hidden`, `submit`, `button`) de
chacune de ses alternatives — élimine ce faux positif quel que soit
l'ordre du DOM, sans avoir à deviner une position ou un ordre de
priorité. La fixture `__fixtures__/rechercher-rencontre.html` reproduit
maintenant fidèlement cette checkbox (même `name`, placée avant le champ
texte) pour que le test de bout en bout (`browser-client.test.ts`,
premier test du bloc `findEmarqueDocuments`) couvre cette régression
exacte en continu.

**Méthode de test adoptée pour la suite** : plutôt que de relancer les
~400 jobs `discover_emarque` en attente à chaque itération (risque de
marteler FBI avec des identifiants réels pendant qu'on corrige des bugs
un par un), les jobs de TOUS les autres matchs sont repoussés de 30 jours
(`fbi_jobs.scheduled_at`) et seuls 2813/1481/4516 restent immédiatement
réclamables. Réinitialisés à chaque nouveau correctif (`attempt_count`,
`last_error`, `scheduled_at` remis à zéro) pour un cycle de test rapide
et ciblé. Le reste de la file ne sera réactivé qu'une fois ces 3 matchs
validés de bout en bout (document téléchargé ET parsé).

**Suite immédiate — le correctif checkbox déployé, la recherche
"réussit" mais ne renvoie AUCUNE ligne.** Nouveau test en production sur
les 3 mêmes matchs isolés : l'étape [2] montre cette fois `champ rempli
("2813") et recherche soumise, mais l'URL n'a pas changé` — le
remplissage/la soumission n'ont plus levé d'exception (la checkbox n'est
plus ciblée). Mais l'étape [3] ne trouve toujours aucun lien e-Marque, et
la liste des liens visibles ne contient AUCUNE trace de tableau de
résultats (seulement le menu global permanent) — pour un match RÉELLEMENT
joué (n°2813, score connu, preuve visuelle du code EM). Ce n'est donc pas
un problème de sélecteur de lien, mais une recherche qui n'a
véritablement rien retourné.

Hypothèse à vérifier sur preuve, pas à deviner (le réseau `*.ffbb.com`
reste bloqué depuis cet environnement) : un formulaire de ce type a très
probablement d'autres champs obligatoires que "N° Rencontre" — en
particulier une **saison** — qui filtrent la recherche. Les 3 matchs
testés datent tous de la saison 2025-2026 (joués entre septembre 2025 et
mai 2026) ; la date du jour en production est le 2026-09-24, donc en
saison 2026-2027. Si un sélecteur de saison sur cette page défaute sur la
saison EN COURS plutôt que sur celle du match recherché, la recherche ne
peut jamais aboutir, quel que soit le champ numéro ciblé.

**Corrigé (diagnostic, encore une fois — pas assez de preuve pour deviner
un cinquième champ à l'aveugle)** : `selectors.listFormFields` dump
désormais TOUS les champs du formulaire de la page (input/select/textarea),
avec pour un `<select>` le LIBELLÉ de l'option actuellement sélectionnée
— inclus dans le message `EMARQUE_MATCH_PAGE_NOT_REACHED` aux côtés de la
trace de navigation et des liens visibles. Le prochain échec révélera
l'état réel de chaque champ (nom du champ numéro ciblé également ajouté à
la trace de `trySearchByMatchNumber`, pour confirmer qu'il s'agit bien du
bon champ et pas d'un homonyme).

**Corrigé en même temps (bug réel, découvert en écrivant le test du
diagnostic ci-dessus, jamais en production)** : `matchNumberSearchInput`
combinait ses 4 alternatives dans un seul sélecteur CSS `a, b, c, d` —
résolu par Playwright dans l'ORDRE DU DOM, jamais dans l'ordre d'écriture
des alternatives (même piège que la checkbox du déclenchement précédent,
sous une forme différente : n'importe quel AUTRE champ texte matchant
`rencontre` avant le vrai champ "numero" dans le markup aurait pu être
ciblé à tort). Résout maintenant chaque alternative dans l'ordre de
priorité écrit dans le code (renvoie la première dont au moins un élément
existe), jamais une seule requête CSS fusionnée.

Couvert par une nouvelle fixture (`rechercher-rencontre.html`) qui ajoute
un `<select name="saison">` (option "2026-2027" sélectionnée) avant la
checkbox et le champ texte, et un nouveau test qui vérifie que le message
d'erreur contient `champ "numeroRencontre" rempli` (jamais supposé) et
`select[name=saison]="2026-2027"` dans le dump des champs de formulaire.

**Vingtième déclenchement — le dump révèle la cause racine définitive :
deux filtres par défaut, pas un problème de sélecteur.** Nouveau test en
production sur les 3 mêmes matchs isolés (2813, 1481, 4516), avec le
diagnostic du déclenchement précédent activé. Le dump complet du
formulaire confirme, sur preuve directe cette fois (jamais une
hypothèse) :

- `input[type=checkbox,name=...nonJoue]="true"` — la checkbox "non joué"
  (résultat pas encore saisi) est **cochée par défaut**. Cette page
  (`rechercherRencontreSaisieResultat.fbi` = écran de SAISIE de
  résultat) filtre donc naturellement aux rencontres dont le résultat
  n'est pas encore homologué — jamais les matchs déjà joués, précisément
  ceux qui ont un document e-Marque disponible.
- `select[name=...idSaison]="Saison 2026-2027"` — le sélecteur de saison
  défaute sur la saison EN COURS. Les 3 matchs de test datent tous de la
  saison 2025-2026 (joués entre septembre 2025 et mai 2026) ; la
  production tourne le 2026-09-24, donc en saison 2026-2027.

Ces deux filtres, actifs par défaut, expliquent à eux seuls tous les
échecs "recherche réussie mais aucun résultat" observés depuis le
Dix-neuvième déclenchement — indépendamment de tout bug de sélecteur.

**Corrigé** : nouvelle étape `tryPrepareSearchFilters` (entre la
navigation et la recherche par numéro) qui, à chaque appel de
`findEmarqueDocuments` :

1. Décoche systématiquement la case "non joué" si elle est cochée
   (`selectors.nonJoueCheckbox`, `Locator.isChecked()`/`uncheck()` — on
   ne cherche jamais un match "non joué" ici, quel que soit le match).
2. Sélectionne, dans `selectors.seasonSelect`, l'option dont le LIBELLÉ
   contient la saison du match (`Locator.selectOption()`) — jamais une
   valeur d'`<option>` devinée. La saison est calculée par l'appelant
   (`resolveSeasonLabel(match.match_datetime)`, déjà utilisée par
   ailleurs pour le chemin de stockage Supabase, désormais aussi passée
   à `findEmarqueDocuments` en 3ᵉ paramètre) AVANT l'appel, plutôt que
   recalculée en double.

La trace de navigation passe de 3 à 4 étapes (`[1]` navigation, `[2]`
préparation des filtres, `[3]` recherche par numéro, `[4]` ouverture du
résultat). Couvert par un nouveau test qui vérifie que le message
d'erreur contient `case "non joué" décochée`, `saison "Saison 2025-2026"
sélectionnée`, et que l'URL de soumission du formulaire contient
effectivement `idSaison=12` (la valeur de l'option choisie) — preuve que
la sélection a réellement été soumise, pas juste rapportée dans la
trace.

**Vingt-et-unième déclenchement — saison corrigée en production
(confirmée "Saison 2025-2026" dans le dump), mais toujours aucun
résultat ; deux angles morts du diagnostic comblés.** Nouveau test sur
les 3 mêmes matchs isolés après déploiement du correctif de saison. Le
dump confirme que la saison est bien passée à "Saison 2025-2026" — mais
la recherche pour n°2813 (preuve visuelle du code EM) ne trouve toujours
rien. Deux limites du diagnostic empêchaient d'aller plus loin :

1. `listFormFields` ne listait QUE `input`/`select`/`textarea` — jamais
   les `<button>`. Impossible de vérifier si `searchSubmitControl` avait
   réellement ciblé le bouton "RECHERCHER" plutôt qu'un autre bouton du
   même formulaire.
2. Le dump affichait la valeur de SOUMISSION fixe (`value="true"`) d'une
   checkbox comme si c'était son état coché — deux choses différentes.
   Ça avait fait conclure à tort, au déclenchement précédent, que la
   checkbox "non joué" était cochée par défaut alors que ce n'était pas
   prouvé (elle s'est révélée déjà décochée à l'exécution, la trace ne
   mentionnant "décochée" que quand une action a réellement eu lieu).

**Corrigé** : `listFormFields` inclut maintenant les `<button>` (texte
visible comme "valeur"), et lit l'état RÉEL d'une checkbox/radio via
`Locator.isChecked()` (`"checked"`/`"unchecked"`) au lieu de son
attribut `value` figé. Le texte du bouton effectivement cliqué est aussi
ajouté à la trace de `trySearchByMatchNumber`.

**Corrigé en même temps (amélioration défensive, pas une preuve directe
d'un bug — les noms de champs `identificationForm.identificationBean`,
`rechercheRencontreSaisieResultatForm...` évoquent une appli Java legacy
de type JSF, où un bouton peut soumettre en AJAX sans navigation ni
changement d'URL)** : `trySearchByMatchNumber` attend désormais AUSSI
`page.waitForLoadState("networkidle", { timeout: 5000 })` (best-effort,
en plus du délai fixe existant) après avoir soumis la recherche — un
délai fixe de 500ms pourrait ne pas suffire à un aller-retour serveur
réel en production pour un formulaire soumis en XHR.

Couvert par des tests étendus qui vérifient la présence de
`button[type=submit,name=]="RECHERCHER"` et `bouton "RECHERCHER"
cliqué"` dans le message, ainsi que le nouveau format `"checked"` (au
lieu de l'ancien `"true"` trompeur) pour l'état d'une checkbox.
**Prochaine étape** : le prochain échec en production révélera enfin,
sur preuve, si le bon bouton est ciblé et si un problème de timing AJAX
était en jeu — ou pointera vers autre chose (ex. un des champs encore
sur leur valeur "placeholder" : `idDivision`, `idPoule`, `numeroEquipe`).

**Vingt-deuxième déclenchement — PREMIER SUCCÈS DE BOUT EN BOUT (rencontre
n°1481, 5 documents "téléchargés"), mais deux nouveaux bugs découverts en
creusant le résultat : timeout d'infrastructure bloquant la file, et
documents leurres/dupliqués téléchargés au lieu des vraies données du
match.** Nouveau test sur les 3 mêmes matchs isolés après déploiement du
correctif précédent (dump des boutons + attente réseau) :

1. **`Job discover_emarque réussi`, n°1481, `documentsDownloaded: 5`** —
   la toute première fois, dans cette série de vingt et un correctifs,
   qu'un job atteint réellement `status: "succeeded"` contre le vrai FBI.
   Confirme que la navigation, le remplissage, la saison, la case "non
   joué" et le clic du bouton RECHERCHER fonctionnent tous ensemble.
2. **Immédiatement après, `Vercel Runtime Timeout Error: Task timed out
   after 300 seconds`** pendant le traitement du job suivant (n°4516,
   même lot de 3). Le job n°1481 a pris ~3min30 contre le vrai FBI (bien
   plus lent que les fixtures locales) — un lot de 3 jobs réels dépasse
   `maxDuration: 300`. Le process tué EN PLEIN TRAITEMENT du job suivant
   ne peut jamais exécuter son `finally` (fermeture de session/browser,
   `browser-client.ts`) : ce job reste bloqué en `status = 'claimed'`
   indéfiniment, ce qui bloque ENSUITE tout nouveau job pour ce club via
   la contrainte "un seul job actif par club" — constaté par une requête
   SQL directe, débloqué manuellement une première fois.

   **Corrigé** : `CLUB_JOB_BATCH_SIZE` (`routes.ts`) et `JOB_BATCH_SIZE`
   (`api/internal/index.ts`, cron) réduits de 3 à 1 — un seul job réel
   par invocation, largement sous `maxDuration: 300`. Le bouton "Traiter
   les jobs FBI en attente" boucle déjà automatiquement côté SCSB, donc
   aucune perte fonctionnelle. **ET** : migration
   `20260924140000_fbi_jobs_claim_stale_recovery.sql` — la garde "un seul
   job actif par club" des deux fonctions `claim_next_fbi_job*` n'exclut
   désormais que les jobs `claimed`/`running` dont `claimed_at` est
   RÉCENT (< 10 minutes, largement au-dessus de `maxDuration` lui-même) :
   un job plus vieux que ça a forcément été tué par un timeout/crash, il
   ne bloque plus jamais la file indéfiniment — auto-guérison, plus
   besoin d'intervention manuelle en base.

3. **En inspectant les "5 documents téléchargés" pour n°1481** (le club a
   demandé pourquoi "Traiter les documents téléchargés" ne trouvait rien
   à parser malgré ce succès) : 4 lignes `match_documents` réellement
   présentes, TOUTES de type `other` (jamais `emarque_zip` — le seul type
   que `parseDownloadedEmarqueDocuments` traite, par design, voir le
   commentaire en tête de ce fichier : les documents séparés n'ont pas de
   parseur dédié). Mais surtout : l'une d'elles est
   `T_l_charger_e-Marque_V2.pdf` ("Télécharger e-Marque V2.pdf") — EXACTEMENT
   le lien-leurre du LOGICIEL e-Marque déjà identifié aux Quinzième/
   Seizième déclenchements sur l'accueil FBI, cette fois trouvé sur LA
   PAGE DE DÉTAIL atteinte après le clic sur le lien EM lui-même (jamais
   vérifié avant, faute d'un succès pour l'observer). Et 3 lignes
   nommées identiquement `e-Marque.pdf`, au MÊME `storage_path` (donc
   s'écrasant mutuellement dans Storage) — un même lien de document
   dupliqué 3 fois dans le DOM (même phénomène que le menu global déjà
   observé dupliqué 2-3 fois dans `listVisibleLinks`).

   **Corrigé** : `findDocumentLinks` (`selectors.ts`) exclut désormais
   explicitement les liens correspondant au logiciel e-Marque
   (`SOFTWARE_DOWNLOAD_PATTERN` : "e-Marque V2", "MiniBasket", "logiciel",
   "installer" — le motif générique `e-?marque` de
   `DOCUMENT_LABEL_PATTERN` les matchait à tort) et déduplique par `href`
   (jamais deux fois le même lien). `fileNameFromLabelOrUrl`
   (`browser-client.ts`) ajoute un court hash de l'URL au nom de fichier
   dérivé du libellé (repli générique, quand l'URL elle-même n'a pas
   d'extension exploitable) : deux documents DIFFÉRENTS au même libellé
   visible ("e-Marque") ne produisent plus jamais le même nom de fichier,
   donc plus jamais le même `storage_path` — élimine la classe de bug
   "écrasement silencieux en Storage" pour de bon, pas seulement pour ce
   cas précis.

Documents leurres/dupliqués supprimés manuellement pour n°1481
(`match_documents`), `emarque_status` et jobs des 3 matchs de test
remis à zéro pour un nouveau cycle de test propre. **Toujours ouvert** :
aucun des documents découverts pour n°1481 n'était un `.zip` — reste à
confirmer si CE match n'expose vraiment que des PDF séparés (auquel cas
le pipeline de parsing automatique, qui ne traite que les ZIP, ne
s'appliquera jamais à lui) ou si la vraie page de détail expose aussi un
ZIP que la découverte n'a pas trouvé — seul un prochain succès "propre"
(post-correctifs ci-dessus) le confirmera.

**Vingt-troisième déclenchement — le chemin "aucun document trouvé" (retry
silencieux) n'avait AUCUN diagnostic, contrairement au chemin d'échec dur.**
Nouveau test sur les 3 matchs isolés après déploiement des correctifs
précédents (batch size 1, auto-guérison, exclusion leurre/dédup) : la
rencontre n°2813 (preuve visuelle du code EM "DCBLRCA7") ressort avec
`documents.length === 0` — `processDiscoverEmarqueJob` traite ça comme un
cas légitime ("pas encore de document disponible"), reschedule
silencieusement, sans lever `EMARQUE_MATCH_PAGE_NOT_REACHED` et donc SANS
la trace de navigation/dump de champs/liens visibles qu'on a mis deux
déclenchements à construire. Un match confirmé comme ayant un vrai
document qui ressort à zéro mérite la même preuve qu'un échec dur — sinon
le prochain cycle repart à l'aveugle.

**Corrigé** : `findEmarqueDocuments` (`browser-client.ts`) logue
désormais (`logInfo`, jamais une exception — ce cas reste légitime et le
retry programmé reste le bon comportement) la trace de navigation
complète ET les liens visibles de la page dès que `documents.length ===
0` APRÈS confirmation qu'on est sur la bonne page pour ce match — visible
dans les logs Vercel au prochain passage, sans attendre un échec dur.

## Dérogations / licenciés FBI

Non développé (§60/§40/§41 de la demande — pas de module tables de marque
ni de dérogations à ce stade). Un export XLSX des dérogations et des
routes AJAX de consultation (ex. `afficherLicenceStatistiqueAjax.fbi`,
classée READ_ONLY par `action-classification.ts`) ont été rapportés lors
d'un spike antérieur côté SCSB (`docs/FBI_AUTHENTICATED_SPIKE.md`, jamais
confirmé indépendamment). Point d'extension prévu mais non implémenté :
une méthode `listDerogations()` sur l'interface `FbiAutomationClient`.
