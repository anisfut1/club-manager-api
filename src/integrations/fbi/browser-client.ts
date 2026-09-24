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
   */
  async findEmarqueDocuments(session: BrowserFbiSession, matchNumber: string): Promise<{ url: string; fileName: string }[]> {
    const { page } = session;

    await this.tryNavigateToSearchScreen(page);
    await this.trySearchByMatchNumber(page, matchNumber);
    await this.tryOpenMatchResult(page, matchNumber);

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
    if (!(await selectors.pageMentionsMatchNumber(page, matchNumber))) {
      const title = await page.title().catch(() => "?");
      throw new FbiError(
        `Page de résultat introuvable pour la rencontre ${matchNumber} : ni la recherche ni l'ouverture du résultat n'ont abouti (page actuelle : "${title}", ${page.url()}).`,
        "EMARQUE_MATCH_PAGE_NOT_REACHED",
      );
    }

    const links = await selectors.findDocumentLinks(page);
    return links.map((link) => ({
      url: new URL(link.href, page.url()).toString(),
      fileName: this.fileNameFromLabelOrUrl(link),
    }));
  }

  private fileNameFromLabelOrUrl(link: { href: string; label: string }): string {
    const fromUrl = link.href.split("/").pop();
    if (fromUrl && /\.(zip|pdf)$/i.test(fromUrl)) return fromUrl;
    return `${link.label.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60) || "document"}.pdf`;
  }

  private async tryNavigateToSearchScreen(page: Page): Promise<void> {
    const entry = page.getByRole("link", { name: /rencontre|compétition|calendrier/i }).first();
    if ((await entry.count()) > 0) {
      try {
        await entry.click();
        await this.settle(page);
      } catch {
        // Best effort — voir la note de statut en tête de fichier.
      }
    }
  }

  private async trySearchByMatchNumber(page: Page, matchNumber: string): Promise<void> {
    const input = selectors.matchNumberSearchInput(page).first();
    if ((await input.count()) === 0) return;

    try {
      await input.fill(matchNumber);
      await input.press("Enter");
      await this.settle(page);
    } catch {
      // Best effort — voir la note de statut en tête de fichier.
    }
  }

  private async tryOpenMatchResult(page: Page, matchNumber: string): Promise<void> {
    /**
     * Constaté en production le 2026-09-24 : `getByText(matchNumber, {
     * exact: false })` est un test de SOUS-CHAÎNE — pour un numéro court
     * ("1"), ça matche le premier élément contenant "1" n'importe où sur
     * la page (pagination, footer, item de liste...), pas forcément le
     * bon résultat de recherche. `selectors.matchNumberAsIsolatedText`
     * applique le même principe de bordure que `pageMentionsMatchNumber`
     * (jamais un fragment d'un nombre plus grand).
     */
    const resultLink = page.getByText(selectors.matchNumberAsIsolatedText(matchNumber)).first();
    if ((await resultLink.count()) === 0) return;

    try {
      await resultLink.click();
      await this.settle(page);
    } catch {
      // Best effort — voir la note de statut en tête de fichier.
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
