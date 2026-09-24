import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestServer, readFixture } from "../../test-support/static-server.js";
import { BrowserFbiClient } from "./browser-client.js";
import { FbiError } from "./errors.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFixture(path.join(dirname, "__fixtures__", name));

let browser: Browser;
let server: TestServer;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  server = new TestServer();
  await server.start();
});

afterAll(async () => {
  await browser.close();
  await server.stop();
});

beforeEach(() => {
  server.setRoute({ path: "/connexion.fbi", contentType: "text/html", body: fixture("login.html") });
  server.setRoute({ path: "/j_security_check", method: "POST", contentType: "text/html", body: fixture("accueil.html") });
  server.setRoute({ path: "/accueil.fbi", contentType: "text/html", body: fixture("accueil.html") });
  server.setRoute({ path: "/rencontres.fbi", contentType: "text/html", body: fixture("rencontres.html") });
  server.setRoute({ path: "/resultats.fbi", contentType: "text/html", body: fixture("resultats.html") });
  server.setRoute({ path: "/detail.fbi", contentType: "text/html", body: fixture("detail.html") });
  server.setRoute({ path: "/export/2813.zip", contentType: "application/zip", body: Buffer.from("contenu-zip-synthetique") });
});

describe("BrowserFbiClient.login (contre un serveur HTML local synthétique, jamais le vrai FBI)", () => {
  it("détecte dynamiquement le formulaire, se connecte, et détecte le succès par l'absence de champ mot de passe", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });

    const session = await client.login({ username: "club1234", password: "secret" });

    expect(session.page.url()).not.toContain("connexion.fbi");
    await client.closeSession(session);
  });

  it("lève LOGIN_FAILED quand la page d'atterrissage est encore une page de connexion (identifiants invalides)", async () => {
    server.setRoute({ path: "/j_security_check", method: "POST", contentType: "text/html", body: fixture("login.html") });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });

    await expect(client.login({ username: "club1234", password: "mauvais" })).rejects.toMatchObject({ code: "LOGIN_FAILED" });
  });

  it("lève LOGIN_FORM_NOT_RECOGNIZED si la page de connexion ne contient aucun champ mot de passe", async () => {
    server.setRoute({ path: "/connexion.fbi", contentType: "text/html", body: "<html><body>Page inattendue</body></html>" });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });

    await expect(client.login({ username: "x", password: "y" })).rejects.toMatchObject({ code: "LOGIN_FORM_NOT_RECOGNIZED" });
  });

  it("lève LOGIN_PAGE_UNREACHABLE si la page de connexion est injoignable", async () => {
    const client = new BrowserFbiClient({ baseUrl: "http://127.0.0.1:1", browser, navigationSettleMs: 50 });

    await expect(client.login({ username: "x", password: "y" })).rejects.toMatchObject({ code: "LOGIN_PAGE_UNREACHABLE" });
  });

  it("isole chaque session dans son propre contexte navigateur (jamais de cookie partagé entre deux connexions)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });

    const sessionA = await client.login({ username: "club-a", password: "secret" });
    const sessionB = await client.login({ username: "club-b", password: "secret" });

    expect(sessionA.context).not.toBe(sessionB.context);

    await client.closeSession(sessionA);
    await client.closeSession(sessionB);
  });
});

describe("BrowserFbiClient.isSessionValid", () => {
  it("retourne false une fois la session considérée expirée (page de connexion renvoyée)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    server.setRoute({ path: "/accueil.fbi", contentType: "text/html", body: fixture("login.html") });
    const valid = await client.isSessionValid(session);

    expect(valid).toBe(false);
    await client.closeSession(session);
  });
});

describe("BrowserFbiClient.findEmarqueDocuments (navigation générique, best-effort)", () => {
  it("navigue jusqu'à l'écran de résultat et trouve les liens de documents connus", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const documents = await client.findEmarqueDocuments(session, "2813");

    expect(documents).toContainEqual(expect.objectContaining({ fileName: "2813.zip" }));
    expect(documents.some((d) => /feuille/i.test(d.fileName) || d.url.includes("feuille"))).toBe(true);
    expect(documents.some((d) => d.url.includes("autre-lien-sans-rapport"))).toBe(false);

    await client.closeSession(session);
  });

  it("renvoie une liste vide (jamais une erreur) quand la page de LA rencontre est bien atteinte mais n'a encore aucun document", async () => {
    // resultats.fbi doit lier vers CE numéro précis — sinon tryOpenMatchResult
    // ne trouve rien à cliquer et on ne quitte jamais resultats.fbi (voir le
    // commentaire d'EMARQUE_MATCH_PAGE_NOT_REACHED plus bas : ce test doit
    // vraiment atteindre detail.fbi, pas juste échouer discrètement dessus).
    server.setRoute({
      path: "/resultats.fbi",
      contentType: "text/html",
      body: '<html><body><h1>Résultats de recherche</h1><a href="/detail.fbi?numero=9999">Rencontre n°9999 - SC Sète / Thuir</a></body></html>',
    });
    server.setRoute({ path: "/detail.fbi", contentType: "text/html", body: fixture("detail-no-documents.html") });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const documents = await client.findEmarqueDocuments(session, "9999");

    expect(documents).toEqual([]);
    await client.closeSession(session);
  });

  it("lève EMARQUE_MATCH_PAGE_NOT_REACHED même pour un numéro de rencontre court (\"1\") qui apparaît par hasard comme fragment d'un autre nombre sur la page — régression production 2026-09-24 : un simple .includes(\"1\") matchait n'importe quel nombre contenant 1 (ex: \"2813\"), faisant \"réussir\" la rencontre n°1 alors que la recherche cherchait en réalité la rencontre 2813 et n'aboutissait jamais à une page de la rencontre 1, avec les mêmes documents génériques que la rencontre n°1481 (elle, correctement détectée en échec car \"1481\" n'apparaît jamais par hasard)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    // La recherche par "1" ne trouve jamais de résultat correspondant
    // (resultats.fbi ne lie qu'à la rencontre 2813, voir fixtures/) : la
    // navigation reste bloquée sur resultats.fbi, dont le texte contient
    // "2813" — qui EMBARQUE "1" comme chiffre (jamais isolé). Un simple
    // .includes("1") aurait matché à tort.
    await expect(client.findEmarqueDocuments(session, "1")).rejects.toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });

    await client.closeSession(session);
  });

  it("ne clique jamais un élément décoratif contenant le numéro comme fragment (§ régression production 2026-09-24, deuxième round : getByText(matchNumber, { exact: false }) dans tryOpenMatchResult est AUSSI un test de sous-chaîne — pour \"1\", il cliquait le premier élément contenant \"1\" n'importe où (ex: \"page 10\"), atterrissant sur une page fausse mais différente de resultats.fbi", async () => {
    server.setRoute({
      path: "/resultats.fbi",
      contentType: "text/html",
      body: '<html><body><h1>Résultats de recherche</h1><p>Aucune rencontre trouvée. <a href="/decoy.fbi">Voir la page 10</a></p></body></html>',
    });
    server.setRoute({
      path: "/decoy.fbi",
      contentType: "text/html",
      body: '<html><body><h1>Page décorative</h1><a href="/export/decoy.pdf">Télécharger e-Marque V2</a></body></html>',
    });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    // "page 10" contient "1" comme fragment de "10", jamais isolé —
    // tryOpenMatchResult ne doit jamais cliquer ce lien décoratif.
    await expect(client.findEmarqueDocuments(session, "1")).rejects.toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });

    await client.closeSession(session);
  });

  it("lève EMARQUE_MATCH_PAGE_NOT_REACHED plutôt que de remonter à tort les documents d'une autre page (§ régression 2026-09-24 : jamais faire confiance à findDocumentLinks sur une page qui ne mentionne pas la rencontre demandée)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    // Aucune fixture ne mentionne "77777" nulle part (recherche 2813
    // uniquement) : la navigation best-effort n'aboutit jamais à une page
    // de CETTE rencontre.
    await expect(client.findEmarqueDocuments(session, "77777")).rejects.toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });

    await client.closeSession(session);
  });

  it("inclut les liens réellement visibles sur la page bloquée dans le message d'erreur — diagnostic pour ajuster tryNavigateToSearchScreen sur le vrai markup FBI sans deviner à l'aveugle (§ 'Quinzième déclenchement', docs/FBI.md)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const error = await client.findEmarqueDocuments(session, "77777").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });
    expect((error as Error).message).toContain("Liens visibles sur cette page");
    // resultats.fbi (fixture par défaut) contient un lien vers la rencontre 2813 — doit apparaître dans le diagnostic.
    expect((error as Error).message).toContain("2813");

    await client.closeSession(session);
  });
});

describe("BrowserFbiClient.downloadDocument", () => {
  it("télécharge le contenu via le contexte authentifié, sans passer par le système de fichiers", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const buffer = await client.downloadDocument(session, `${server.baseUrl}/export/2813.zip`);

    expect(buffer.toString("utf8")).toBe("contenu-zip-synthetique");
    await client.closeSession(session);
  });

  it("lève REQUEST_FAILED sur une réponse HTTP en erreur", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    await expect(client.downloadDocument(session, `${server.baseUrl}/export/inexistant.zip`)).rejects.toMatchObject({ code: "REQUEST_FAILED" } satisfies Partial<FbiError>);
    await client.closeSession(session);
  });
});
