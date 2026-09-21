import { describe, expect, it, vi } from "vitest";
import { FbiError } from "./errors";
import { HttpFbiClient } from "./http-client";

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

    const { SimpleCookieJar } = await import("./cookie-jar");
    const valid = await provider.isSessionValid({ cookieJar: new SimpleCookieJar() });
    expect(valid).toBe(true);
  });

  it("retourne false quand la session a expiré (page de connexion renvoyée)", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(LOGIN_PAGE_HTML));
    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });

    const { SimpleCookieJar } = await import("./cookie-jar");
    const valid = await provider.isSessionValid({ cookieJar: new SimpleCookieJar() });
    expect(valid).toBe(false);
  });
});

describe("HttpFbiClient.findEmarqueDocuments", () => {
  it("échoue explicitement avec EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED (jamais un faux succès)", async () => {
    const provider = new HttpFbiClient({ baseUrl: BASE_URL });
    const { SimpleCookieJar } = await import("./cookie-jar");

    await expect(provider.findEmarqueDocuments({ cookieJar: new SimpleCookieJar() }, "2813")).rejects.toMatchObject({
      code: "EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED",
    });
  });
});

describe("HttpFbiClient.downloadDocument", () => {
  it("retourne le contenu téléchargé sous forme de Buffer", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    const { SimpleCookieJar } = await import("./cookie-jar");

    const buffer = await provider.downloadDocument({ cookieJar: new SimpleCookieJar() }, `${BASE_URL}/export.zip`);
    expect(buffer).toBeInstanceOf(Buffer);
    expect([...buffer]).toEqual([1, 2, 3, 4]);
  });

  it("lève REQUEST_FAILED sur une réponse HTTP en erreur", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const provider = new HttpFbiClient({ baseUrl: BASE_URL, fetchImpl: fetchImpl as unknown as typeof fetch });
    const { SimpleCookieJar } = await import("./cookie-jar");

    await expect(provider.downloadDocument({ cookieJar: new SimpleCookieJar() }, `${BASE_URL}/missing.zip`)).rejects.toMatchObject({
      code: "REQUEST_FAILED",
    });
  });
});
