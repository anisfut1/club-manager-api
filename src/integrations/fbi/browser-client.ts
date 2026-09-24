import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { FbiError } from "./errors.js";
import * as selectors from "./selectors.js";

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
   * plutôt que de planter — le retour `[]` déclenche un retry planifié
   * ("document pas encore trouvé" n'est pas une erreur).
   *
   * `season` (format "2025-2026", voir `resolveSeasonLabel` côté appelant)
   * est OPTIONNEL mais fortement recommandé : voir `tryPrepareSearchFilters`.
   */
  async findEmarqueDocuments(session: BrowserFbiSession, matchNumber: string, season: string | null = null): Promise<{ url: string; fileName: string }[]> {
    const { page } = session;

    const trace: string[] = [];
    trace.push(await this.tryNavigateToSearchScreen(page));
    trace.push(await this.tryPrepareSearchFilters(page, season));
    trace.push(await this.trySearchByMatchNumber(page, matchNumber));
    trace.push(await this.tryOpenMatchResult(page, matchNumber));

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

      throw new FbiError(
        `Page de résultat introuvable pour la rencontre ${matchNumber} : ni la recherche ni l'ouverture du résultat n'ont abouti (page actuelle : "${title}", ${page.url()}). ` +
          `Trace de navigation : [1] ${trace[0]} — [2] ${trace[1]} — [3] ${trace[2]} — [4] ${trace[3]}. ` +
          `Champs de formulaire sur cette page : ${formFieldsSummary}. ` +
          `Liens visibles sur cette page : ${linksSummary}`,
        "EMARQUE_MATCH_PAGE_NOT_REACHED",
      );
    }

    const links = await selectors.findDocumentLinks(page);
    return links.map((link) => ({
      url: new URL(link.href, page.url()).toString(),
      fileName: this.fileNameFromLabelOrUrl(link),
    }));
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
      return urlAfter === urlBefore
        ? `champ "${inputName}" rempli ("${matchNumber}") et recherche soumise${submitNote}, mais l'URL n'a pas changé (${urlAfter})`
        : `champ "${inputName}" rempli et recherche soumise${submitNote}, url → ${urlAfter}`;
    } catch (error) {
      return `champ de recherche "${inputName}" trouvé mais le remplissage/la soumission a échoué : ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async tryOpenMatchResult(page: Page, matchNumber: string): Promise<string> {
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
    if (!emLink) return `pas de lien e-Marque trouvé pour la rencontre "${matchNumber}" (colonne EM absente, ligne introuvable, ou colonne EM vide — match pas encore joué)`;

    const text = (await emLink.textContent().catch(() => null))?.trim() ?? "?";
    const urlBefore = page.url();
    try {
      await emLink.click();
      await this.settle(page);
      const urlAfter = page.url();
      return urlAfter === urlBefore ? `lien EM "${text}" cliqué, mais l'URL n'a pas changé (${urlAfter})` : `lien EM "${text}" cliqué, url → ${urlAfter}`;
    } catch (error) {
      return `lien EM "${text}" trouvé mais le clic a échoué : ${error instanceof Error ? error.message : String(error)}`;
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
