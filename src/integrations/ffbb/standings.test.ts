import { describe, expect, it } from "vitest";
import { normalizeStandingRow } from "./public-provider.js";
import { syncPoolStandings } from "./sync.js";
import type { FfbbPublicProvider } from "./public-provider.js";
import type { NormalizedPoolStandings } from "./types.js";

describe("normalizeStandingRow — classement FFBB (ffbbserver_poules.classements)", () => {
  it("normalise une ligne complète (relations étendues, nombres en chaîne)", () => {
    const row = normalizeStandingRow({
      idEngagement: { id: 12345, nom: "SETE BASKET - 1" },
      organisme: { id: 77, nom: "SC SETE BASKET", logo: { id: "abc" } },
      position: "2",
      points: 11,
      matchJoues: 6,
      gagnes: 5,
      perdus: 1,
      nuls: null,
      nombreForfaits: 0,
      paniersMarques: 412,
      paniersEncaisses: 350,
      difference: 62,
      horsClassement: false,
    });
    expect(row).toEqual({
      engagementFfbbId: "12345",
      teamName: "SETE BASKET - 1",
      organismeFfbbId: "77",
      logoUrl: "https://api.ffbb.app/assets/abc",
      position: 2,
      points: 11,
      played: 6,
      won: 5,
      lost: 1,
      draws: null,
      forfeits: 0,
      pointsFor: 412,
      pointsAgainst: 350,
      difference: 62,
      outOfRanking: false,
    });
  });

  it("tolère des relations non étendues (id brut) et des champs absents", () => {
    const row = normalizeStandingRow({ idEngagement: 9, organisme: 3 });
    expect(row.engagementFfbbId).toBe("9");
    expect(row.organismeFfbbId).toBe("3");
    expect(row.teamName).toBe("Équipe");
    expect(row.points).toBeNull();
    expect(row.logoUrl).toBeNull();
  });
});

function fakeSupabase() {
  const updates: { patch: Record<string, unknown>; id: unknown }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = {
    from(table: string) {
      if (table !== "pools") throw new Error(`Table inattendue : ${table}`);
      return { update: (patch: Record<string, unknown>) => ({ eq: (_c: string, id: unknown) => (updates.push({ patch, id }), Promise.resolve({ error: null })) }) };
    },
  };
  return { supabase, updates };
}

describe("syncPoolStandings — étape best-effort de la synchronisation FFBB", () => {
  it("écrit le classement de chaque poule connue, ignore les poules inconnues ou vides", async () => {
    const { supabase, updates } = fakeSupabase();
    const standings: NormalizedPoolStandings[] = [
      { poolFfbbId: "p1", rows: [normalizeStandingRow({ idEngagement: { id: 1, nom: "A" }, position: 1 })] },
      { poolFfbbId: "p2", rows: [] },
      { poolFfbbId: "inconnue", rows: [normalizeStandingRow({ position: 1 })] },
    ];
    const provider = { listPoolStandings: async () => standings } as unknown as FfbbPublicProvider;

    await syncPoolStandings(supabase, provider, new Map([["p1", "pool-uuid-1"], ["p2", "pool-uuid-2"]]), "club");

    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("pool-uuid-1");
    expect(updates[0]!.patch.standings).toEqual(standings[0]!.rows);
    expect(updates[0]!.patch.standings_updated_at).toEqual(expect.any(String));
  });

  it("ne lève jamais si l'API FFBB refuse les champs du classement (les matchs restent synchronisés)", async () => {
    const { supabase, updates } = fakeSupabase();
    const provider = {
      listPoolStandings: async () => {
        throw new Error("403 FORBIDDEN");
      },
    } as unknown as FfbbPublicProvider;

    await expect(syncPoolStandings(supabase, provider, new Map([["p1", "pool-uuid-1"]]), "club")).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });
});
