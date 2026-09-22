import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const VALID_FBI_KEY = Buffer.alloc(32, 7).toString("base64");
const VALID_CRON_SECRET = "a".repeat(16);

const VALID_ENV = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  FBI_CREDENTIALS_ENCRYPTION_KEY: VALID_FBI_KEY,
  CRON_SECRET: VALID_CRON_SECRET,
  FRONTEND_ORIGINS: "http://localhost:3000",
};

describe("parseEnv", () => {
  it("accepte un environnement complet et valide", () => {
    const env = parseEnv(VALID_ENV);
    expect(env.SUPABASE_URL).toBe(VALID_ENV.SUPABASE_URL);
    expect(env.BROWSER_FBI_ENABLED).toBe(false);
    expect(env.FBI_BASE_URL).toBe("https://extranet.ffbb.com/fbi");
  });

  it("rejette une SUPABASE_URL invalide", () => {
    expect(() => parseEnv({ ...VALID_ENV, SUPABASE_URL: "pas-une-url" })).toThrow(/SUPABASE_URL/);
  });

  it("rejette une clé de chiffrement FBI qui ne fait pas 32 octets", () => {
    expect(() => parseEnv({ ...VALID_ENV, FBI_CREDENTIALS_ENCRYPTION_KEY: "trop-court" })).toThrow(/FBI_CREDENTIALS_ENCRYPTION_KEY/);
  });

  it("rejette un CRON_SECRET trop court", () => {
    expect(() => parseEnv({ ...VALID_ENV, CRON_SECRET: "trop-court" })).toThrow(/CRON_SECRET/);
  });

  it("rejette FRONTEND_ORIGINS manquant (jamais de wildcard implicite)", () => {
    expect(() => parseEnv({ ...VALID_ENV, FRONTEND_ORIGINS: undefined })).toThrow(/FRONTEND_ORIGINS/);
  });

  it("transforme BROWSER_FBI_ENABLED='true' en booléen true", () => {
    expect(parseEnv({ ...VALID_ENV, BROWSER_FBI_ENABLED: "true" }).BROWSER_FBI_ENABLED).toBe(true);
  });

  it("toute autre valeur de BROWSER_FBI_ENABLED reste false (sécurité par défaut)", () => {
    expect(parseEnv({ ...VALID_ENV, BROWSER_FBI_ENABLED: "yes" }).BROWSER_FBI_ENABLED).toBe(false);
  });
});
