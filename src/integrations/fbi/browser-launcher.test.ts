import { describe, expect, it } from "vitest";
import { fbiProxySettings } from "./browser-launcher.js";

describe("fbiProxySettings", () => {
  it("aucun proxy configuré : sortie directe", () => {
    expect(fbiProxySettings(undefined)).toBeUndefined();
    expect(fbiProxySettings("")).toBeUndefined();
  });

  it("sépare serveur et identifiants (encodés dans l'URL) au format Playwright", () => {
    expect(fbiProxySettings("http://club%40sete:p%40ss%3Aw0rd@203.0.113.10:3128")).toEqual({
      server: "http://203.0.113.10:3128",
      username: "club@sete",
      password: "p@ss:w0rd",
    });
  });

  it("proxy sans authentification", () => {
    expect(fbiProxySettings("socks5://203.0.113.10:1080")).toEqual({ server: "socks5://203.0.113.10:1080" });
  });
});

describe("fbiBrowserIdentity (FBI coupe l'accès d'un navigateur annoncé « HeadlessChrome »)", async () => {
  const { fbiBrowserIdentity } = await import("./browser-client.js");

  it("se présente comme un Chrome de bureau en français, de la même version que le moteur", () => {
    const identity = fbiBrowserIdentity("141.0.7390.37");
    expect(identity.userAgent).toContain("Chrome/141.0.0.0");
    expect(identity.userAgent).not.toContain("Headless");
    expect(identity.extraHTTPHeaders["sec-ch-ua"]).not.toContain("Headless");
    expect(identity.locale).toBe("fr-FR");
  });
});
