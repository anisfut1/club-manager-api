import type { Locator, Page } from "playwright-core";

/**
 * Détection FBI centralisée (§16 du brief FBI) : AUCUN sélecteur fragile
 * type `div:nth-child(4) > span:nth-child(2)`. Tout ici se base sur des
 * attributs stables (type, name, href), du texte visible, ou des libellés —
 * la même philosophie que ./http-client.ts (détection dynamique du
 * formulaire de login via cheerio), transposée à Playwright.
 *
 * Le markup RÉEL de FBI au-delà de l'écran de connexion n'a pas pu être
 * observé depuis cet environnement (réseau *.ffbb.com bloqué, voir
 * docs/FBI_AUTHENTICATED_SPIKE.md) : la découverte de documents ci-dessous
 * est donc volontairement générique (texte/extension de fichier) plutôt que
 * câblée sur une page précise — elle est conçue pour survivre à un
 * changement mineur de mise en page FBI, et testée contre des fixtures HTML
 * synthétiques plausibles (voir les tests de browser-client).
 */

/** Un input password visible est la preuve la plus fiable qu'on est sur (ou retombé sur) l'écran de connexion — jamais un simple code HTTP 200 (§15 du brief FBI). */
export async function looksLikeLoginPage(page: Page): Promise<boolean> {
  return (await page.locator('input[type="password"]').count()) > 0;
}

export function passwordInput(page: Page): Locator {
  return page.locator('input[type="password"]').first();
}

/** Premier champ texte/email/sans-type DANS LE MÊME FORMULAIRE que le mot de passe — jamais un nom de champ deviné à l'avance. */
export function usernameInput(page: Page): Locator {
  const form = passwordInput(page).locator("xpath=ancestor::form[1]");
  return form.locator('input[type="text"], input[type="email"], input:not([type])').first();
}

export function loginForm(page: Page): Locator {
  return passwordInput(page).locator("xpath=ancestor::form[1]");
}

/** Bouton de soumission du formulaire de login : type=submit d'abord, sinon un bouton dont le texte visible évoque la connexion. */
export function submitControl(page: Page): Locator {
  const form = loginForm(page);
  const typed = form.locator('button[type="submit"], input[type="submit"]');
  return typed;
}

const LOGIN_BUTTON_TEXT_PATTERN = /connexion|se connecter|connecter|valider/i;

export function submitButtonByText(page: Page): Locator {
  return loginForm(page).getByRole("button", { name: LOGIN_BUTTON_TEXT_PATTERN });
}

/** Une page authentifiée doit prouver un élément stable de post-login (jamais juste "pas de mot de passe visible" — §15). */
export function logoutLink(page: Page): Locator {
  return page.locator('a[href*="deconnexion"], a[href*="logout"]');
}

export interface DiscoveredDocumentLink {
  href: string;
  label: string;
}

const DOCUMENT_EXTENSION_PATTERN = /\.(zip|pdf)(\?|$)/i;
const DOCUMENT_LABEL_PATTERN = /feuille de match|résumé|resume|e-?marque|export|position.*tir|shot/i;

/**
 * Cherche des liens plausibles vers des documents e-Marque sur la page
 * courante (résultat d'une recherche de rencontre) : soit l'URL se termine
 * par une extension de document connue, soit le texte visible du lien
 * évoque un document e-Marque connu (§19 du brief FBI). Ne devine jamais un
 * chemin — ne renvoie que des liens RÉELLEMENT présents sur la page.
 */
export async function findDocumentLinks(page: Page): Promise<DiscoveredDocumentLink[]> {
  const anchors = page.locator("a[href]");
  const count = await anchors.count();
  const found: DiscoveredDocumentLink[] = [];

  for (let i = 0; i < count; i += 1) {
    const anchor = anchors.nth(i);
    const href = await anchor.getAttribute("href");
    if (!href) continue;

    const text = ((await anchor.textContent()) ?? "").trim();
    if (DOCUMENT_EXTENSION_PATTERN.test(href) || DOCUMENT_LABEL_PATTERN.test(text)) {
      found.push({ href, label: text || href });
    }
  }

  return found;
}

/**
 * Diagnostic — liste les liens RÉELLEMENT visibles sur la page courante
 * (texte + href, plafonné), pour l'inclure dans le message d'une
 * `EMARQUE_MATCH_PAGE_NOT_REACHED` (`browser-client.ts`). Constaté en
 * production le 2026-09-24 : la navigation reste bloquée sur "FBI -
 * Accueil" pour TOUT numéro de rencontre testé (§ "Quinzième
 * déclenchement" côté docs/FBI.md), y compris pour des numéros assez
 * spécifiques pour exclure une coïncidence de texte — ce qui pointe vers
 * `tryNavigateToSearchScreen` (le tout premier clic, `getByRole("link",
 * { name: /rencontre|compétition|calendrier/i })`) qui ne trouve rien
 * sur le VRAI accueil FBI, jamais observable depuis cet environnement.
 * Ce dump doit révéler, au prochain échec, les libellés RÉELS des liens
 * de navigation présents — plutôt que d'ajuster le regex à l'aveugle une
 * quatrième fois.
 */
export async function listVisibleLinks(page: Page, limit = 25): Promise<{ text: string; href: string }[]> {
  const anchors = page.locator("a[href]");
  const count = Math.min(await anchors.count(), limit);
  const links: { text: string; href: string }[] = [];

  for (let i = 0; i < count; i += 1) {
    const anchor = anchors.nth(i);
    const href = (await anchor.getAttribute("href").catch(() => null)) ?? "";
    const text = ((await anchor.textContent().catch(() => "")) ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (text || href) links.push({ text, href });
  }

  return links;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Le numéro de rencontre comme nombre ISOLÉ (bordures non-chiffres des
 * deux côtés), jamais un fragment d'un nombre plus grand — même principe
 * que `pageMentionsMatchNumber`, réutilisé par `tryOpenMatchResult`
 * (`browser-client.ts`) : `getByText(matchNumber, { exact: false })` est
 * un test de sous-chaîne, qui pour un numéro court ("1") clique le
 * premier élément contenant "1" n'importe où sur la page (pagination,
 * footer...) plutôt que le vrai résultat de recherche — même régression
 * que celle documentée plus bas, constatée le 2026-09-24 pour la
 * rencontre n°1 malgré le premier correctif de `pageMentionsMatchNumber`.
 */
export function matchNumberAsIsolatedText(matchNumber: string): RegExp {
  return new RegExp(`(?<!\\d)${escapeRegExp(matchNumber)}(?!\\d)`);
}

/**
 * Preuve qu'on est bien sur (ou a atteint) la page de LA rencontre
 * demandée, jamais retombé sur une page générique (accueil, aide) après un
 * échec silencieux des étapes "best effort" de navigation — constaté en
 * production le 2026-09-24 : `findDocumentLinks` remontait systématiquement
 * les MÊMES documents génériques ("Télécharger e-Marque V2.pdf",
 * "Télécharger e-Marque MiniBasket.pdf" — des liens de téléchargement du
 * LOGICIEL e-Marque, pas des documents de match) pour des dizaines de
 * numéros de rencontre différents : preuve que la navigation vers la page
 * de résultat spécifique n'aboutissait jamais, et que `findDocumentLinks`
 * scannait alors une page d'accueil/aide contenant ces liens permanents
 * (`DOCUMENT_EXTENSION_PATTERN` matche N'IMPORTE QUEL lien .pdf/.zip sur la
 * page, quelle qu'elle soit — pas seulement les liens pertinents).
 *
 * FAUX POSITIF constaté le même jour pour la rencontre n°1 : un simple
 * `.includes()` matche "1" n'importe où sur n'importe quelle page (une
 * date, un numéro de version, une pagination...) — la rencontre n°1
 * "réussissait" alors qu'on était encore sur la page d'accueil, avec les
 * mêmes documents génériques que la rencontre n°1481 (elle, correctement
 * détectée en échec — "1481" est assez spécifique pour ne jamais
 * apparaître par hasard). Recherche maintenant le numéro comme un nombre
 * ISOLÉ (bordures non-chiffres des deux côtés), jamais comme fragment
 * d'un nombre plus grand — imparfait pour un numéro à 1-2 chiffres
 * (un vrai faux positif reste possible), mais nettement plus fiable
 * qu'un simple `.includes()`.
 */
export async function pageMentionsMatchNumber(page: Page, matchNumber: string): Promise<boolean> {
  const bodyText = (await page.locator("body").textContent()) ?? "";
  return matchNumberAsIsolatedText(matchNumber).test(bodyText);
}

/** Champ de recherche par numéro de rencontre : basé sur un attribut name/placeholder évocateur, jamais une position. */
export function matchNumberSearchInput(page: Page): Locator {
  return page.locator(
    [
      'input[name*="numero" i]',
      'input[name*="rencontre" i]',
      'input[placeholder*="numéro" i]',
      'input[placeholder*="rencontre" i]',
    ].join(", "),
  );
}
