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
