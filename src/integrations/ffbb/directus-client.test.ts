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
      if (auth === "Bearer dh-token") {
        return jsonResponse(200, { data: [{ id: "rencontre-1" }] });
      }
      return jsonResponse(403, { errors: [{ message: "Forbidden" }] });
    });

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });
    const items = await client.listItems("items/ffbbserver_rencontres");

    expect(items).toEqual([{ id: "rencontre-1" }]);
    // "key_dh" est le premier candidat essayé (voir CANDIDATE_TOKEN_FIELDS —
    // confirmé comme LE jeton API officiel par le SDK tiers ffbb-data-client,
    // voir le commentaire au-dessus de CANDIDATE_TOKEN_FIELDS) — il fonctionne
    // du premier coup ici, un seul appel.
    expect(calls).toEqual(["Bearer dh-token"]);
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
      if (auth === "Bearer competitions-token") {
        return jsonResponse(200, { data: [{ id: "org-1" }] });
      }
      return jsonResponse(401, { errors: [{ message: "Unauthorized" }] });
    });

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });
    const items = await client.listItems("items/ffbbserver_organismes");

    expect(items).toEqual([{ id: "org-1" }]);
    expect(attempted).toEqual(["Bearer dh-token", "Bearer competitions-token"]);
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

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });

    await expect(client.listItems("items/ffbbserver_rencontres")).rejects.toMatchObject({
      name: "FfbbApiError",
      code: "REQUEST_FAILED",
    });
  });

  it("inclut le corps de la réponse Directus dans le message d'erreur (diagnostic, pas juste le statut HTTP)", async () => {
    // Directus renvoie quasi toujours errors[].message/extensions.code dans le
    // corps — capturer ce texte est ce qui permet de savoir POURQUOI un jeton
    // est refusé (permission sur un champ précis, filtre non autorisé...) sans
    // re-deviner à l'aveugle à chaque échec en production (voir docs/FFBB.md).
    const { FfbbDirectusClient: FreshClient } = await import("./directus-client.js");
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      return jsonResponse(403, {
        errors: [{ message: "You don't have permission to access this.", extensions: { code: "FORBIDDEN" } }],
      });
    });

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });

    await expect(client.listItems("items/ffbbserver_rencontres")).rejects.toMatchObject({
      message: expect.stringContaining("You don't have permission to access this."),
    });
  });

  it("signale une réponse de configuration non-JSON (page de blocage WAF probable) sans planter", async () => {
    const { FfbbDirectusClient: FreshClient } = await import("./directus-client.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>Forbidden by WAF</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });

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

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });

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

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });
    await client.listItems("items/ffbbserver_rencontres");
    await client.listItems("items/ffbbserver_poules");

    expect(configFetches).toBe(1);
    expect(authHeaders).toEqual(["Bearer dh-token", "Bearer dh-token"]);
  });

  it("retente en priorité le dernier champ qui a fonctionné, avant l'ordre fixe des candidats", async () => {
    // Reproduit le scénario constaté en production le 2026-09-22 (voir
    // docs/FFBB.md) : "key_dh" authentifie items/ffbbserver_organismes, puis
    // items/ffbbserver_rencontres échoue en 401 avec le jeton en cache
    // (throttling suspecté). La redécouverte doit retenter "key_dh" en
    // PREMIER plutôt que de repartir de "key_directus_competitions" —
    // moins de requêtes en rafale si la cause est un throttling passager.
    const { FfbbDirectusClient: FreshClient } = await import("./directus-client.js");
    const attempted: string[] = [];
    let dhAttemptsForRencontres = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      const auth = (init?.headers as Record<string, string>).authorization;
      const collection = href.includes("organismes") ? "organismes" : "rencontres";
      attempted.push(`${collection}:${auth}`);

      if (collection === "organismes") {
        return auth === "Bearer dh-token"
          ? jsonResponse(200, { data: [{ id: "org-1" }] })
          : jsonResponse(401, { errors: [{ message: "Unauthorized" }] });
      }

      // rencontres : "dh-token" échoue une première fois (throttling simulé),
      // puis réussit au deuxième essai. Tout autre jeton échoue toujours.
      if (auth === "Bearer dh-token") {
        dhAttemptsForRencontres += 1;
        if (dhAttemptsForRencontres >= 2) {
          return jsonResponse(200, { data: [{ id: "rencontre-1" }] });
        }
      }
      return jsonResponse(401, { errors: [{ message: "Unauthorized" }] });
    });

    const client = new FreshClient({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });
    await client.listItems("items/ffbbserver_organismes");
    const rencontres = await client.listItems("items/ffbbserver_rencontres");

    expect(rencontres).toEqual([{ id: "rencontre-1" }]);
    const rencontresAttempts = attempted.filter((a) => a.startsWith("rencontres:"));
    // Exactement 2 tentatives, toutes deux avec "dh-token" : la redécouverte
    // n'est jamais repartie sur "competitions-token" (ordre fixe) en premier.
    expect(rencontresAttempts).toEqual(["rencontres:Bearer dh-token", "rencontres:Bearer dh-token"]);
  });
});
