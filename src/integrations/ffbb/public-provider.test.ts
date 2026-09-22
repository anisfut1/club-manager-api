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

  it(
    "filtre sur une fenêtre de date récente plutôt que de paginer tout l'historique du club " +
      "(FUNCTION_INVOCATION_TIMEOUT constaté en production le 2026-09-22 sans ce filtre — voir docs/FFBB.md)",
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

      const filter = JSON.parse(new URL(requestedUrl!).searchParams.get("filter") ?? "{}");
      const dateClause = filter._and?.find((clause: unknown) => (clause as { date_rencontre?: unknown }).date_rencontre);
      expect(dateClause?.date_rencontre?._gte).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Aucune borne supérieure : les rencontres futures (calendrier de la
      // saison en cours) doivent toutes remonter, jamais tronquées par date.
      expect(dateClause?.date_rencontre?._lte).toBeUndefined();
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

  it(
    "pagine au-delà de la première page (500 rencontres tronquées avant la saison en cours, " +
      "constaté en production le 2026-09-22 — voir docs/FFBB.md)",
    async () => {
      // Page 1 pleine (taille de page par défaut de listAllItems = 200) suivie
      // d'une page 2 plus petite : si listMatchesForOrganisme utilisait encore
      // listItems (une seule page), seuls les 200 premiers résultats
      // reviendraient, jamais le match le plus récent de la page 2.
      const page1 = Array.from({ length: 200 }, (_, i) => ({
        id: `old-${i}`,
        idOrganismeEquipe1: "org-1",
        idOrganismeEquipe2: "org-2",
        date_rencontre: "2023-09-01T00:00:00",
      }));
      const page2 = [
        {
          id: "recent-current-season",
          idOrganismeEquipe1: "org-1",
          idOrganismeEquipe2: "org-2",
          date_rencontre: "2026-10-01T00:00:00",
        },
      ];

      const fetchImpl = vi.fn(async (url: string | URL) => {
        const href = url.toString();
        if (href.includes("items/configuration")) {
          return jsonResponse(200, CONFIGURATION_BODY);
        }
        const offset = Number(new URL(href).searchParams.get("offset") ?? "0");
        return jsonResponse(200, { data: offset === 0 ? page1 : page2 });
      });

      const provider = new FfbbPublicProvider({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        candidateRetryDelayMs: 0,
        pageDelayMs: 0,
      });
      const matches = await provider.listMatchesForOrganisme("org-1");

      expect(matches).toHaveLength(201);
      expect(matches.some((m) => m.ffbbId === "recent-current-season")).toBe(true);
    },
  );
});

describe("FfbbPublicProvider.listCompetitions", () => {
  it(
    "convertit publicationInternet en vrai booléen même reçu comme chaîne (\"AFF\" observé en " +
      "production le 2026-09-22, colonne Postgres booléenne — voir docs/FFBB.md)",
    async () => {
      const fetchImpl = vi.fn(async (url: string | URL) => {
        const href = url.toString();
        if (href.includes("items/configuration")) {
          return jsonResponse(200, CONFIGURATION_BODY);
        }
        return jsonResponse(200, {
          data: [{ id: "comp-1", nom: "Régionale 1", liveStat: false, emarqueV2: true, publicationInternet: "AFF" }],
        });
      });

      const provider = new FfbbPublicProvider({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        candidateRetryDelayMs: 0,
      });
      const competitions = await provider.listCompetitions(["comp-1"]);

      expect(competitions).toHaveLength(1);
      expect(competitions[0]!.publicationInternet).toBe(true);
      expect(typeof competitions[0]!.publicationInternet).toBe("boolean");
    },
  );

  it("retombe sur true quand publicationInternet est absent", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      return jsonResponse(200, { data: [{ id: "comp-1", nom: "Régionale 1" }] });
    });

    const provider = new FfbbPublicProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      candidateRetryDelayMs: 0,
    });
    const competitions = await provider.listCompetitions(["comp-1"]);

    expect(competitions[0]!.publicationInternet).toBe(true);
  });
});
