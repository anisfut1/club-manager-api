import * as cheerio from "cheerio";
import { SimpleCookieJar } from "./cookie-jar.js";
import { FbiError } from "./errors.js";
import type { EmarqueDocumentRef, FbiAutomationClient, FbiCredentialsInput } from "./types.js";

/**
 * HttpFbiClient — client HTTP direct pour FBI (pas de navigateur, voir
 * ARCHITECTURE.md §7 : "Je ne veux pas d'un Chromium permanent dans Vercel
 * si FBI peut fonctionner en HTTP classique"). Implémente
 * `FbiAutomationClient` — c'est la stratégie PRIMAIRE, essayée en premier
 * par `createFbiAutomationClient()` (voir ./create-client.ts) ; l'app ne
 * l'appelle jamais directement en dehors de ce module et de l'action de
 * test de connexion, qui teste explicitement CETTE implémentation.
 *
 * Statut : le login (formulaire HTML détecté dynamiquement, jamais de nom
 * de champ deviné) est PREPARED — jamais exécuté contre le vrai FBI depuis
 * cet environnement (réseau *.ffbb.com bloqué, voir
 * docs/FBI_AUTHENTICATED_SPIKE.md). La découverte de documents e-Marque n'a
 * PAS d'endpoint HTTP confirmé : `findEmarqueDocuments` échoue
 * explicitement avec `EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED` plutôt que
 * d'inventer une route (§58 du brief FBI) — c'est `BrowserFbiClient`
 * (./browser-client.ts) qui assure ce rôle en attendant.
 */

export const FBI_DEFAULT_BASE_URL = "https://extranet.ffbb.com/fbi";

/** Aplatit les espaces/retours à la ligne pour rester lisible dans un log JSON une ligne, et borne la longueur. */
function truncateFlat(text: string, maxLength: number): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}…` : flattened;
}

/**
 * Extrait le TEXTE VISIBLE (`<body>`, balises retirées) d'une page HTML,
 * pour le diagnostic de login (voir `HttpFbiClient.login`) — jamais le
 * balisage brut : les 500 premiers caractères d'un `<head>` sont un
 * boilerplate quasi identique sur toute page FBI (succès ou échec, voir
 * docs/FBI.md), donc sans valeur diagnostique. Le texte visible du corps
 * (ex: "Identifiant ou mot de passe incorrect", ou au contraire le nom du
 * club connecté) est ce qui distingue réellement un échec d'un succès.
 * `<script>`/`<style>` retirés AVANT extraction : `.text()` de cheerio
 * inclut leur contenu textuel (jamais visible dans un navigateur — code
 * JS/CSS, pas du texte), constaté en production le 2026-09-22 (voir
 * docs/FBI.md) : les 500 premiers caractères n'étaient QUE du JavaScript
 * inline, aucune valeur diagnostique non plus. Jamais la page entière
 * dans un message d'erreur ou un log.
 */
function visibleBodyText(html: string, maxLength = 500): string {
  const $ = cheerio.load(html);
  $("script, style").remove();
  return truncateFlat($("body").text(), maxLength);
}

export interface HttpFbiSession {
  cookieJar: SimpleCookieJar;
}

interface LoginForm {
  action: string;
  usernameField: string;
  passwordField: string;
  hiddenFields: Record<string, string>;
  /**
   * Bouton de soumission (`<button name=... value=...>`/`<input
   * type="submit" name=... value=...>`), s'il en a un nommé. Beaucoup
   * d'applis Java (Struts/JSF) exigent ce couple nom/valeur dans le POST
   * pour router vers l'action "connexion" — l'omettre peut faire retomber
   * silencieusement le serveur sur la page de login avec un message
   * générique, quels que soient les identifiants envoyés (constaté en
   * production, voir docs/FBI.md).
   */
  submitButton: { name: string; value: string } | null;
}

export interface HttpFbiClientOptions {
  baseUrl?: string;
  /** Injection pour les tests — jamais utilisé en production. */
  fetchImpl?: typeof fetch;
}

export class HttpFbiClient implements FbiAutomationClient<HttpFbiSession> {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpFbiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? FBI_DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Analyse le HTML de la page de connexion pour trouver le formulaire de
   * login, sans supposer à l'avance les noms de ses champs — le formulaire
   * réel n'a pas pu être inspecté avant l'écriture de ce code (voir
   * docs/FBI_AUTHENTICATED_SPIKE.md).
   */
  private parseLoginForm(html: string, pageUrl: string): LoginForm | null {
    const $ = cheerio.load(html);
    const passwordInput = $('input[type="password"]').first();
    if (passwordInput.length === 0) return null;

    const form = passwordInput.closest("form");
    if (form.length === 0) return null;

    const passwordField = passwordInput.attr("name");
    if (!passwordField) return null;

    const usernameInput = form
      .find('input[type="text"], input[type="email"], input:not([type])')
      .first();
    const usernameField = usernameInput.attr("name");
    if (!usernameField) return null;

    const hiddenFields: Record<string, string> = {};
    form.find('input[type="hidden"]').each((_, el) => {
      const name = $(el).attr("name");
      if (name) hiddenFields[name] = $(el).attr("value") ?? "";
    });

    const submitControl = form.find('button[type="submit"], input[type="submit"]').first();
    const submitName = submitControl.attr("name");
    const submitButton = submitName ? { name: submitName, value: submitControl.attr("value") ?? "" } : null;

    const actionAttr = form.attr("action") || pageUrl;
    const action = new URL(actionAttr, pageUrl).toString();

    return { action, usernameField, passwordField, hiddenFields, submitButton };
  }

  private looksLikeLoginPage(html: string): boolean {
    const $ = cheerio.load(html);
    return $('input[type="password"]').length > 0;
  }

  /**
   * Connexion avec les identifiants du club. Lève `FbiError` avec un code
   * explicite plutôt que de faire semblant de réussir — voir
   * `classifyFbiLoginStatus` (./errors.ts) pour la traduction en statut
   * exploitable par l'UI/le worker.
   *
   * Ce chemin n'a JAMAIS été confirmé contre le vrai FBI (voir docs/FBI.md,
   * statut PREPARED — contrairement à FFBB, passé par plusieurs cycles de
   * diagnostic réel avant de fonctionner). Chaque échec embarque donc un
   * diagnostic borné (champs de formulaire détectés, statut HTTP, TEXTE
   * VISIBLE de la page concernée — jamais son balisage brut, voir
   * `visibleBodyText` ; jamais le mot de passe, un cookie de session ou un
   * jeton) directement dans le message de l'erreur : `logError` (logger.ts)
   * ne capture que `error.message`/`.stack`, jamais `.cause`, donc c'est le
   * seul endroit où ce détail survit jusqu'aux logs Vercel — même
   * discipline que `directus-client.ts` côté FFBB (`request()`), qui a
   * permis de corriger plusieurs bugs réels via `vercel logs` plutôt que
   * deviner.
   */
  async login(credentials: FbiCredentialsInput): Promise<HttpFbiSession> {
    const cookieJar = new SimpleCookieJar();
    const loginUrl = `${this.baseUrl}/connexion.fbi`;

    let loginPage: Response;
    try {
      loginPage = await this.fetchImpl(loginUrl);
    } catch (error) {
      throw new FbiError("Page de connexion FBI injoignable", "LOGIN_PAGE_UNREACHABLE", error);
    }

    if (!loginPage.ok) {
      throw new FbiError(`Page de connexion FBI : réponse HTTP ${loginPage.status}`, "LOGIN_PAGE_UNREACHABLE");
    }

    cookieJar.applySetCookieHeaders(loginPage.headers);
    const html = await loginPage.text();

    const form = this.parseLoginForm(html, loginPage.url || loginUrl);
    if (!form) {
      throw new FbiError(
        "Formulaire de connexion FBI non reconnu (la structure de la page a peut-être changé). " +
          `Extrait de la page reçue : ${visibleBodyText(html)}`,
        "LOGIN_FORM_NOT_RECOGNIZED",
      );
    }

    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(form.hiddenFields)) body.set(name, value);
    body.set(form.usernameField, credentials.username);
    body.set(form.passwordField, credentials.password);
    if (form.submitButton) body.set(form.submitButton.name, form.submitButton.value);

    let submitResponse: Response;
    try {
      submitResponse = await this.fetchImpl(form.action, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookieJar.cookieHeader,
        },
        body: body.toString(),
        redirect: "manual",
      });
    } catch (error) {
      throw new FbiError("Requête de connexion FBI échouée", "REQUEST_FAILED", error);
    }

    cookieJar.applySetCookieHeaders(submitResponse.headers);

    const formDiagnostic =
      `formulaire détecté (action=${form.action}, champ identifiant=${form.usernameField}, ` +
      `champ mot de passe=${form.passwordField}, bouton de soumission=` +
      `${form.submitButton ? `${form.submitButton.name}=${form.submitButton.value}` : "aucun trouvé"}), ` +
      `réponse de soumission HTTP ${submitResponse.status}`;

    const redirectLocation = submitResponse.headers.get("location");

    let landingHtml: string;
    if (redirectLocation) {
      const landingUrl = new URL(redirectLocation, form.action).toString();
      const landing = await this.fetchImpl(landingUrl, { headers: { cookie: cookieJar.cookieHeader } });
      cookieJar.applySetCookieHeaders(landing.headers);
      landingHtml = await landing.text();
    } else if (submitResponse.ok) {
      // Pas de redirection : le corps de LA RÉPONSE DE SOUMISSION EST déjà
      // la page de résultat (pattern classique d'une appli Java qui rend
      // directement le résultat du POST plutôt que de rediriger). Refaire
      // un GET séparé vers la même URL d'action, hors contexte du POST,
      // renvoyait le formulaire de connexion vierge et faisait échouer
      // TOUTE connexion avec LOGIN_FAILED, identifiants corrects ou pas —
      // bug réel constaté en production (2026-09-22, voir docs/FBI.md),
      // corrigé ici.
      landingHtml = await submitResponse.text();
    } else {
      // Ni redirection ni 2xx sur la soumission : la connexion a
      // probablement échoué AVANT même d'atteindre une page de connexion
      // reconnaissable (ex: 403/500 applicatif) — un `landingHtml` vide
      // ne doit jamais être silencieusement traité comme "page de
      // connexion absente donc succès" (piège précédent, corrigé ici).
      throw new FbiError(
        `Connexion FBI refusée sans redirection ni réponse OK (${formDiagnostic}).`,
        "LOGIN_FAILED",
      );
    }

    if (this.looksLikeLoginPage(landingHtml)) {
      throw new FbiError(
        `Connexion FBI refusée (identifiants incorrects, ou formulaire modifié depuis l'écriture de ce code) — ${formDiagnostic}. ` +
          `Extrait de la page d'atterrissage : ${visibleBodyText(landingHtml)}`,
        "LOGIN_FAILED",
      );
    }

    if (cookieJar.size === 0) {
      throw new FbiError(`Aucun cookie de session reçu après connexion FBI (${formDiagnostic}).`, "LOGIN_FAILED");
    }

    return { cookieJar };
  }

  /**
   * Vérifie qu'une session est toujours active (pour /admin/integrations/fbi
   * et pour décider de reconnecter automatiquement avant un job, voir
   * ARCHITECTURE.md §6).
   */
  async isSessionValid(session: HttpFbiSession): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl}/accueil.fbi`, {
      headers: { cookie: session.cookieJar.cookieHeader },
    });
    const html = await response.text();
    return response.ok && !this.looksLikeLoginPage(html);
  }

  /**
   * Recherche les documents e-Marque disponibles pour un numéro de
   * rencontre donné.
   *
   * NON IMPLÉMENTÉ EN HTTP DIRECT : l'endpoint réel (écran "Compétitions" de
   * FBI, export e-Marque) n'a pas pu être observé depuis cet environnement
   * (voir docs/FBI_AUTHENTICATED_SPIKE.md). Cette méthode ne devine jamais
   * une URL (§58 du brief FBI) : elle échoue explicitement avec un code
   * exploitable par le worker, qui bascule alors sur `BrowserFbiClient`.
   */
  async findEmarqueDocuments(_session: HttpFbiSession, matchNumber: string): Promise<EmarqueDocumentRef[]> {
    throw new FbiError(
      `Endpoint de découverte des documents e-Marque non confirmé pour la rencontre ${matchNumber}. ` +
        "Voir docs/FBI_AUTHENTICATED_SPIKE.md : à compléter avec un rapport sanitisé réel du spike navigateur.",
      "EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED",
    );
  }

  /**
   * Télécharge un document depuis une URL FBI authentifiée. Le mécanisme
   * (GET + cookie de session) est générique et réutilisable dès que
   * `findEmarqueDocuments` sera complété avec un vrai endpoint.
   */
  async downloadDocument(session: HttpFbiSession, url: string): Promise<Buffer> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { cookie: session.cookieJar.cookieHeader } });
    } catch (error) {
      throw new FbiError(`Téléchargement FBI échoué : ${url}`, "REQUEST_FAILED", error);
    }

    if (!response.ok) {
      throw new FbiError(`Téléchargement FBI : réponse HTTP ${response.status} (${url})`, "REQUEST_FAILED");
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
