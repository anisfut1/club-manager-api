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
  // Écran de recherche RÉEL confirmé par capture d'écran du vrai FBI le
  // 2026-09-24 (§ "Dix-huitième déclenchement", docs/FBI.md) — jamais deviné.
  server.setRoute({ path: "/rechercherRencontreSaisieResultat.fbi", contentType: "text/html", body: fixture("rechercher-rencontre.html") });
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

describe("BrowserFbiClient.findEmarqueDocuments (§ 'Dix-huitième déclenchement', docs/FBI.md : navigation confirmée par capture d'écran du vrai FBI, jamais devinée)", () => {
  it("navigue directement vers l'écran de recherche RÉEL, remplit N° Rencontre (jamais la checkbox « non joué » qui précède ce champ dans le DOM), et clique le lien de la colonne EM pour trouver les documents — régression production 2026-09-24 : § 'Dix-neuvième déclenchement', docs/FBI.md", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const documents = await client.findEmarqueDocuments(session, "2813");

    expect(documents).toContainEqual(expect.objectContaining({ fileName: "2813.zip" }));
    expect(documents.some((d) => /feuille/i.test(d.fileName) || d.url.includes("feuille"))).toBe(true);
    expect(documents.some((d) => d.url.includes("autre-lien-sans-rapport"))).toBe(false);

    await client.closeSession(session);
  });

  it("exclut le lien-leurre de téléchargement du LOGICIEL e-Marque, déduplique un même lien répété dans le DOM, et évite toute collision de nom de fichier entre deux documents distincts au libellé identique — régression production 2026-09-24 : rencontre n°1481 RÉELLEMENT réussie, mais avait téléchargé \"Télécharger e-Marque V2.pdf\" (logiciel, pas les données du match) et 3 copies d'un même document sous le nom générique \"e-Marque.pdf\" qui s'écrasaient en Storage (§ 'Vingt-deuxième déclenchement', docs/FBI.md)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const documents = await client.findEmarqueDocuments(session, "2813");

    // Le lien-leurre logiciel (fixture detail.html : "Télécharger e-Marque
    // V2" → /logiciel/emarque-v2.pdf) ne doit JAMAIS apparaître.
    expect(documents.some((d) => d.url.includes("emarque-v2.pdf") || /v ?2/i.test(d.fileName))).toBe(false);

    // Les deux liens vers /telechargerDocument.fbi?id=aaa (dupliqués deux
    // fois dans le DOM de la fixture) ne doivent produire qu'UN seul
    // document, jamais deux copies du même.
    const aaaDocs = documents.filter((d) => d.url.includes("id=aaa"));
    expect(aaaDocs).toHaveLength(1);

    // id=aaa et id=bbb partagent le même libellé visible ("e-Marque") mais
    // sont des documents DIFFÉRENTS : leurs noms de fichier dérivés ne
    // doivent jamais entrer en collision (sinon l'un écrase l'autre dans
    // Storage, comme constaté en production).
    const bbbDocs = documents.filter((d) => d.url.includes("id=bbb"));
    expect(bbbDocs).toHaveLength(1);
    expect(aaaDocs[0].fileName).not.toBe(bbbDocs[0].fileName);

    await client.closeSession(session);
  });

  it("renvoie une liste vide (jamais une erreur) quand la rencontre existe dans le tableau de résultats mais que sa colonne EM est vide (pas encore jouée / sans e-Marque)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    // "9999" est présente dans rechercher-rencontre.html (fixture) avec une
    // colonne EM vide : emarqueColumnLinkForMatch ne trouve rien à cliquer,
    // on reste sur la page de résultats — qui mentionne bien "9999" (colonne
    // N°), donc PAS d'EMARQUE_MATCH_PAGE_NOT_REACHED — mais ne contient
    // aucun lien de document, donc une liste vide.
    const documents = await client.findEmarqueDocuments(session, "9999");

    expect(documents).toEqual([]);
    await client.closeSession(session);
  });

  it("lève EMARQUE_MATCH_PAGE_NOT_REACHED (jamais un faux succès) quand la rencontre n'apparaît nulle part dans le tableau de résultats", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    // Aucune ligne "77777" dans rechercher-rencontre.html (fixture) : ni
    // emarqueColumnLinkForMatch ni pageMentionsMatchNumber ne peuvent
    // matcher.
    await expect(client.findEmarqueDocuments(session, "77777")).rejects.toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });

    await client.closeSession(session);
  });

  it("lève EMARQUE_MATCH_PAGE_NOT_REACHED même pour un numéro de rencontre court (\"1\") qui apparaît par hasard comme fragment d'un autre nombre sur la page — régression production 2026-09-24 : un simple .includes(\"1\") matchait n'importe quel nombre contenant 1 (ex: \"2813\"), faisant \"réussir\" la rencontre n°1 alors qu'aucune ligne \"1\" n'existe dans le tableau", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    await expect(client.findEmarqueDocuments(session, "1")).rejects.toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });

    await client.closeSession(session);
  });

  it("inclut une trace de navigation étape par étape ET les liens visibles dans le message d'erreur — diagnostic pour ajuster la navigation sur preuve, jamais à l'aveugle (§ 'Seizième/Dix-septième déclenchement', docs/FBI.md)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const error = await client.findEmarqueDocuments(session, "77777").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });
    expect((error as Error).message).toContain("Trace de navigation");
    expect((error as Error).message).toContain("Liens visibles sur cette page");
    // Régression production 2026-09-24 (§ "Vingt-quatrième déclenchement") :
    // saison/case correctement ajustées, bon bouton cliqué, toujours aucun
    // résultat — le HTML brut du formulaire est désormais inclus pour voir
    // la structure réelle des widgets plutôt que deviner une 5e fois.
    expect((error as Error).message).toContain("HTML du formulaire");
    expect((error as Error).message).toContain('name="idSaison"');

    await client.closeSession(session);
  });

  it("inclut le nom du champ ciblé (jamais supposé) ET un dump des champs de formulaire, y compris l'option sélectionnée d'un <select> — diagnostic ajouté après une recherche \"réussie\" sans aucun résultat en production (§ 'Dix-neuvième déclenchement', docs/FBI.md)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const error = await client.findEmarqueDocuments(session, "77777").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });
    const message = (error as Error).message;
    expect(message).toContain('champ "numeroRencontre" rempli');
    expect(message).toContain("Champs de formulaire sur cette page");
    expect(message).toContain('select[name=idSaison]="Saison 2026-2027"');
    // Régression production 2026-09-24 (§ "Vingtième déclenchement") :
    // le dump n'incluait pas les <button>, impossible de vérifier quel
    // bouton searchSubmitControl avait réellement ciblé.
    expect(message).toContain('button[type=submit,name=]="RECHERCHER"');
    expect(message).toContain('bouton "RECHERCHER" cliqué');
    // Et confondait la valeur de soumission fixe d'une checkbox ("true")
    // avec son état coché réel — corrigé pour lire isChecked(). Le dump
    // ci-dessous reflète la page rechargée par le serveur de test
    // STATIQUE (qui ignore les query params, sert toujours le fixture
    // par défaut — checkbox cochée) : preuve que le format "checked"
    // (jamais l'ancien "true" de l'attribut value) est bien utilisé.
    expect(message).toContain('input[type=checkbox,name=rechercheRencontreSaisieResultatForm.rechercherRencontreSaisieResultatBean.nonJoue]="checked"');

    await client.closeSession(session);
  });

  it("décoche la case « non joué » (cochée par défaut) et sélectionne la saison du match AVANT de chercher — régression production 2026-09-24 : ces deux filtres par défaut empêchaient de trouver N'IMPORTE QUEL match déjà joué, quel que soit le numéro (§ 'Dix-neuvième déclenchement', docs/FBI.md)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const error = await client.findEmarqueDocuments(session, "77777", "2025-2026").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });
    const message = (error as Error).message;
    expect(message).toContain('case "non joué" décochée');
    expect(message).toContain('saison "Saison 2025-2026" sélectionnée');
    // Preuve que la sélection a réellement été SOUMISE (pas juste rapportée
    // dans la trace) : l'étape [3] montre l'URL après soumission du
    // formulaire, qui inclut la valeur ("12") de l'option "Saison
    // 2025-2026" choisie. Le dump des champs de formulaire, lui, reflète
    // la page rechargée par le serveur de test STATIQUE (qui ignore les
    // query params et sert toujours le même fixture par défaut) — pas
    // représentatif de la vraie page FBI, qui refléterait la sélection
    // soumise ; on ne peut donc pas s'y fier ici.
    expect(message).toContain("idSaison=12");

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
