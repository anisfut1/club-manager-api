import { describe, expect, it, vi } from "vitest";
import { FfbbPublicProvider } from "./public-provider.js";

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

describe("FfbbPublicProvider.listMatchesForOrganisme", () => {
  it(
    "ne demande jamais les champs imbriqués de la relation salle (403 FORBIDDEN confirmé en " +
      "production le 2026-09-22, voir docs/FFBB.md)",
    async () => {
      let requestedUrl: string | undefined;
      const fetchImpl = vi.fn(async (url: string | URL) => {
        const href = url.toString();
        if (href.includes("items/configuration")) {
          return jsonResponse(200, CONFIGURATION_BODY);
        }
        requestedUrl = href;
        return jsonResponse(200, { data: [] });
      });

      const provider = new FfbbPublicProvider({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        candidateRetryDelayMs: 0,
      });
      await provider.listMatchesForOrganisme("org-1");

      expect(requestedUrl).toBeDefined();
      const fields = new URL(requestedUrl!).searchParams.get("fields") ?? "";
      // Le rôle public FFBB renvoie 403 sur TOUTE la requête rencontres dès que
      // la relation "salle" est étendue (nom, commune.libelle...) — seul le
      // champ plat "salle" (FK brute) est autorisé.
      expect(fields).not.toContain("salle.nom");
      expect(fields).not.toContain("salle.commune");
      expect(fields).not.toContain("salle.id");
      expect(fields.split(",")).toContain("salle");
    },
  );

  it("normalise une salle renvoyée comme identifiant brut (FK non étendue) sans planter", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      return jsonResponse(200, {
        data: [
          {
            id: "match-1",
            idOrganismeEquipe1: "org-1",
            idOrganismeEquipe2: "org-2",
            nomEquipe2: "BC Adverse",
            salle: 4242,
          },
        ],
      });
    });

    const provider = new FfbbPublicProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      candidateRetryDelayMs: 0,
    });
    const matches = await provider.listMatchesForOrganisme("org-1");

    expect(matches).toHaveLength(1);
    expect(matches[0]!.venue).toEqual({ ffbbId: "4242", name: null, commune: null, raw: 4242 });
  });
});
