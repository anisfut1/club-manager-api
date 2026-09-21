import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestServer, readFixture } from "@/test-support/static-server";
import { BrowserFbiClient } from "./browser-client";
import { FbiError } from "./errors";

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

  it("renvoie une liste vide (jamais une erreur) quand aucun document n'est encore disponible", async () => {
    server.setRoute({ path: "/detail.fbi", contentType: "text/html", body: fixture("detail-no-documents.html") });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const documents = await client.findEmarqueDocuments(session, "9999");

    expect(documents).toEqual([]);
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
