import { beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CONFIGURATION_BODY = {
  data: {
    id: 1,
    key_dh: "dh-token",
    key_ms: "ms-token",
    key_directus_website: "website-token",
    key_directus_competitions: "competitions-token",
  },
};

describe("FfbbDirectusClient", () => {
  beforeEach(() => {
    // Les jetons sont mis en cache au niveau module (voir directus-client.ts) —
    // chaque test doit repartir d'un module frais pour ne pas dépendre de
    // l'ordre d'exécution.
    vi.resetModules();
  });

  it("utilise le premier champ candidat qui authentifie réellement contre l'endpoint demandé", async () => {
    const { FfbbDirectusClient: FreshClient } = await import("./directus-client.js");
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      const auth = (init?.headers as Record<string, string>).authorization;
      calls.push(auth);
      if (auth === "Bearer competitions-token") {
        return jsonResponse(200, { data: [{ id: "rencontre-1" }] });
      }
      return jsonResponse(403, { errors: [{ message: "Forbidden" }] });
    });

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const items = await client.listItems("items/ffbbserver_rencontres");

    expect(items).toEqual([{ id: "rencontre-1" }]);
    // "key_directus_competitions" est le premier candidat essayé (voir
    // CANDIDATE_TOKEN_FIELDS) — il fonctionne du premier coup ici, un seul appel.
    expect(calls).toEqual(["Bearer competitions-token"]);
  });

  it("essaie les champs candidats suivants quand les premiers échouent avec 401/403", async () => {
    const { FfbbDirectusClient: FreshClient } = await import("./directus-client.js");
    const attempted: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      const auth = (init?.headers as Record<string, string>).authorization;
      attempted.push(auth);
      if (auth === "Bearer dh-token") {
        return jsonResponse(200, { data: [{ id: "org-1" }] });
      }
      return jsonResponse(401, { errors: [{ message: "Unauthorized" }] });
    });

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const items = await client.listItems("items/ffbbserver_organismes");

    expect(items).toEqual([{ id: "org-1" }]);
    expect(attempted).toEqual(["Bearer competitions-token", "Bearer dh-token"]);
  });

  it("échoue avec un message exploitable quand tous les jetons candidats échouent", async () => {
    const { FfbbDirectusClient: FreshClient } = await import("./directus-client.js");
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      return jsonResponse(403, { errors: [{ message: "Forbidden" }] });
    });

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.listItems("items/ffbbserver_rencontres")).rejects.toMatchObject({
      name: "FfbbApiError",
      code: "REQUEST_FAILED",
    });
  });

  it("signale une réponse de configuration non-JSON (page de blocage WAF probable) sans planter", async () => {
    const { FfbbDirectusClient: FreshClient } = await import("./directus-client.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>Forbidden by WAF</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.listItems("items/ffbbserver_rencontres")).rejects.toMatchObject({
      name: "FfbbApiError",
      code: "UNEXPECTED_RESPONSE",
    });
  });

  it("signale une configuration sans aucun champ candidat non-vide", async () => {
    const { FfbbDirectusClient: FreshClient } = await import("./directus-client.js");
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (url.toString().includes("items/configuration")) {
        return jsonResponse(200, { data: { id: 1, ios_version: "1.0" } });
      }
      throw new Error("ne devrait jamais être appelé sans jeton");
    });

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.listItems("items/ffbbserver_rencontres")).rejects.toMatchObject({
      code: "UNEXPECTED_RESPONSE",
    });
  });

  it("met en cache le champ gagnant : un deuxième appel n'essaie pas les autres candidats", async () => {
    const { FfbbDirectusClient: FreshClient } = await import("./directus-client.js");
    let configFetches = 0;
    const authHeaders: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        configFetches += 1;
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      authHeaders.push((init?.headers as Record<string, string>).authorization);
      return jsonResponse(200, { data: [{ id: "item" }] });
    });

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.listItems("items/ffbbserver_rencontres");
    await client.listItems("items/ffbbserver_poules");

    expect(configFetches).toBe(1);
    expect(authHeaders).toEqual(["Bearer competitions-token", "Bearer competitions-token"]);
  });
});
