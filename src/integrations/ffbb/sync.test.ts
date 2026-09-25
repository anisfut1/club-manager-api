import { describe, expect, it } from "vitest";
import { reapOrphanedRunningSyncRuns, resolveTeamForEngagement } from "./sync.js";
import type { NormalizedCompetition, NormalizedTeamEngagement } from "./types.js";

interface FakeTeamRow {
  id: string;
  club_id: string;
  name: string;
  category: string | null;
  sexe: string | null;
  numero_equipe: string | null;
}

/** Fake minimal pour `teams` uniquement : `.eq()`/`.is()` cumulés (colonnes nullables), `.insert().select().single()`. */
function makeTeamsSupabase(existing: FakeTeamRow[]) {
  let counter = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = {
    from(table: string) {
      if (table !== "teams") throw new Error(`Table inattendue dans ce fake dédié : ${table}`);
      return {
        select: () => {
          const filters: { col: string; value: unknown }[] = [];
          const chain = {
            eq(col: string, value: unknown) {
              filters.push({ col, value });
              return chain;
            },
            is(col: string, value: null) {
              filters.push({ col, value });
              return chain;
            },
            maybeSingle: () => {
              const match = existing.find((row) => filters.every((f) => (row as unknown as Record<string, unknown>)[f.col] === f.value));
              return Promise.resolve({ data: match ?? null, error: null });
            },
          };
          return chain;
        },
        insert: (payload: Omit<FakeTeamRow, "id">) => ({
          select: () => ({
            single: () => {
              counter += 1;
              const row: FakeTeamRow = { id: `new-team-${counter}`, ...payload };
              existing.push(row);
              return Promise.resolve({ data: { id: row.id }, error: null });
            },
          }),
        }),
      };
    },
  };
  return supabase;
}

function competition(overrides: Partial<NormalizedCompetition> = {}): NormalizedCompetition {
  return {
    ffbbId: "comp-1",
    name: "U11 Masculin",
    code: null,
    sexe: "M",
    typeCompetition: null,
    categoryCode: "U11",
    categoryLabel: "U11",
    phaseCode: null,
    liveStat: false,
    emarqueV2: false,
    publicationInternet: true,
    season: "2026-2027",
    parentCompetitionFfbbId: null,
    raw: null,
    ...overrides,
  };
}

function engagement(overrides: Partial<NormalizedTeamEngagement> = {}): NormalizedTeamEngagement {
  return {
    ffbbId: "eng-1",
    name: "SPORT CLUB DE SETE BASKET",
    numeroEquipe: "1",
    competitionFfbbId: "comp-1",
    poolFfbbId: null,
    organismeFfbbId: "org-1",
    raw: null,
    ...overrides,
  };
}

/**
 * Régression du bug de fusion M/F constaté en production le 2026-09-25
 * (§ migration `20260925100000_teams_gender_split_and_licencie_team.sql`,
 * docs/TEAMS.md) : deux engagements de sexes différents partageant le même
 * numéro généraient auparavant le MÊME nom d'équipe ("U11 1") et
 * fusionnaient donc dans la même ligne `teams` (résolution par nom,
 * jamais par sexe). Corrigé : résolution par (catégorie, sexe, numéro).
 */
describe("resolveTeamForEngagement", () => {
  it("crée une équipe avec sa catégorie/sexe/numéro quand aucune n'existe déjà", async () => {
    const teams: FakeTeamRow[] = [];
    const supabase = makeTeamsSupabase(teams);

    const teamId = await resolveTeamForEngagement(supabase, "club-1", engagement(), competition());

    expect(teamId).toBe("new-team-1");
    expect(teams).toEqual([{ id: "new-team-1", club_id: "club-1", name: "U11 1", category: "U11", sexe: "M", numero_equipe: "1" }]);
  });

  it("réutilise une équipe existante avec la MÊME catégorie/sexe/numéro, jamais un doublon", async () => {
    const teams: FakeTeamRow[] = [{ id: "team-existing", club_id: "club-1", name: "U11 1", category: "U11", sexe: "M", numero_equipe: "1" }];
    const supabase = makeTeamsSupabase(teams);

    const teamId = await resolveTeamForEngagement(supabase, "club-1", engagement(), competition());

    expect(teamId).toBe("team-existing");
    expect(teams).toHaveLength(1);
  });

  it("RÉGRESSION : deux engagements de sexes différents partageant le même numéro résolvent vers DEUX équipes distinctes, jamais fusionnées", async () => {
    const teams: FakeTeamRow[] = [];
    const supabase = makeTeamsSupabase(teams);

    const maleTeamId = await resolveTeamForEngagement(supabase, "club-1", engagement({ ffbbId: "eng-m" }), competition({ sexe: "M" }));
    const femaleTeamId = await resolveTeamForEngagement(supabase, "club-1", engagement({ ffbbId: "eng-f" }), competition({ ffbbId: "comp-2", sexe: "F" }));

    expect(maleTeamId).not.toBe(femaleTeamId);
    expect(teams).toHaveLength(2);
    expect(teams.map((t) => t.sexe).sort()).toEqual(["F", "M"]);
  });

  it("un sexe non reconnu ('X', absent du modèle) n'est jamais assumé M ou F — traité comme null", async () => {
    const teams: FakeTeamRow[] = [];
    const supabase = makeTeamsSupabase(teams);

    await resolveTeamForEngagement(supabase, "club-1", engagement(), competition({ sexe: "X" }));

    expect(teams[0]?.sexe).toBeNull();
  });
});

/**
 * Un run "running" jamais clôturé (kill dur du processus avant la mise à
 * jour finale, voir sync.ts) doit être requalifié en "error" — sinon
 * /admin/sync affiche une synchronisation bloquée pour toujours (constaté
 * en production, voir docs/FFBB.md).
 */
describe("reapOrphanedRunningSyncRuns", () => {
  it("clôture en 'error' les sync_runs FFBB 'running' de CE club, jamais ceux d'un autre club/provider", async () => {
    const updates: { patch: Record<string, unknown>; filters: [string, unknown][] }[] = [];

    const supabase = {
      from(table: string) {
        expect(table).toBe("sync_runs");
        return {
          update: (patch: Record<string, unknown>) => {
            const filters: [string, unknown][] = [];
            const chain = {
              eq(col: string, value: unknown) {
                filters.push([col, value]);
                return chain;
              },
              then(onFulfilled: (value: { error: null }) => unknown) {
                updates.push({ patch, filters });
                return Promise.resolve({ error: null }).then(onFulfilled);
              },
            };
            return chain;
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await reapOrphanedRunningSyncRuns(supabase, "club-1");

    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch.status).toBe("error");
    expect(typeof updates[0]!.patch.finished_at).toBe("string");
    expect(updates[0]!.filters).toEqual([
      ["club_id", "club-1"],
      ["provider", "ffbb"],
      ["status", "running"],
    ]);
  });

  it("ne lève jamais si la mise à jour échoue (nettoyage best-effort, ne doit jamais bloquer la synchronisation)", async () => {
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: { message: "boom" } }),
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(reapOrphanedRunningSyncRuns(supabase, "club-1")).resolves.toBeUndefined();
  });
});
