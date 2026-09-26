import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { FbiError } from "./errors.js";
import * as selectors from "./selectors.js";
import { normalizeScheduleRow } from "./schedule-row.js";
import { normalizeDerogationRow } from "./derogation-row.js";
import type { FbiDerogationDetailFields, FbiDerogationRow, FbiScheduleRow } from "./types.js";
import { logInfo } from "../../logger.js";

/**
 * BrowserFbiClient — automatisation Playwright de FBI, utilisée UNIQUEMENT
 * par les routes `/internal/*` (jamais par une route `/v1/*` servant une
 * requête utilisateur, voir docs/FBI.md). C'est la stratégie DE SECOURS
 * pour tout ce que `HttpFbiClient` (./http-client.ts) ne peut pas faire en
 * HTTP direct — aujourd'hui : la découverte et le téléchargement des
 * documents e-Marque, dont l'endpoint HTTP n'a jamais pu être confirmé
 * (§58 du brief FBI original : ne jamais inventer une route, utiliser le
 * navigateur comme chemin fonctionnel à la place).
 *
 * Adaptation Vercel (voir docs/FBI.md pour l'analyse complète) : le
 * `Browser` est fourni par l'appelant — voir
 * `browser-launcher.ts#launchServerlessBrowser` (playwright-core +
 * @sparticuz/chromium, gardé derrière `BROWSER_FBI_ENABLED`), lancé et
 * fermé PAR INVOCATION de Vercel Function (pas de processus long-running
 * comme l'ancien worker Railway — cette classe elle-même est inchangée,
 * seul le lanceur de Browser change).
 *
 * §13 du brief FBI original : CHAQUE session appartient à un seul club_id.
 * Ce client crée un nouveau `BrowserContext` isolé (équivalent d'une
 * fenêtre de navigation privée) à CHAQUE `login()`, jamais partagé entre
 * deux clubs même s'ils utilisaient le même Browser sous-jacent — cookies,
 * storage et cache ne traversent jamais un `BrowserContext`.
 *
 * Statut : le login (détection dynamique du formulaire, mêmes heuristiques
 * que HttpFbiClient) est PREPARED — jamais exécuté contre le vrai FBI
 * depuis cet environnement (réseau *.ffbb.com bloqué). Les tests
 * (browser-client.test.ts) valident ce client contre des pages HTML
 * locales synthétiques (Chromium réel), pas contre le vrai FBI. La
 * navigation post-login (recherche de rencontre, découverte de documents)
 * est conçue de façon générique/défensive (voir selectors.ts) faute
 * d'avoir pu observer le markup réel.
 */

export interface BrowserFbiSession {
  context: BrowserContext;
  page: Page;
}

/**
 * Passes de recherche de dérogations — "ya le statut en cours qui est pas
 * pris en compte" (retour du club, 2026-09-26, avec le HTML source réel de
 * `rechercherDerogation.fbi` ET de `afficherDerogation.fbi` pour la
 * rencontre n°9820, dont la dérogation ACTUELLE a pour acceptation "NC"
 * (non communiqué, aucune `reponseAdversaireDate`) — un dossier RÉELLEMENT
 * "En Cours" à cette date). "Tous les états (sauf à créer)" (`TT`) a
 * toujours été supposé couvrir tout sauf "A Créer" — un lot connu de ~20
 * dérogations (Acceptée/Refusée) confirme que `TT` couvre bien CES
 * états-là — mais le club constate en conditions réelles qu'un dossier
 * "En Cours" (`EC`) n'apparaît PAS dans les résultats sous `TT`, que ce
 * soit un comportement voulu ou un bug du VRAI FBI (jamais vérifiable
 * depuis cet environnement, réseau `*.ffbb.com` bloqué). Plutôt que de
 * deviner lequel des deux, une DEUXIÈME passe explicite sur `EC` — même
 * principe que `fetchScheduleRows` (déjà deux passes sur la case "non
 * joué" pour la même raison : un seul filtre à la fois ne couvre jamais
 * les deux sous-ensembles) — garantit que les dossiers "En Cours" sont
 * ramenés, que `TT` les couvre réellement ou non (dédoublonnée par numéro
 * dans `fetchAllDerogations`, donc jamais de doublon si `TT` les couvrait
 * déjà). Partagée par `fetchDerogationForMatch` (une seule rencontre) et
 * `fetchAllDerogations` (tout le club).
 */
const DEROGATION_ETAT_PASSES = ["tousLesEtats", "enCours"] as const;
type DerogationEtatPass = (typeof DEROGATION_ETAT_PASSES)[number];

export interface BrowserFbiClientOptions {
  baseUrl: string;
  browser: Browser;
  /** Délai après une action de navigation, avant de considérer la page stabilisée (ms). Les apps Java legacy type FBI n'utilisent pas toujours des transitions détectables par networkidle. */
  navigationSettleMs?: number;
}

export class BrowserFbiClient {
  private readonly baseUrl: string;
  private readonly browser: Browser;
  private readonly navigationSettleMs: number;

  constructor(options: BrowserFbiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.browser = options.browser;
    this.navigationSettleMs = options.navigationSettleMs ?? 500;
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForTimeout(this.navigationSettleMs);
  }

  async login(credentials: { username: string; password: string }): Promise<BrowserFbiSession> {
    // Contexte isolé PAR APPEL : jamais de cookie/session partagée entre deux
    // clubs, même s'ils réutilisent ce même Browser.
    const context = await this.browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`${this.baseUrl}/connexion.fbi`, { waitUntil: "domcontentloaded" });
    } catch (error) {
      await context.close();
      throw new FbiError("Page de connexion FBI injoignable", "LOGIN_PAGE_UNREACHABLE", error);
    }

    if (!(await selectors.looksLikeLoginPage(page))) {
      await context.close();
      throw new FbiError("Formulaire de connexion FBI non reconnu (aucun champ mot de passe trouvé)", "LOGIN_FORM_NOT_RECOGNIZED");
    }

    try {
      await selectors.usernameInput(page).fill(credentials.username);
      await selectors.passwordInput(page).fill(credentials.password);

      const submit = selectors.submitControl(page);
      if ((await submit.count()) > 0) {
        await submit.first().click();
      } else {
        await selectors.submitButtonByText(page).click();
      }

      await this.settle(page);
    } catch (error) {
      await context.close();
      throw new FbiError("Échec de la soumission du formulaire de connexion FBI", "NAVIGATION_FAILED", error);
    }

    if (await selectors.looksLikeLoginPage(page)) {
      await context.close();
      throw new FbiError("Connexion FBI refusée (identifiants incorrects, ou formulaire modifié)", "LOGIN_FAILED");
    }

    return { context, page };
  }

  async isSessionValid(session: BrowserFbiSession): Promise<boolean> {
    try {
      await session.page.goto(`${this.baseUrl}/accueil.fbi`, { waitUntil: "domcontentloaded" });
    } catch {
      return false;
    }
    return !(await selectors.looksLikeLoginPage(session.page));
  }

  /**
   * Recherche générique et défensive (voir la note de statut en tête de
   * fichier) : tente de rejoindre un écran de recherche de rencontre, y
   * saisit le numéro, puis scanne la page de résultat pour des liens de
   * documents connus. Chaque étape échoue silencieusement (best effort)
   * plutôt que de planter — `documents: []` déclenche un retry planifié
   * ("document pas encore trouvé" n'est pas une erreur).
   *
   * `season` (format "2025-2026", voir `resolveSeasonLabel` côté appelant)
   * est OPTIONNEL mais fortement recommandé : voir `tryPrepareSearchFilters`.
   *
   * `diagnostic` (§ "Vingt-septième déclenchement", docs/FBI.md) : rempli
   * UNIQUEMENT quand `documents` est vide, avec la même trace/dump riche
   * qu'un échec dur — l'appelant (`process-discover-emarque.ts`) le
   * persiste dans `fbi_jobs.last_error` (même colonne que pour un VRAI
   * échec) pour qu'il soit consultable directement en base sans dépendre
   * des logs Vercel (que seul un humain avec accès au dashboard peut lire
   * et coller manuellement — un aller-retour coûteux répété à chaque
   * itération de correctif).
   */
  async findEmarqueDocuments(session: BrowserFbiSession, matchNumber: string, season: string | null = null): Promise<{ documents: { url: string; fileName: string }[]; diagnostic: string | null }> {
    const { page } = session;

    const trace: string[] = [];
    trace.push(await this.tryNavigateToSearchScreen(page));
    trace.push(await this.tryPrepareSearchFilters(page, season));
    trace.push(await this.trySearchByMatchNumber(page, matchNumber));
    const openResult = await this.tryOpenMatchResult(page, matchNumber);
    trace.push(openResult.trace);

    /**
     * Constaté en production le 2026-09-24 : les trois étapes ci-dessus
     * sont volontairement "best effort" (elles avalent leurs erreurs) —
     * si AUCUNE n'aboutit, `findDocumentLinks` scannait silencieusement la
     * page où on était déjà (souvent la page d'accueil post-login), dont
     * les liens permanents de téléchargement du LOGICIEL e-Marque
     * matchent `DOCUMENT_EXTENSION_PATTERN` (n'importe quel .pdf/.zip) —
     * remontés à tort comme documents DE CE MATCH, pour chaque match,
     * identiques à chaque fois. Ne JAMAIS faire confiance à
     * `findDocumentLinks` sans avoir d'abord vérifié qu'on est bien sur
     * une page qui mentionne CE numéro de rencontre.
     */
    /**
     * Préférer une correspondance EXACTE de cellule "N°" (si un tableau de
     * résultats est présent sur la page courante) à la recherche floue de
     * `pageMentionsMatchNumber` — régression production 2026-09-24 pour la
     * rencontre n°1 : l'en-tête de colonne "Score 1" contient un "1" isolé
     * qui déclenchait un faux positif sur `pageMentionsMatchNumber` alors
     * qu'aucune ligne "1" n'existe dans le tableau (voir
     * `selectors.matchNumberInResultsTable`). Le texte de page libre reste
     * le seul recours sur une page SANS tableau (ex : page de détail après
     * clic sur le lien EM).
     */
    const tableMatch = await selectors.matchNumberInResultsTable(page, matchNumber);
    const pageConfirmsMatch = tableMatch !== null ? tableMatch : await selectors.pageMentionsMatchNumber(page, matchNumber);
    if (!pageConfirmsMatch) {
      const title = await page.title().catch(() => "?");
      /**
       * Diagnostic riche (§ "Seizième déclenchement", docs/FBI.md) : les
       * 25 premiers liens visibles se sont révélés être le menu global du
       * site ffbb.com (Fédération, Compétitions, Boutique...), pas la
       * navigation spécifique FBI — insuffisant pour savoir à QUELLE étape
       * (1/2/3 ci-dessus) la navigation décroche. `trace` répond
       * précisément à ça : ce que chaque étape a trouvé/cliqué, et vers
       * quelle URL, AVANT que la vérification finale échoue.
       */
      const links = await selectors.listVisibleLinks(page, 60);
      const linksSummary = links.length > 0 ? links.map((l) => `"${l.text}" → ${l.href}`).join(" | ") : "(aucun lien trouvé sur la page)";

      /**
       * Diagnostic riche (§ "Dix-neuvième déclenchement", docs/FBI.md) :
       * après correction du faux positif de checkbox, une recherche
       * "réussie" (champ rempli, formulaire soumis) n'a produit AUCUNE
       * ligne de résultat pour un match réellement joué (n°2813, preuve
       * visuelle du code EM). Hypothèse à vérifier sur preuve : un champ
       * de formulaire obligatoire non renseigné (ex : une saison qui
       * défaute sur la saison EN COURS plutôt que celle du match
       * recherché) empêcherait la recherche d'aboutir quel que soit le
       * champ numéro ciblé. Ce dump révèle l'état RÉEL de tous les
       * champs (y compris les `<select>` et leur option sélectionnée) au
       * moment de l'échec.
       */
      const formFields = await selectors.listFormFields(page, 40);
      const formFieldsSummary =
        formFields.length > 0
          ? formFields.map((f) => (f.tag === "select" ? `select[name=${f.name}]="${f.selectedLabel ?? f.value}"` : `${f.tag}[type=${f.type ?? "?"},name=${f.name}]="${f.value}"`)).join(" | ")
          : "(aucun champ de formulaire trouvé sur la page)";

      /**
       * Diagnostic riche (§ "Vingt-quatrième déclenchement", docs/FBI.md) :
       * saison/case correctement ajustées, bon bouton cliqué, mais toujours
       * aucun résultat — le HTML brut du formulaire révélera la structure
       * exacte des widgets JS (`<select>` + `<button>` jumeau observés)
       * nécessaire pour interagir avec eux comme un vrai utilisateur.
       */
      const formHtml = await selectors.formHtmlSnippet(page);

      /**
       * Diagnostic riche (§ "Vingt-sixième déclenchement", docs/FBI.md) :
       * le vrai formulaire fait ~43000 caractères (le sélecteur Division
       * seul liste des centaines d'options) — `formHtml` (plafonné à 4000)
       * se coupe systématiquement avant d'atteindre le bouton "Rechercher"
       * ou le champ numéro, pourtant les éléments les plus pertinents ici.
       */
      const searchControlsHtml = await selectors.searchControlsHtmlSnippet(page);

      throw new FbiError(
        `Page de résultat introuvable pour la rencontre ${matchNumber} : ni la recherche ni l'ouverture du résultat n'ont abouti (page actuelle : "${title}", ${page.url()}). ` +
          `Trace de navigation : [1] ${trace[0]} — [2] ${trace[1]} — [3] ${trace[2]} — [4] ${trace[3]}. ` +
          `Champs de formulaire sur cette page : ${formFieldsSummary}. ` +
          `Liens visibles sur cette page : ${linksSummary}. ` +
          `HTML autour du bouton de recherche : ${searchControlsHtml}. ` +
          `HTML du formulaire : ${formHtml}`,
        "EMARQUE_MATCH_PAGE_NOT_REACHED",
      );
    }

    const links = await selectors.findDocumentLinks(page);

    /**
     * Constaté en production le 2026-09-24 (rencontre n°1481, § "Vingt-
     * neuvième déclenchement", docs/FBI.md) : le lien de la colonne EM
     * déclenche un téléchargement natif du navigateur (voir
     * `tryOpenMatchResult`) plutôt qu'un `<a href>` classique — DONC
     * jamais trouvé par `findDocumentLinks` (qui ne scanne que des
     * `href`). L'URL capturée par l'événement `download` de Playwright
     * EST une vraie URL FBI réutilisable (ex :
     * `.../telechargerFeuilleMatchEmarque.fbi?action=emV2&plugin=true&idRenc=<token>`),
     * jamais un `blob:` temporaire — elle est ajoutée ici aux documents
     * "trouvés par lien" exactement comme n'importe quel autre document,
     * pour repasser par le même pipeline `downloadDocument()`/Storage
     * (`process-discover-emarque.ts`) sans traitement spécial. Dédupliquée
     * par URL au cas où le même document apparaîtrait aussi comme lien
     * classique.
     */
    const documents = links.map((link) => ({
      url: new URL(link.href, page.url()).toString(),
      fileName: this.fileNameFromLabelOrUrl(link),
    }));
    if (openResult.discoveredDocument && !documents.some((d) => d.url === openResult.discoveredDocument!.url)) {
      documents.push(openResult.discoveredDocument);
    }

    /**
     * Constaté en production le 2026-09-24 (rencontre n°2813, § "Vingt-
     * troisième déclenchement", docs/FBI.md) : `documents.length === 0`
     * (page confirmée pour CE match, mais aucun lien de document retenu
     * après filtrage) déclenche un simple retry planifié côté appelant
     * (`process-discover-emarque.ts`), SANS AUCUN diagnostic — contrairement
     * au chemin d'échec dur (`EMARQUE_MATCH_PAGE_NOT_REACHED`) qui embarque
     * trace/champs/liens dans son message. Un match confirmé via capture
     * d'écran comme ayant un vrai document (2813, code EM "DCBLRCA7") qui
     * ressort à zéro mérite la même preuve — sinon c'est encore un cycle de
     * correctif à l'aveugle sur le prochain échec identique.
     */
    let diagnostic: string | null = null;
    if (documents.length === 0) {
      const title = await page.title().catch(() => "?");
      const visibleLinks = await selectors.listVisibleLinks(page, 60);
      const linksSummary = visibleLinks.length > 0 ? visibleLinks.map((l) => `"${l.text}" → ${l.href}`).join(" | ") : "(aucun lien trouvé sur la page)";
      const formFields = await selectors.listFormFields(page, 40);
      const formFieldsSummary =
        formFields.length > 0
          ? formFields.map((f) => (f.tag === "select" ? `select[name=${f.name}]="${f.selectedLabel ?? f.value}"` : `${f.tag}[type=${f.type ?? "?"},name=${f.name}]="${f.value}"`)).join(" | ")
          : "(aucun champ de formulaire trouvé sur la page)";
      const formHtml = await selectors.formHtmlSnippet(page);
      const searchControlsHtml = await selectors.searchControlsHtmlSnippet(page);

      diagnostic =
        `[info, pas une erreur] Page confirmée pour la rencontre ${matchNumber} (page actuelle : "${title}", ${page.url()}) mais aucun document retenu après filtrage. ` +
        `Trace de navigation : [1] ${trace[0]} — [2] ${trace[1]} — [3] ${trace[2]} — [4] ${trace[3]}. ` +
        `Champs de formulaire sur cette page : ${formFieldsSummary}. ` +
        `Liens visibles sur cette page : ${linksSummary}. ` +
        `HTML autour du bouton de recherche : ${searchControlsHtml}. ` +
        `HTML du formulaire : ${formHtml}`;

      logInfo(`Job discover_emarque : page confirmée pour la rencontre ${matchNumber} mais aucun document retenu après filtrage`, {
        matchNumber,
        title,
        url: page.url(),
        trace,
        visibleLinks: linksSummary,
        formFields: formFieldsSummary,
        searchControlsHtml,
        formHtml,
      });
    }

    return { documents, diagnostic };
  }

  /**
   * Constaté en production le 2026-09-24 (rencontre n°1481, § "Vingt-deuxième
   * déclenchement", docs/FBI.md) : le nom de fichier RÉEL est utilisé quand
   * l'URL se termine par une extension connue, sinon un nom dérivé du
   * libellé visible du lien (repli générique). Deux liens DIFFÉRENTS avec le
   * même libellé visible (ex : "e-Marque") produisaient alors le MÊME nom de
   * fichier — donc le MÊME `storagePath` (dérivé du nom de fichier, voir
   * `emarqueStoragePath`), et s'écrasaient silencieusement l'un l'autre dans
   * Storage tout en laissant plusieurs lignes `match_documents` DISTINCTES
   * pointant vers ce chemin unique désormais incohérent avec leur `sha256`
   * d'origine. Un court hash de l'URL (jamais visible à l'utilisateur, juste
   * de quoi distinguer deux documents homonymes) élimine cette collision.
   */
  private fileNameFromLabelOrUrl(link: { href: string; label: string }): string {
    const fromUrl = link.href.split("/").pop();
    if (fromUrl && /\.(zip|pdf)$/i.test(fromUrl)) return fromUrl;

    const slug = link.label.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60) || "document";
    const shortHash = createHash("sha1").update(link.href).digest("hex").slice(0, 8);
    return `${slug}_${shortHash}.pdf`;
  }

  /** Chaque étape "best effort" renvoie une trace lisible (jamais d'exception) — voir le diagnostic de `findEmarqueDocuments`. */
  private async tryNavigateToSearchScreen(page: Page): Promise<string> {
    /**
     * Constaté en production le 2026-09-24 (capture d'écran du VRAI FBI
     * fournie par le club, § "Dix-huitième déclenchement", docs/FBI.md) :
     * l'écran de recherche de rencontre est
     * `{baseUrl}/rechercherRencontreSaisieResultat.fbi` — une URL CONFIRMÉE,
     * jamais devinée. Navigation directe plutôt que de deviner un lien à
     * cliquer sur l'accueil (l'ancienne approche cliquait à tort le menu
     * global ffbb.com, voir plus haut). Repli sur l'ancien clic de lien
     * (même origine uniquement) si la navigation directe échoue — au cas
     * où cette URL ne serait pas valide pour tous les contextes/rôles FBI.
     */
    const targetUrl = `${this.baseUrl}/rechercherRencontreSaisieResultat.fbi`;
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await this.settle(page);
      return `navigation directe vers ${targetUrl} réussie, url → ${page.url()}`;
    } catch (error) {
      const gotoError = error instanceof Error ? error.message : String(error);

      const candidates = await page.getByRole("link", { name: /rencontre|compétition|calendrier/i }).all();
      const pageOrigin = new URL(page.url()).origin;

      for (const candidate of candidates) {
        const href = await candidate.getAttribute("href").catch(() => null);
        if (!href) continue;

        let isSameOrigin: boolean;
        try {
          isSameOrigin = new URL(href, page.url()).origin === pageOrigin;
        } catch {
          continue;
        }
        if (!isSameOrigin) continue;

        const text = (await candidate.textContent().catch(() => null))?.trim() ?? "?";
        try {
          await candidate.click();
          await this.settle(page);
          return `navigation directe échouée (${gotoError}), repli sur le lien "${text}" (même origine) cliqué, url → ${page.url()}`;
        } catch (clickError) {
          return `navigation directe échouée (${gotoError}), repli sur le lien "${text}" trouvé mais le clic a échoué : ${clickError instanceof Error ? clickError.message : String(clickError)}`;
        }
      }

      return `navigation directe vers ${targetUrl} échouée (${gotoError}), et aucun lien de repli (même origine) trouvé`;
    }
  }

  /**
   * Ajuste les filtres du formulaire de recherche AVANT de chercher le
   * numéro de rencontre — confirmé en production le 2026-09-24 (§
   * "Dix-neuvième déclenchement", docs/FBI.md, dump complet des champs de
   * formulaire) : une recherche par numéro seul, sur un match réellement
   * joué (n°2813/1481/4516, preuve visuelle du code EM pour 2813), n'a
   * renvoyé AUCUNE ligne de résultat — parce que DEUX filtres par défaut
   * de la page l'en empêchaient :
   *
   * 1. La checkbox "non joué" (résultat pas encore saisi) est COCHÉE par
   *    défaut — cette page sert à SAISIR des résultats, donc elle filtre
   *    naturellement aux matchs dont le résultat n'est pas encore
   *    homologué, jamais ceux déjà joués (précisément ceux qui ont un
   *    document e-Marque). Toujours décochée : on ne cherche jamais un
   *    match "non joué" ici.
   * 2. Le sélecteur de saison défaute sur la saison EN COURS. Un match
   *    d'une saison passée n'apparaît jamais tant que ce sélecteur n'est
   *    pas ajusté — `season` (calculé par l'appelant depuis
   *    `match.match_datetime` via `resolveSeasonLabel`) est utilisé pour
   *    choisir l'option dont le LIBELLÉ contient cette saison (jamais une
   *    valeur de `<option>` devinée).
   */
  private async tryPrepareSearchFilters(page: Page, season: string | null): Promise<string> {
    const notes: string[] = [];

    try {
      const nonJoue = selectors.nonJoueCheckbox(page);
      if ((await nonJoue.count().catch(() => 0)) > 0 && (await nonJoue.isChecked().catch(() => false))) {
        await nonJoue.uncheck();
        notes.push('case "non joué" décochée');
      }
    } catch (error) {
      notes.push(`case "non joué" trouvée mais impossible à décocher : ${error instanceof Error ? error.message : String(error)}`);
    }

    if (season) {
      try {
        const select = selectors.seasonSelect(page);
        const selectCount = await select.count().catch(() => 0);
        if (selectCount === 0) {
          notes.push("aucun sélecteur de saison trouvé");
        } else {
          const options = select.locator("option");
          const optionCount = await options.count().catch(() => 0);
          let matchedLabel: string | null = null;

          for (let i = 0; i < optionCount; i += 1) {
            const label = (await options.nth(i).textContent().catch(() => null))?.trim() ?? "";
            if (!label.includes(season)) continue;

            const value = await options.nth(i).getAttribute("value").catch(() => null);
            await select.selectOption(value !== null ? { value } : { label });
            matchedLabel = label;
            break;
          }

          notes.push(matchedLabel ? `saison "${matchedLabel}" sélectionnée` : `aucune option de saison ne contient "${season}"`);
        }
      } catch (error) {
        notes.push(`sélecteur de saison trouvé mais la sélection a échoué : ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.settle(page);
    return notes.length > 0 ? notes.join(" ; ") : "aucun filtre à ajuster (case non joué déjà décochée, pas de saison fournie)";
  }

  private async trySearchByMatchNumber(page: Page, matchNumber: string): Promise<string> {
    const input = await selectors.matchNumberSearchInput(page);
    if (!input) return "aucun champ de recherche par numéro trouvé (name/placeholder évocateur)";

    /**
     * Diagnostic (§ "Dix-neuvième déclenchement", docs/FBI.md) : le nom
     * réel du champ ciblé, pour confirmer sur le prochain succès/échec
     * que c'est bien le bon champ (jamais une checkbox ou un autre champ
     * homonyme) — plutôt que de le supposer.
     */
    const inputName = (await input.getAttribute("name").catch(() => null)) ?? "?";

    const urlBefore = page.url();

    /**
     * Capture réseau (§ "Vingt-septième déclenchement", docs/FBI.md) :
     * après plusieurs cycles à deviner depuis le DOM (saison/case/bouton
     * tous confirmés corrects, toujours aucun résultat), la seule preuve
     * définitive de ce que fait RÉELLEMENT le clic sur "Rechercher" est la
     * requête HTTP elle-même — jamais une hypothèse sur le DOM. Capture
     * toute requête XHR/fetch/POST survenant après le clic : son URL, le
     * corps envoyé (révèle si saison/numéro sont bien transmis au serveur),
     * et un extrait de la réponse (révèle si le serveur renvoie déjà les
     * bonnes lignes — auquel cas le problème serait côté rendu client,
     * jamais côté recherche — ou rien du tout).
     */
    const capturedRequests: string[] = [];
    const onResponse = async (response: import("playwright-core").Response): Promise<void> => {
      try {
        const req = response.request();
        if (req.resourceType() !== "xhr" && req.resourceType() !== "fetch" && req.method() !== "POST") return;
        const postData = req.postData();
        const bodySnippet = await response.text().catch(() => null);
        capturedRequests.push(
          `${req.method()} ${response.url()} → HTTP ${response.status()}` +
            (postData ? ` | corps envoyé (${postData.length} car.) : ${postData.slice(0, 800)}` : " | aucun corps envoyé") +
            (bodySnippet ? ` | réponse (${bodySnippet.length} car.) : ${bodySnippet.slice(0, 2000)}` : " | réponse illisible"),
        );
      } catch {
        // Best effort — jamais interrompre le flux principal pour un souci de capture diagnostique.
      }
    };
    page.on("response", onResponse);

    try {
      await input.fill(matchNumber);

      /**
       * Constaté en production le 2026-09-24 (capture d'écran du VRAI FBI) :
       * un bouton "RECHERCHER" explicite valide le formulaire — `press
       * ("Enter")` seul ne suffit pas toujours à soumettre un formulaire
       * non natif (JS intercepté). Bouton en priorité, Entrée en repli.
       * Le texte du bouton réellement cliqué est ajouté à la trace (§
       * "Vingtième déclenchement", docs/FBI.md) : le dump des champs de
       * formulaire n'incluait pas les boutons, impossible de vérifier que
       * `searchSubmitControl` visait le bon.
       */
      const submit = selectors.searchSubmitControl(page).first();
      const submitCount = await submit.count().catch(() => 0);
      const submitText = submitCount > 0 ? ((await submit.textContent().catch(() => null))?.trim() ?? "?") : null;
      if (submitCount > 0) {
        await submit.click();
      } else {
        await input.press("Enter");
      }

      /**
       * Attente réseau EN PLUS du délai fixe (§ "Vingtième déclenchement",
       * docs/FBI.md) : les noms de champs réels
       * (`identificationForm.identificationBean...`,
       * `rechercheRencontreSaisieResultatForm...`) évoquent une appli Java
       * legacy (JSF), où un bouton peut soumettre en AJAX (XHR patchant le
       * DOM en place, sans navigation ni changement d'URL) plutôt qu'en
       * rechargement de page classique — un délai fixe de 500ms pourrait
       * ne pas suffire à un aller-retour serveur réel en production.
       * Best-effort : `networkidle` peut ne jamais être atteint sur une
       * page avec du polling, d'où le timeout court et le `catch`.
       */
      await this.settle(page);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

      const urlAfter = page.url();
      const submitNote = submitText ? ` (bouton "${submitText}" cliqué)` : " (aucun bouton trouvé, Entrée pressée)";
      const networkNote =
        capturedRequests.length > 0
          ? ` — requêtes réseau capturées : ${capturedRequests.join(" || ")}`
          : " — aucune requête XHR/fetch/POST capturée après le clic (soumission peut-être purement côté client, ou non déclenchée)";
      return (
        (urlAfter === urlBefore
          ? `champ "${inputName}" rempli ("${matchNumber}") et recherche soumise${submitNote}, mais l'URL n'a pas changé (${urlAfter})`
          : `champ "${inputName}" rempli et recherche soumise${submitNote}, url → ${urlAfter}`) + networkNote
      );
    } catch (error) {
      return `champ de recherche "${inputName}" trouvé mais le remplissage/la soumission a échoué : ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      page.off("response", onResponse);
    }
  }

  private async tryOpenMatchResult(page: Page, matchNumber: string): Promise<{ trace: string; discoveredDocument: { url: string; fileName: string } | null }> {
    /**
     * Constaté en production le 2026-09-24 (capture d'écran du VRAI FBI
     * fournie par le club) : le tableau de résultats a une colonne "EM"
     * dédiée — un code cliquable ("DCBLRCA7"...) ou une icône "FDM" pour
     * une rencontre déjà jouée avec un e-Marque disponible, VIDE sinon.
     * `selectors.emarqueColumnLinkForMatch` localise CE lien précisément
     * (par libellé de colonne, jamais une position devinée) plutôt que le
     * générique "premier élément contenant ce numéro" d'avant (qui pouvait
     * cliquer n'importe quoi sur la ligne, jamais spécifiquement la
     * colonne e-Marque).
     */
    const emLink = await selectors.emarqueColumnLinkForMatch(page, matchNumber).catch(() => null);
    if (!emLink) {
      return {
        trace: `pas de lien e-Marque trouvé pour la rencontre "${matchNumber}" (colonne EM absente, ligne introuvable, ou colonne EM vide — match pas encore joué)`,
        discoveredDocument: null,
      };
    }

    const text = (await emLink.textContent().catch(() => null))?.trim() ?? "?";
    const urlBefore = page.url();

    /**
     * Constaté en production le 2026-09-24 (rencontre n°1481, § "Vingt-
     * huitième déclenchement", docs/FBI.md) : la capture réseau du clic sur
     * "Rechercher" (déclenchement précédent) a révélé que FBI utilise
     * DataTables (appel AJAX `action=executeRecherche`, réponse JSON
     * `aaData`) — et que le lien de la colonne EM n'est PAS un `<a href>`
     * classique mais `<a onclick="telechargerMatch('<token>','<idMatch>')">`
     * (aucun `href`). Le clic a bien lieu (trace confirmée), mais sans
     * changement d'URL ni lien de document détectable sur la page —
     * `telechargerMatch()` déclenche probablement un téléchargement natif
     * du navigateur (nom de fonction explicite), une popup, ou un appel
     * réseau qu'on ne capturait pas encore À CETTE étape précise (seule
     * `trySearchByMatchNumber` capturait le réseau jusqu'ici). Capture
     * maintenant aussi les événements `download`/`popup`, en plus du
     * réseau, autour de CE clic précis.
     */
    const capturedRequests: string[] = [];
    const onResponse = async (response: import("playwright-core").Response): Promise<void> => {
      try {
        const req = response.request();
        if (req.resourceType() !== "xhr" && req.resourceType() !== "fetch" && req.method() !== "POST") return;
        const postData = req.postData();
        const bodySnippet = await response.text().catch(() => null);
        capturedRequests.push(
          `${req.method()} ${response.url()} → HTTP ${response.status()}` +
            (postData ? ` | corps envoyé (${postData.length} car.) : ${postData.slice(0, 500)}` : " | aucun corps envoyé") +
            (bodySnippet ? ` | réponse (${bodySnippet.length} car.) : ${bodySnippet.slice(0, 1000)}` : " | réponse illisible"),
        );
      } catch {
        // Best effort.
      }
    };
    page.on("response", onResponse);

    /**
     * 3s (pas 8+) : un téléchargement natif ou une popup surviennent
     * quasi immédiatement après le clic qui les déclenche — un délai plus
     * long ne fait qu'allonger inutilement CHAQUE job réel (et le temps
     * des tests) sans jamais rien détecter de plus.
     */
    const downloadPromise = page.waitForEvent("download", { timeout: 3000 }).catch(() => null);
    const popupPromise = page.waitForEvent("popup", { timeout: 3000 }).catch(() => null);

    try {
      /**
       * Timeout explicite et court (jamais les 30s par défaut de
       * Playwright) : constaté en écrivant les tests de ce correctif — un
       * élément sans dimensions visibles réelles (icône dépendant d'un CSS
       * absent) fait attendre `.click()` l'intégralité de son délai
       * d'actionabilité par défaut avant d'échouer, consommant un tiers du
       * budget d'un job entier pour un clic qui n'aboutira jamais.
       */
      await emLink.click({ timeout: 10000 });
      await this.settle(page);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

      const [download, popup] = await Promise.all([downloadPromise, popupPromise]);

      /**
       * Constaté en production le 2026-09-24 (rencontre n°1481, § "Vingt-
       * neuvième déclenchement", docs/FBI.md) : `download.url()` est une
       * VRAIE URL FBI ré-appelable via `context.request.get()` (mêmes
       * cookies de session, voir `downloadDocument()`), jamais un `blob:`
       * temporaire — le fichier réellement téléchargé par Playwright
       * lui-même (dans `/tmp` de @sparticuz/chromium) ne sert à rien ici
       * et est supprimé (best effort) pour ne pas polluer ce répertoire
       * éphémère entre deux clics EM d'une même invocation.
       */
      const discoveredDocument = download ? { url: download.url(), fileName: download.suggestedFilename() } : null;
      if (download) await download.delete().catch(() => {});

      const downloadNote = download ? ` — téléchargement natif déclenché : url=${download.url()}, nom suggéré="${download.suggestedFilename()}"` : "";
      const popupNote = popup ? ` — popup/nouvel onglet ouvert : url=${popup.url()}` : "";
      const networkNote =
        capturedRequests.length > 0
          ? ` — requêtes réseau capturées après le clic EM : ${capturedRequests.join(" || ")}`
          : " — aucune requête XHR/fetch/POST capturée après le clic EM";

      const urlAfter = page.url();
      return {
        trace:
          (urlAfter === urlBefore ? `lien EM "${text}" cliqué, mais l'URL n'a pas changé (${urlAfter})` : `lien EM "${text}" cliqué, url → ${urlAfter}`) +
          downloadNote +
          popupNote +
          networkNote,
        discoveredDocument,
      };
    } catch (error) {
      return {
        trace: `lien EM "${text}" trouvé mais le clic a échoué : ${error instanceof Error ? error.message : String(error)}`,
        discoveredDocument: null,
      };
    } finally {
      page.off("response", onResponse);
    }
  }

  /**
   * Récupère TOUTES les rencontres du club listées par FBI (rapprochement
   * calendrier FFBB/FBI, voir docs/FBI.md) — pas une rencontre ciblée comme
   * `findEmarqueDocuments`. DEUX passes obligatoires : la case "non joué"
   * (cochée par défaut, voir `selectors.nonJoueCheckbox`) filtre à un SEUL
   * des deux états à la fois — cochée pour les rencontres à venir/résultat
   * pas encore saisi (confirmé le 2026-09-25 : le club a montré un listing
   * de rencontres FUTURES, scores tous vides, case cochée par défaut),
   * décochée pour les rencontres déjà jouées. Sans les deux passes, la
   * moitié du calendrier du club serait invisible au rapprochement.
   *
   * Recherche à NUMÉRO VIDE (jamais rempli, contrairement à
   * `trySearchByMatchNumber`) : renvoie alors TOUTES les rencontres du club
   * connecté, toutes divisions confondues — confirmé par la capture d'écran
   * fournie par le club (colonnes Division/N°/Equipe 1/Equipe 2/Date de
   * rencontre/Heure/Salle/EM/Score 1/Forfait 1, pagination "Précédent 1 2 3
   * 4 5 6 Suivant").
   */
  async fetchScheduleRows(session: BrowserFbiSession): Promise<FbiScheduleRow[]> {
    const { page } = session;
    const rawRows: Record<string, string>[] = [];

    for (const nonJoueChecked of [true, false]) {
      await this.trySetNonJoueAndSearch(page, nonJoueChecked);
      rawRows.push(...(await this.collectAllResultPages(page)));
    }

    return rawRows.map(normalizeScheduleRow);
  }

  /**
   * Rejoint l'écran de recherche (état frais, sans filtre numéro ni
   * pagination résiduelle d'une passe précédente), règle la case "non
   * joué" sur l'état demandé, puis soumet une recherche à numéro vide.
   */
  private async trySetNonJoueAndSearch(page: Page, nonJoueChecked: boolean): Promise<void> {
    await this.tryNavigateToSearchScreen(page);

    try {
      const nonJoue = selectors.nonJoueCheckbox(page);
      if ((await nonJoue.count().catch(() => 0)) > 0) {
        const isChecked = await nonJoue.isChecked().catch(() => nonJoueChecked);
        if (isChecked !== nonJoueChecked) {
          if (nonJoueChecked) await nonJoue.check();
          else await nonJoue.uncheck();
        }
      }
    } catch {
      // Best effort — une case introuvable/impossible à régler ne doit
      // jamais empêcher la tentative de recherche (elle renverra alors la
      // page par défaut, mieux que rien).
    }

    try {
      const submit = selectors.searchSubmitControl(page).first();
      if ((await submit.count().catch(() => 0)) > 0) {
        await submit.click();
      }
      await this.settle(page);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    } catch {
      // Best effort — voir collectAllResultPages, qui renvoie []  si la
      // page courante n'a pas la forme d'un tableau de résultats.
    }
  }

  /**
   * Parcourt toutes les pages du tableau de résultats courant ("Suivant",
   * voir `selectors.nextPageControl`), en s'arrêtant dès qu'un clic ne
   * change plus le contenu de la page (dernière page, contrôle inerte) —
   * jamais un nombre de pages supposé à l'avance, et jamais de boucle
   * infinie (`MAX_PAGES` en filet de sécurité).
   */
  private async collectAllResultPages(page: Page): Promise<Record<string, string>[]> {
    const MAX_PAGES = 50;
    const collected: Record<string, string>[] = [];
    let previousSignature: string | null = null;

    for (let i = 0; i < MAX_PAGES; i += 1) {
      const rows = await selectors.resultsTableGenericRows(page).catch(() => null);
      const signature = JSON.stringify(rows);
      if (signature === previousSignature) break;
      previousSignature = signature;
      if (rows) collected.push(...rows);

      const next = selectors.nextPageControl(page);
      if ((await next.count().catch(() => 0)) === 0) break;
      if (!(await next.first().isEnabled().catch(() => false))) break;

      try {
        await next.first().click();
        await this.settle(page);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      } catch {
        break;
      }
    }

    return collected;
  }

  /**
   * Consulte l'état de la dérogation d'UN match, par numéro de rencontre —
   * URL confirmée par capture d'écran du VRAI FBI le 2026-09-25 (le club a
   * copié l'URL depuis sa barre d'adresse) : `rechercherDerogation.fbi`
   * pour la recherche, `afficherDerogation.fbi?idDerogation=0&idRencontre=<jeton>`
   * pour le détail d'une dérogation précise (jeton opaque, RENVOYÉ par la
   * page de résultats — jamais construit ici, voir §Ce qui n'est pas fait).
   *
   * "faudra utiliser la recherche par numéro de rencontre, car on l'a déjà
   * et c'est bcp + simple" (demande du club) — recherche donc DIRECTEMENT
   * par numéro, jamais par division/date. LECTURE SEULE : cette méthode ne
   * fait QUE consulter (jamais soumettre/modifier une dérogation) — mais
   * clique désormais dans le détail de la ligne trouvée pour en ramener le
   * motif, la date/heure demandées et la réponse de l'adversaire (demande
   * du club, 2026-09-25 : "il me faut du détail sur le motif... les dates
   * initiales et demandées... comme sur fbi", voir `fetchDerogationDetailForRow`).
   *
   * Boucle sur `DEROGATION_ETAT_PASSES` (`TT` puis `EC`, voir sa doc) :
   * s'arrête à la première passe qui trouve CE numéro — "TT" seul aurait pu
   * manquer une dérogation actuellement "En Cours" pour ce match, exactement
   * comme constaté pour la rencontre n°9820 le 2026-09-26.
   */
  async fetchDerogationForMatch(session: BrowserFbiSession, matchNumber: string): Promise<FbiDerogationRow | null> {
    const { page } = session;

    for (const pass of DEROGATION_ETAT_PASSES) {
      await this.navigateToDerogationSearchScreen(page, pass);

      const numeroInput = await selectors.matchNumberSearchInput(page);
      if (!numeroInput) {
        throw new FbiError(
          `Champ "Numéro de rencontre" introuvable sur l'écran de recherche des dérogations (${this.baseUrl}/rechercherDerogation.fbi).`,
          "NAVIGATION_FAILED",
        );
      }

      try {
        await numeroInput.fill(matchNumber);
        const submit = selectors.searchSubmitControl(page).first();
        if ((await submit.count().catch(() => 0)) > 0) await submit.click();
        else await numeroInput.press("Enter");
        await this.settle(page);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      } catch (error) {
        throw new FbiError(
          `Recherche de dérogation échouée pour la rencontre ${matchNumber} (état ${pass}) : ${error instanceof Error ? error.message : String(error)}`,
          "NAVIGATION_FAILED",
          error,
        );
      }

      const rows = await selectors.resultsTableGenericRows(page);
      if (!rows || rows.length === 0) continue;

      const normalized = rows.map(normalizeDerogationRow);
      // Comparaison EXACTE du numéro — jamais la première ligne supposée
      // correcte (même prudence que `matchNumberInResultsTable` côté
      // découverte e-Marque : une recherche mal filtrée pourrait renvoyer
      // d'autres rencontres).
      const matchIndex = normalized.findIndex((row) => row.numero === matchNumber);
      if (matchIndex === -1) continue;

      const detail = await this.fetchDerogationDetailForRow(page, matchIndex);
      return detail ? { ...normalized[matchIndex], ...detail } : normalized[matchIndex];
    }

    return null;
  }

  /**
   * "je veux un bouton global qui check toutes les demandes, pas match par
   * match" (demande du club, 2026-09-25) — recherche à NUMÉRO VIDE (jamais
   * rempli, contrairement à `fetchDerogationForMatch`) : renvoie alors
   * TOUTES les dérogations du club connecté. UNE SEULE connexion FBI pour
   * tout le club, jamais une boucle de connexions par match (déjà à
   * l'origine d'un blocage anti-bot par le passé pour `discover_emarque`,
   * voir ProcessFbiJobsButton.tsx côté SCSB).
   *
   * Ramène aussi le détail (motif/dates demandées/réponse adversaire) de
   * CHAQUE ligne — troisième tentative, cette fois via `outerHTML` RÉEL
   * d'une ligne fourni par le club le 2026-09-25 ("ca marche tjr pas les
   * motifs etc") : voir `collectAllDerogationsWithDetail` pour pourquoi ce
   * mécanisme (extraction de `href`, nouvel onglet) n'a PAS les défauts des
   * deux précédents.
   *
   * Boucle sur `DEROGATION_ETAT_PASSES` (`TT` puis `EC`, voir sa doc) —
   * "ya le statut en cours qui est pas pris en compte" (retour du club,
   * 2026-09-26) : un lot connu de ~20 dérogations est retombé à 3 trouvées
   * juste après le déploiement de l'extraction de détail, et la rencontre
   * n°9820 (HTML source réel fourni) a une dérogation ACTUELLEMENT "En
   * Cours" absente des résultats sous "TT" seul. Dédoublonnée par numéro —
   * la passe "EC" gagne en cas de conflit (un dossier "En Cours" retrouvé
   * est plus à jour qu'un éventuel doublon "TT" pour le même numéro).
   */
  async fetchAllDerogations(session: BrowserFbiSession): Promise<FbiDerogationRow[]> {
    const { page } = session;
    const collected = new Map<string, FbiDerogationRow>();

    for (const pass of DEROGATION_ETAT_PASSES) {
      await this.navigateToDerogationSearchScreen(page, pass);

      try {
        const submit = selectors.searchSubmitControl(page).first();
        if ((await submit.count().catch(() => 0)) > 0) await submit.click();
        await this.settle(page);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      } catch (error) {
        throw new FbiError(
          `Recherche de toutes les dérogations du club échouée (état ${pass}) : ${error instanceof Error ? error.message : String(error)}`,
          "NAVIGATION_FAILED",
          error,
        );
      }

      const rowsForPass = await this.collectAllDerogationsWithDetail(page);
      for (const row of rowsForPass) {
        // Marqueur de diagnostic UNIQUEMENT (jamais persisté — voir
        // process-check-all-derogations.ts, qui ne lit `raw` que pour ça) :
        // permet de confirmer, sans deviner, que la passe "En Cours" a
        // RÉELLEMENT tourné et ce qu'elle a trouvé (voir docs/FBI.md,
        // § "Statut En Cours absent").
        row.raw.__etatPass = pass;
        const key = row.numero ?? JSON.stringify(row.raw);
        collected.set(key, row);
      }
    }

    return Array.from(collected.values());
  }

  /**
   * Parcourt toutes les pages du tableau de résultats de dérogations
   * (même pagination que `collectAllResultPages`), et enrichit CHAQUE ligne
   * avec son détail — troisième tentative après deux échecs (voir
   * docs/FBI.md, "Incident et revert") :
   *
   * 1. Cliquer la ligne + `page.goBack()` : fiable pour UNE ligne
   *    (`fetchDerogationForMatch`), mais `goBack()` ne restaure pas le
   *    tableau injecté en AJAX pour une ligne suivante (page vide).
   * 2. Reconstruire toute la recherche après chaque ligne : a fait tomber un
   *    lot de ~20 dérogations à 3 trouvées en production (perte de données).
   *
   * Le HTML RÉEL d'une ligne de résultat (fourni par le club le 2026-09-25,
   * outerHTML d'un vrai `<tr>`) montre que CHAQUE cellule de donnée
   * enveloppe son texte dans un vrai `<a href="afficherDerogation.fbi?
   * idDerogation=...&idRencontre=0">` — un lien HTML statique, jamais un
   * `onclick`/gestionnaire JS. Lire cet `href` (`derogationRowDetailHref`)
   * ne touche JAMAIS la page principale (pas de clic, pas de navigation,
   * pas d'interception de route) : le détail est ouvert dans un second
   * onglet séparé (`fetchDerogationDetailByHref`), lu, fermé — le tableau
   * de résultats et sa pagination restent intacts pendant tout le
   * parcours, contrairement aux deux tentatives précédentes.
   */
  private async collectAllDerogationsWithDetail(page: Page): Promise<FbiDerogationRow[]> {
    const MAX_PAGES = 50;
    const collected: FbiDerogationRow[] = [];
    let previousSignature: string | null = null;

    for (let i = 0; i < MAX_PAGES; i += 1) {
      const rows = await selectors.resultsTableGenericRows(page).catch(() => null);
      const signature = JSON.stringify(rows);
      if (signature === previousSignature) break;
      previousSignature = signature;

      if (rows) {
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          const normalized = normalizeDerogationRow(rows[rowIndex]);

          /**
           * Constaté en production le 2026-09-26 (§ "Statut En Cours absent",
           * docs/FBI.md) : une ligne fantôme (`numero: null, etat: null`,
           * `raw: {}`) apparaît systématiquement parmi les résultats — la
           * ligne "Aucune donnée disponible dans le tableau" que DataTables
           * insère dans `<tbody>` quand une recherche/page ne renvoie AUCUN
           * résultat (ex : la passe "En Cours" quand aucune dérogation
           * n'est actuellement en cours) a un unique `<td colspan="N">`, que
           * `resultsTableGenericRows` (aligné sur l'INDEX de colonne, jamais
           * son libellé) associe à tort à l'en-tête vide de la 1ère colonne
           * (checkbox) — ignoré (`if (!header) continue`), d'où un `record`
           * entièrement vide. Une VRAIE dérogation a TOUJOURS un numéro de
           * rencontre — jamais `null` — donc jamais confondue avec ce cas.
           * Sans ce filtre, cette ligne fantôme gonflait `derogationsFound`/
           * `unmatched` (voir `fbi_jobs.result`) sans jamais correspondre à
           * une vraie dérogation.
           */
          if (normalized.numero === null) continue;

          const detail = await this.fetchDerogationDetailForRow(page, rowIndex);
          collected.push(detail ? { ...normalized, ...detail } : normalized);
        }
      }

      const next = selectors.nextPageControl(page);
      if ((await next.count().catch(() => 0)) === 0) break;
      if (!(await next.first().isEnabled().catch(() => false))) break;

      try {
        await next.first().click();
        await this.settle(page);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      } catch {
        break;
      }
    }

    return collected;
  }

  /**
   * Détail d'UNE ligne du tableau de résultats, par extraction directe de
   * `href` (voir `collectAllDerogationsWithDetail`) — jamais un clic sur la
   * ligne. Best effort intégral : si la ligne n'a pas de lien, ou que
   * l'onglet ouvert n'a pas la forme attendue, renvoie `null` SANS lever
   * d'erreur — une ligne dont le détail échoue à s'ouvrir ne doit jamais
   * interrompre tout le lot (le tableau de résultats reste la source de
   * vérité minimale). Utilisée aussi par `fetchDerogationForMatch`.
   */
  private async fetchDerogationDetailForRow(page: Page, rowIndex: number): Promise<FbiDerogationDetailFields | null> {
    const href = await this.derogationRowDetailHref(page, rowIndex);
    if (!href) return null;
    return await this.fetchDerogationDetailByHref(page, href);
  }

  /**
   * `href` du lien de détail (`afficherDerogation.fbi?idDerogation=...`)
   * porté par CHAQUE cellule de donnée de la ligne — confirmé par le HTML
   * source réel d'une ligne fourni par le club le 2026-09-25. La 1ère
   * colonne est une checkbox (jamais un lien, voir la fixture), d'où
   * `a[href]` cherché sur la ligne entière plutôt qu'une cellule précise —
   * n'importe quelle cellule de donnée porte le même `href`.
   */
  private async derogationRowDetailHref(page: Page, rowIndex: number): Promise<string | null> {
    const row = page.locator("table tbody tr").nth(rowIndex);
    if ((await row.count().catch(() => 0)) === 0) return null;

    const link = row.locator('a[href*="afficherDerogation"]').first();
    if ((await link.count().catch(() => 0)) === 0) return null;

    return await link.getAttribute("href").catch(() => null);
  }

  /**
   * Ouvre `href` dans un NOUVEL onglet du même `BrowserContext` (mêmes
   * cookies de session, aucune reconnexion) — jamais la page principale —
   * lit son détail, puis ferme l'onglet. Best effort intégral : la page
   * principale (son URL, son tableau, sa pagination) n'est JAMAIS touchée
   * par cette méthode, qu'elle réussisse ou échoue.
   */
  private async fetchDerogationDetailByHref(page: Page, href: string): Promise<FbiDerogationDetailFields | null> {
    let detailPage: Page | null = null;
    try {
      const absoluteUrl = new URL(href, page.url()).toString();
      detailPage = await page.context().newPage();
      await detailPage.goto(absoluteUrl, { waitUntil: "domcontentloaded" });
      await this.settle(detailPage);
      return await selectors.derogationDetailFields(detailPage).catch(() => null);
    } catch {
      return null;
    } finally {
      if (detailPage) await detailPage.close().catch(() => {});
    }
  }

  /**
   * Rejoint l'écran de recherche des dérogations et réinitialise "Etat de
   * la dérogation" sur l'état demandé (`pass`) PAR LIBELLÉ (voir
   * ci-dessous, jamais par position — un précédent correctif sélectionnait
   * à tort le premier `<option>`, "A Créer" dans la vraie liste, ce qui
   * aurait masqué toutes les vraies demandes en cours). Best effort,
   * jamais bloquant. Partagé par `fetchDerogationForMatch` et
   * `fetchAllDerogations`, chacun bouclant sur `DEROGATION_ETAT_PASSES`
   * (voir sa doc, § "ya le statut en cours qui est pas pris en compte").
   */
  private async navigateToDerogationSearchScreen(page: Page, pass: DerogationEtatPass = "tousLesEtats"): Promise<void> {
    const targetUrl = `${this.baseUrl}/rechercherDerogation.fbi`;

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await this.settle(page);
    } catch (error) {
      throw new FbiError(`Écran de recherche des dérogations injoignable : ${targetUrl}`, "NAVIGATION_FAILED", error);
    }

    /**
     * Sélectionne "Tous les états (sauf à créer)" (`TT`) ou "En Cours"
     * (`EC`) selon `pass` — confirmé par capture d'écran ET par le HTML
     * source réel de `rechercherDerogation.fbi` fourni par le club les
     * 2026-09-25/26 : les 6 options réelles sont "A Créer" (value="CREER")
     * | "En Cours" (value="EC") | "Acceptée par les deux associations
     * sportives" (value="ACCEPT") | "Acceptée par l'organisme dirigeant"
     * (value="ORGCREACC") | "Refusée" (value="ORGCREREF") | "Tous les
     * états (sauf à créer)" (value="TT") — valeurs jamais devinées, lues
     * dynamiquement ci-dessous par LIBELLÉ, jamais codées en dur.
     *
     * **Bug corrigé le 2026-09-25 (deuxième round, HTML réel fourni par le
     * club après un premier test en production qui ne renvoyait QUE des
     * lignes "A Créer")** : le sélecteur `<select>` est trouvé par
     * attribut `name` (`*="etat" i`, même principe que `nonJoueCheckbox`
     * ci-dessus), JAMAIS en le cherchant comme ENFANT d'un `<label>` — le
     * vrai balisage FBI (MDB/bootstrap-select) place le `<label>` APRÈS le
     * `<select>`, comme FRÈRE, jamais autour de lui :
     * `<select name="...etatDerogation">...</select><label>Etat de la
     * dérogation</label>`. L'ancienne recherche `label:has-text(...) >
     * select` ne trouvait donc RIEN sur le vrai site (0 correspondance,
     * `count() === 0`) — le bloc entier était silencieusement ignoré
     * (best effort), laissant le filtre à son état de fait au moment du
     * chargement de page, jamais explicitement forcé sur "Tous les
     * états". Recherché par le LIBELLÉ visible de l'option ("tous les
     * états"), jamais par position — un tout premier correctif (avant
     * celui-ci) sélectionnait à tort le PREMIER `<option>` ("A Créer"
     * dans la vraie liste), ce qui aurait restreint chaque recherche à
     * cet unique état au lieu de toutes les VRAIES demandes en cours ("A
     * Créer" désigne une rencontre sans dérogation active, pas une
     * demande — l'exclure est le comportement voulu pour "vérifier
     * toutes les demandes", jamais un oubli).
     */
    const labelPattern = pass === "enCours" ? /^en cours$/i : /tous les [ée]tats/i;

    try {
      const etatSelect = page.locator('select[name*="etat" i]').first();
      if ((await etatSelect.count().catch(() => 0)) > 0) {
        const options = etatSelect.locator("option");
        const optionCount = await options.count().catch(() => 0);

        for (let i = 0; i < optionCount; i += 1) {
          const label = ((await options.nth(i).textContent().catch(() => "")) ?? "").trim();
          if (!labelPattern.test(label)) continue;

          const value = await options.nth(i).getAttribute("value").catch(() => null);
          await etatSelect.selectOption(value !== null ? { value } : { label }).catch(() => {});
          break;
        }
      }
    } catch {
      // Best effort — voir la note ci-dessus.
    }
  }

  /**
   * "utiliser correctement `page.waitForEvent('download')` OU ÉQUIVALENT".
   * Un `BrowserContext` Playwright expose un `APIRequestContext`
   * (`context.request`) qui réutilise AUTOMATIQUEMENT les cookies de la
   * session authentifiée pour une requête vers la même origine —
   * équivalent robuste et plus simple qu'un clic + interception
   * d'événement pour un lien de téléchargement direct, sans jamais passer
   * par le système de fichiers utilisateur (le seul stockage temporaire
   * touché par ce module est celui de @sparticuz/chromium dans `/tmp`,
   * voir browser-launcher.ts).
   */
  async downloadDocument(session: BrowserFbiSession, url: string): Promise<Buffer> {
    const response = await session.context.request.get(url);

    if (!response.ok()) {
      throw new FbiError(`Téléchargement FBI : réponse HTTP ${response.status()} (${url})`, "REQUEST_FAILED");
    }

    return response.body();
  }

  async closeSession(session: BrowserFbiSession): Promise<void> {
    await session.context.close();
  }
}
