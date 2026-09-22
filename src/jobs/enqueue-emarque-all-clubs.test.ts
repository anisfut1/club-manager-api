import { beforeEach, describe, expect, it } from "vitest";
import { enqueueEmarqueDiscoveryJobsForAllClubs } from "./enqueue-emarque.js";

interface FakeState {
  activeClubIds: string[];
  fbiStatusByClub: Record<string, { configured: boolean; auto_import_emarque: boolean } | undefined>;
  candidatesByClub: Record<string, Array<{ id: string; numero: string | null }>>;
  insertedJobs: Array<{ club_id: string; match_id: string }>;
}

/**
 * Fake Supabase pour l'ORCHESTRATION multi-club de l'empilement de jobs
 * (sélection des clubs actifs, isolation des données par club) — la
 * logique par-club elle-même est déjà couverte par discover-emarque.test.ts.
 * Plus de verrou ici (§ commentaire de enqueueEmarqueDiscoveryJobsForClub) :
 * empiler des lignes fbi_jobs est une opération courte et idempotente.
 */
function buildFakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      if (table === "clubs") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: state.activeClubIds.map((id) => ({ id })), error: null }),
          }),
        };
      }
      if (table === "fbi_integration_status") {
        return {
          select: () => ({
            eq: (_col: string, clubId: string) => ({
              maybeSingle: () => Promise.resolve({ data: state.fbiStatusByClub[clubId] ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === "matches") {
        return {
          select: () => ({
            eq: (_col: string, clubId: string) => ({
              eq: () => ({
                in: () => Promise.resolve({ data: state.candidatesByClub[clubId] ?? [], error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "fbi_jobs") {
        return {
          insert: (row: { club_id: string; match_id: string }) => {
            state.insertedJobs.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`Table inattendue : ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {});

describe("enqueueEmarqueDiscoveryJobsForAllClubs", () => {
  it("traite chaque club actif indépendamment, sans mélanger les candidats d'un club à l'autre", async () => {
    const state: FakeState = {
      activeClubIds: ["club-a", "club-b"],
      fbiStatusByClub: {
        "club-a": { configured: true, auto_import_emarque: true },
        "club-b": { configured: true, auto_import_emarque: true },
      },
      candidatesByClub: {
        "club-a": [{ id: "match-a1", numero: "1001" }],
        "club-b": [{ id: "match-b1", numero: "2002" }],
      },
      insertedJobs: [],
    };
    const supabase = buildFakeSupabase(state);

    const result = await enqueueEmarqueDiscoveryJobsForAllClubs(supabase);

    expect(result.clubsProcessed).toBe(2);
    expect(result.perClub["club-a"]).toMatchObject({ jobsCreated: 1 });
    expect(result.perClub["club-b"]).toMatchObject({ jobsCreated: 1 });
    expect(state.insertedJobs).toEqual([
      { club_id: "club-a", match_id: "match-a1", type: "discover_emarque" },
      { club_id: "club-b", match_id: "match-b1", type: "discover_emarque" },
    ]);
  });

  it("ignore un club sans FBI configuré sans affecter les autres (FBI facultatif, §46 Club A)", async () => {
    const state: FakeState = {
      activeClubIds: ["club-a", "club-b"],
      fbiStatusByClub: {
        "club-a": undefined, // pas de FBI du tout
        "club-b": { configured: true, auto_import_emarque: true },
      },
      candidatesByClub: {
        "club-a": [{ id: "match-a1", numero: "1001" }],
        "club-b": [{ id: "match-b1", numero: "2002" }],
      },
      insertedJobs: [],
    };
    const supabase = buildFakeSupabase(state);

    const result = await enqueueEmarqueDiscoveryJobsForAllClubs(supabase);

    expect(result.perClub["club-a"]).toMatchObject({ skippedNotConfigured: true, jobsCreated: 0 });
    expect(result.perClub["club-b"]).toMatchObject({ jobsCreated: 1 });
    expect(state.insertedJobs).toEqual([{ club_id: "club-b", match_id: "match-b1", type: "discover_emarque" }]);
  });

  it("n'interroge que les clubs actifs (jamais un club suspendu)", async () => {
    const state: FakeState = {
      activeClubIds: ["club-a"],
      fbiStatusByClub: { "club-a": { configured: true, auto_import_emarque: true } },
      candidatesByClub: { "club-a": [] },
      insertedJobs: [],
    };
    const supabase = buildFakeSupabase(state);

    const result = await enqueueEmarqueDiscoveryJobsForAllClubs(supabase);

    expect(result.clubsProcessed).toBe(1);
    expect(result.perClub["club-b"]).toBeUndefined();
  });

  it("ne fait rien si aucun club n'est actif", async () => {
    const state: FakeState = { activeClubIds: [], fbiStatusByClub: {}, candidatesByClub: {}, insertedJobs: [] };
    const supabase = buildFakeSupabase(state);

    const result = await enqueueEmarqueDiscoveryJobsForAllClubs(supabase);

    expect(result).toEqual({ clubsProcessed: 0, perClub: {} });
  });
});
