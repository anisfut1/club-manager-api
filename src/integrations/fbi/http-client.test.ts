import { describe, expect, it, vi } from "vitest";
import { FbiError } from "./errors.js";
import { HttpFbiClient } from "./http-client.js";

const BASE_URL = "https://fbi.test.local/fbi";

const LOGIN_PAGE_HTML = `
  <html><body>
    <form action="/fbi/j_security_check" method="post">
      <input type="hidden" name="csrfToken" value="tok-123" />
      <input type="text" name="identifiant" />
      <input type="password" name="motDePasse" />
      <button type="submit">Connexion</button>
    </form>
  </body></html>
`;

const AUTHENTICATED_PAGE_HTML = `<html><body><h1>Accueil FBI</h1><a href="/fbi/deconnexion.fbi">Déconnexion</a></body></html>`;

const AUTHENTICATED_DIRECT_HTML = `<html><body><h1>Bienvenue</h1><a href="/fbi/deconnexion.fbi">Déconnexion</a></body></html>`;

const LOGIN_PAGE_WITH_ERROR_HTML = `
  <html>
    <head><title>FBI - Identification</title><link href="https://fonts.googleapis.com/css2?family=Roboto" rel="stylesheet"></head>
    <body>
      <p class="error">Identifiant ou mot de passe incorrect</p>
      <form action="/fbi/j_security_check" method="post">
        <input type="hidden" name="csrfToken" value="tok-123" />
        <input type="text" name="identifiant" />
        <input type="password" name="motDePasse" />
      </form>
    </body>
  </html>
`;

/** Reproduit une page FBI réelle constatée en production (2026-09-22) : du texte visible entouré de <script> inline volumineux (sélecteur multi-comptes). */
const LOGIN_PAGE_WITH_SCRIPT_NOISE_HTML = `
  <html>
    <head><title>FBI - Identification</title></head>
    <body>
      <p>Identifiant ou mot de passe incorrect</p>
      <script>
        $(document).ready(function() {
          $('.selectpicker').selectpicker({ dropupAuto: false });
          $("#loginList").change(function() { connexionEntete('identificationEntete'); });
        });
      </script>
      <form action="/fbi/j_security_check" method="post">
        <input type="password" name="motDePasse" />
      </form>
    </body>
  </html>
`;

function makeResponse(body: string, init: { status?: number; headers?: Record<string, string>; url?: string } = {}) {
  const headers = new Headers(init.headers ?? {});
  const response = new Response(body, { status: init.status ?? 200, headers });
  Object.defineProperty(response, "url", { value: init.url ?? BASE_URL, configurable: true });
  return response;
}

describe("HttpFbiClient.login", () => {
  it("réussit une connexion avec un formulaire HTML simulé et une session valide", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);

      if (url.endsWith("/connexion.fbi")) {
        return makeResponse(LOGIN_PAGE_HTML, { headers: { "set-cookie": "JSESSIONID=abc123; Path=/fbi" } });
      }
      if (url.endsWith("/j_security_check")) {
        return makeResponse("", { status: 302, headers: { location: "/fbi/accueil.fbi" } });
      }
      if (url.endsWith("/accueil.fbi")) {
        return makeResponse(AUTHENTICATED_PAGE_HTML);
      }
      throw new Error(`URL inattendue dans le test : ${url}`);
    });

    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    const session = await provider.login({ username: "club1234", password: "secret" });

    expect(session.cookieJar.has("JSESSIONID")).toBe(true);
    expect(calls).toEqual([
      `${BASE_URL}/connexion.fbi`,
      `${BASE_URL}/j_security_check`,
      `${BASE_URL}/accueil.fbi`,
    ]);
  });

  it("envoie les identifiants dans les bons champs de formulaire (détectés dynamiquement)", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/connexion.fbi")) {
        return makeResponse(LOGIN_PAGE_HTML, { headers: { "set-cookie": "JSESSIONID=abc123; Path=/fbi" } });
      }
      if (url.endsWith("/j_security_check")) {
        capturedBody = String(init?.body ?? "");
        return makeResponse("", { status: 302, headers: { location: "/fbi/accueil.fbi" } });
      }
      return makeResponse(AUTHENTICATED_PAGE_HTML);
    });

    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    await provider.login({ username: "club1234", password: "s3cret" });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("identifiant")).toBe("club1234");
    expect(params.get("motDePasse")).toBe("s3cret");
    expect(params.get("csrfToken")).toBe("tok-123");
  });

  it("inclut le nom/valeur du bouton de soumission dans le POST quand il en a un (Struts/JSF exigent souvent ce couple pour router vers l'action de connexion)", async () => {
    const loginPageWithNamedButton = `
      <html><body>
        <form action="/fbi/j_security_check" method="post">
          <input type="text" name="identifiant" />
          <input type="password" name="motDePasse" />
          <button type="submit" name="method:connexion" value="Connexion">Connexion</button>
        </form>
      </body></html>
    `;
    let capturedBody = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/connexion.fbi")) {
        return makeResponse(loginPageWithNamedButton, { headers: { "set-cookie": "JSESSIONID=abc123; Path=/fbi" } });
      }
      if (url.endsWith("/j_security_check")) {
        capturedBody = String(init?.body ?? "");
        return makeResponse("", { status: 302, headers: { location: "/fbi/accueil.fbi" } });
      }
      return makeResponse(AUTHENTICATED_PAGE_HTML);
    });

    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    await provider.login({ username: "club1234", password: "s3cret" });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("method:connexion")).toBe("Connexion");
  });

  it("lève LOGIN_FORM_NOT_RECOGNIZED si aucun champ mot de passe n'est trouvé", async () => {
    const fetchImpl = vi.fn(async () => makeResponse("<html><body>Page inattendue</body></html>"));
    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(provider.login({ username: "x", password: "y" })).rejects.toMatchObject({
      code: "LOGIN_FORM_NOT_RECOGNIZED",
    });
  });

  it("lève LOGIN_FAILED si la page d'atterrissage est encore une page de connexion", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/connexion.fbi")) return makeResponse(LOGIN_PAGE_HTML);
      if (url.endsWith("/j_security_check")) {
        return makeResponse("", { status: 302, headers: { location: "/fbi/connexion.fbi?invalidate=true" } });
      }
      return makeResponse(LOGIN_PAGE_HTML);
    });

    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(provider.login({ username: "x", password: "mauvais" })).rejects.toBeInstanceOf(FbiError);
    await expect(provider.login({ username: "x", password: "mauvais" })).rejects.toMatchObject({ code: "LOGIN_FAILED" });
  });

  it("le message LOGIN_FAILED embarque les champs de formulaire détectés (diagnostic exploitable via les logs, jamais le mot de passe)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/connexion.fbi")) return makeResponse(LOGIN_PAGE_HTML);
      if (url.endsWith("/j_security_check")) {
        return makeResponse("", { status: 302, headers: { location: "/fbi/connexion.fbi?invalidate=true" } });
      }
      return makeResponse(LOGIN_PAGE_HTML);
    });

    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    try {
      await provider.login({ username: "club1234", password: "s3cret-mot-de-passe" });
      throw new Error("devait lever une FbiError");
    } catch (error) {
      const message = (error as FbiError).message;
      expect(message).toContain("champ identifiant=identifiant");
      expect(message).toContain("champ mot de passe=motDePasse");
      expect(message).toContain("HTTP 302");
      expect(message).not.toContain("s3cret-mot-de-passe");
    }
  });

  it("lève LOGIN_FAILED (jamais un faux succès) quand la soumission ne redirige pas et ne renvoie pas 2xx", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/connexion.fbi")) {
        return makeResponse(LOGIN_PAGE_HTML, { headers: { "set-cookie": "JSESSIONID=abc123; Path=/fbi" } });
      }
      if (url.endsWith("/j_security_check")) {
        // Ni redirection, ni 2xx : un 403 applicatif par exemple — ne doit
        // jamais être interprété comme "pas de page de connexion, donc succès".
        return makeResponse("Forbidden", { status: 403 });
      }
      throw new Error(`URL inattendue dans le test : ${url}`);
    });

    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(provider.login({ username: "x", password: "y" })).rejects.toMatchObject({ code: "LOGIN_FAILED" });
  });

  it("réussit une connexion quand la soumission répond 200 directement (pas de redirection) — lit le corps du POST, jamais un second GET sur la même URL", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/connexion.fbi")) {
        return makeResponse(LOGIN_PAGE_HTML, { headers: { "set-cookie": "JSESSIONID=abc123; Path=/fbi" } });
      }
      if (url.endsWith("/j_security_check")) {
        // 200 direct, pas de Location : le corps EST déjà la page de résultat.
        return makeResponse(AUTHENTICATED_DIRECT_HTML);
      }
      throw new Error(`URL inattendue dans le test (un second GET vers /j_security_check serait le bug corrigé) : ${url}`);
    });

    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    const session = await provider.login({ username: "club1234", password: "secret" });

    expect(session.cookieJar.has("JSESSIONID")).toBe(true);
    expect(calls).toEqual([`${BASE_URL}/connexion.fbi`, `${BASE_URL}/j_security_check`]);
  });

  it("lève LOGIN_FAILED quand la soumission répond 200 directement avec le formulaire de connexion dans SON PROPRE corps (identifiants refusés) — bug réel constaté en production le 2026-09-22, voir docs/FBI.md", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/connexion.fbi")) {
        return makeResponse(LOGIN_PAGE_HTML, { headers: { "set-cookie": "JSESSIONID=abc123; Path=/fbi" } });
      }
      if (url.endsWith("/j_security_check")) {
        // 200 direct : le site rend directement le formulaire de connexion
        // (mot de passe refusé), sans redirection.
        return makeResponse(LOGIN_PAGE_HTML);
      }
      throw new Error(`URL inattendue dans le test : ${url}`);
    });

    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(provider.login({ username: "x", password: "mauvais" })).rejects.toMatchObject({ code: "LOGIN_FAILED" });
  });

  it("le diagnostic montre le TEXTE VISIBLE du corps de la page (ex: le message d'erreur FBI réel), jamais le balisage <head> générique", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/connexion.fbi")) {
        return makeResponse(LOGIN_PAGE_HTML, { headers: { "set-cookie": "JSESSIONID=abc123; Path=/fbi" } });
      }
      if (url.endsWith("/j_security_check")) {
        return makeResponse(LOGIN_PAGE_WITH_ERROR_HTML);
      }
      throw new Error(`URL inattendue dans le test : ${url}`);
    });

    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    try {
      await provider.login({ username: "x", password: "mauvais" });
      throw new Error("devait lever une FbiError");
    } catch (error) {
      const message = (error as FbiError).message;
      expect(message).toContain("Identifiant ou mot de passe incorrect");
      expect(message).not.toContain("fonts.googleapis.com");
    }
  });

  it("exclut le contenu des <script>/<style> du diagnostic (jamais du code JS/CSS à la place du texte visible) — bug réel constaté en production le 2026-09-22, voir docs/FBI.md", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/connexion.fbi")) {
        return makeResponse(LOGIN_PAGE_HTML, { headers: { "set-cookie": "JSESSIONID=abc123; Path=/fbi" } });
      }
      if (url.endsWith("/j_security_check")) {
        return makeResponse(LOGIN_PAGE_WITH_SCRIPT_NOISE_HTML);
      }
      throw new Error(`URL inattendue dans le test : ${url}`);
    });

    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    try {
      await provider.login({ username: "x", password: "mauvais" });
      throw new Error("devait lever une FbiError");
    } catch (error) {
      const message = (error as FbiError).message;
      expect(message).toContain("Identifiant ou mot de passe incorrect");
      expect(message).not.toContain("selectpicker");
      expect(message).not.toContain("connexionEntete");
    }
  });

  it("lève LOGIN_PAGE_UNREACHABLE si la page de connexion est injoignable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(provider.login({ username: "x", password: "y" })).rejects.toMatchObject({
      code: "LOGIN_PAGE_UNREACHABLE",
    });
  });
});

describe("HttpFbiClient.isSessionValid", () => {
  it("retourne true quand la page ne contient pas de formulaire de connexion", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(AUTHENTICATED_PAGE_HTML));
    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    const { SimpleCookieJar } = await import("./cookie-jar.js");
    const valid = await provider.isSessionValid({ cookieJar: new SimpleCookieJar() });
    expect(valid).toBe(true);
  });

  it("retourne false quand la session a expiré (page de connexion renvoyée)", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(LOGIN_PAGE_HTML));
    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    const { SimpleCookieJar } = await import("./cookie-jar.js");
    const valid = await provider.isSessionValid({ cookieJar: new SimpleCookieJar() });
    expect(valid).toBe(false);
  });
});

describe("HttpFbiClient.findEmarqueDocuments", () => {
  it("échoue explicitement avec EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED (jamais un faux succès)", async () => {
    const provider = new HttpFbiClient({ baseUrl: BASE_URL });
    const { SimpleCookieJar } = await import("./cookie-jar.js");

    await expect(provider.findEmarqueDocuments({ cookieJar: new SimpleCookieJar() }, "2813")).rejects.toMatchObject({
      code: "EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED",
    });
  });
});

describe("HttpFbiClient.downloadDocument", () => {
  it("retourne le contenu téléchargé sous forme de Buffer", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    const { SimpleCookieJar } = await import("./cookie-jar.js");

    const buffer = await provider.downloadDocument({ cookieJar: new SimpleCookieJar() }, `${BASE_URL}/export.zip`);
    expect(buffer).toBeInstanceOf(Buffer);
    expect([...buffer]).toEqual([1, 2, 3, 4]);
  });

  it("lève REQUEST_FAILED sur une réponse HTTP en erreur", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    const { SimpleCookieJar } = await import("./cookie-jar.js");

    await expect(provider.downloadDocument({ cookieJar: new SimpleCookieJar() }, `${BASE_URL}/missing.zip`)).rejects.toMatchObject({
      code: "REQUEST_FAILED",
    });
  });
});
