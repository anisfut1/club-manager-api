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
