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
    "demande salle.libelle/salle.adresse, pas salle.nom/salle.commune.libelle (mauvais noms de " +
      "champs à l'origine du 403 du 2026-09-22 — confirmé par le modèle du SDK tiers ffbb-data-client, voir docs/FFBB.md)",
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
      const fields = (new URL(requestedUrl!).searchParams.get("fields") ?? "").split(",");
      expect(fields).toContain("salle.id");
      expect(fields).toContain("salle.libelle");
      expect(fields).toContain("salle.adresse");
      expect(fields).not.toContain("salle.nom");
      expect(fields).not.toContain("salle.commune.libelle");
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
    expect(matches[0]!.venue).toEqual({ ffbbId: "4242", name: null, address: null, raw: 4242 });
  });

  it("normalise une salle étendue (libelle/adresse) vers name/address", async () => {
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
            salle: { id: "4242", libelle: "Gymnase Municipal", adresse: "12 rue du Stade, 34200 Sète" },
          },
        ],
      });
    });

    const provider = new FfbbPublicProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      candidateRetryDelayMs: 0,
    });
    const matches = await provider.listMatchesForOrganisme("org-1");

    expect(matches[0]!.venue?.name).toBe("Gymnase Municipal");
    expect(matches[0]!.venue?.address).toBe("12 rue du Stade, 34200 Sète");
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

describe("FfbbPublicProvider.listOrganismeLogos", () => {
  it("construit l'URL d'asset ({FFBB_API_BASE_URL}assets/{id}) à partir de logo.id", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      return jsonResponse(200, { data: [{ id: "org-2", logo: { id: "logo-abc" } }] });
    });

    const provider = new FfbbPublicProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      candidateRetryDelayMs: 0,
    });
    const logos = await provider.listOrganismeLogos(["org-2"]);

    expect(logos.get("org-2")).toBe("https://api.ffbb.app/assets/logo-abc");
  });

  it("renvoie null pour un organisme sans logo, sans planter", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      return jsonResponse(200, { data: [{ id: "org-2", logo: null }] });
    });

    const provider = new FfbbPublicProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      candidateRetryDelayMs: 0,
    });
    const logos = await provider.listOrganismeLogos(["org-2"]);

    expect(logos.get("org-2")).toBeNull();
  });

  it("ne fait aucun appel réseau pour une liste d'identifiants vide", async () => {
    const fetchImpl = vi.fn();
    const provider = new FfbbPublicProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });

    const logos = await provider.listOrganismeLogos([]);

    expect(logos.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("FfbbPublicProvider.fetchClubSnapshot", () => {
  it("attache opponentLogoUrl à chaque match à partir de listOrganismeLogos", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      if (href.includes("items/ffbbserver_organismes") && href.includes("code")) {
        return jsonResponse(200, { data: [{ id: "org-1", code: "OCC0034008", nom: "SC Sète" }] });
      }
      if (href.includes("items/ffbbserver_engagements")) {
        return jsonResponse(200, { data: [] });
      }
      if (href.includes("items/ffbbserver_rencontres")) {
        return jsonResponse(200, {
          data: [{ id: "match-1", idOrganismeEquipe1: "org-1", idOrganismeEquipe2: "org-2", nomEquipe2: "Adverse" }],
        });
      }
      if (href.includes("items/ffbbserver_competitions") || href.includes("items/ffbbserver_poules")) {
        return jsonResponse(200, { data: [] });
      }
      if (href.includes("items/ffbbserver_organismes") && href.includes("_in")) {
        return jsonResponse(200, { data: [{ id: "org-2", logo: { id: "logo-adverse" } }] });
      }
      return jsonResponse(200, { data: [] });
    });

    const provider = new FfbbPublicProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      candidateRetryDelayMs: 0,
      pageDelayMs: 0,
    });
    const snapshot = await provider.fetchClubSnapshot("OCC0034008");

    expect(snapshot.matches).toHaveLength(1);
    expect(snapshot.matches[0]!.opponentLogoUrl).toBe("https://api.ffbb.app/assets/logo-adverse");
  });
});

describe("FfbbPublicProvider.findOrganismeByCode", () => {
  it("construit logoUrl à partir de logo.id (demande explicite : logo DU club, pas seulement des adversaires)", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      return jsonResponse(200, { data: [{ id: "org-1", code: "OCC0034008", nom: "SC Sète", logo: { id: "logo-sete" } }] });
    });

    const provider = new FfbbPublicProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });
    const organisme = await provider.findOrganismeByCode("OCC0034008");

    expect(organisme.logoUrl).toBe("https://api.ffbb.app/assets/logo-sete");
  });

  it("logoUrl est null quand l'organisme n'a pas de logo", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("items/configuration")) {
        return jsonResponse(200, CONFIGURATION_BODY);
      }
      return jsonResponse(200, { data: [{ id: "org-1", code: "OCC0034008", nom: "SC Sète" }] });
    });

    const provider = new FfbbPublicProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, candidateRetryDelayMs: 0 });
    const organisme = await provider.findOrganismeByCode("OCC0034008");

    expect(organisme.logoUrl).toBeNull();
  });
});
