import { beforeEach, describe, expect, it } from "vitest";
import { enqueueEmarqueDiscoveryJobsForClub } from "./enqueue-emarque";

const CLUB_ID = "club-1";

interface FakeMatchCandidate {
  id: string;
  numero: string | null;
}

function makeFakeSupabase(options: {
  fbiStatus: { configured: boolean; auto_import_emarque: boolean } | null;
  candidates: FakeMatchCandidate[];
  /** Numéros de match pour lesquels l'insertion doit simuler une violation unique (déjà en file). */
  alreadyQueuedMatchIds?: string[];
  insertedRows: Array<{ club_id: string; match_id: string; type: string }>;
}) {
  const alreadyQueued = new Set(options.alreadyQueuedMatchIds ?? []);

  return {
    from(table: string) {
      if (table === "fbi_integration_status") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: options.fbiStatus, error: null }),
            }),
          }),
        };
      }
      if (table === "matches") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: () => Promise.resolve({ data: options.candidates, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "fbi_jobs") {
        return {
          insert: (row: { club_id: string; match_id: string; type: string }) => {
            if (alreadyQueued.has(row.match_id)) {
              return Promise.resolve({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });
            }
            options.insertedRows.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`Table inattendue dans le fake Supabase de test : ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {});

describe("enqueueEmarqueDiscoveryJobsForClub", () => {
  it("ne crée aucun job et ne fait aucune requête de matchs quand FBI n'est pas configuré (FBI facultatif)", async () => {
    const insertedRows: Array<{ club_id: string; match_id: string; type: string }> = [];
    const supabase = makeFakeSupabase({ fbiStatus: null, candidates: [], insertedRows });

    const result = await enqueueEmarqueDiscoveryJobsForClub(supabase, CLUB_ID);

    expect(result).toEqual({ candidatesExamined: 0, jobsCreated: 0, alreadyQueued: 0, skippedNotConfigured: true });
    expect(insertedRows).toHaveLength(0);
  });

  it("ne crée aucun job quand auto_import_emarque est désactivé même si FBI est configuré", async () => {
    const insertedRows: Array<{ club_id: string; match_id: string; type: string }> = [];
    const supabase = makeFakeSupabase({
      fbiStatus: { configured: true, auto_import_emarque: false },
      candidates: [{ id: "match-1", numero: "2813" }],
      insertedRows,
    });

    const result = await enqueueEmarqueDiscoveryJobsForClub(supabase, CLUB_ID);

    expect(result.skippedNotConfigured).toBe(true);
    expect(insertedRows).toHaveLength(0);
  });

  it("crée un job discover_emarque par match candidat ayant un numéro de rencontre", async () => {
    const insertedRows: Array<{ club_id: string; match_id: string; type: string }> = [];
    const supabase = makeFakeSupabase({
      fbiStatus: { configured: true, auto_import_emarque: true },
      candidates: [
        { id: "match-1", numero: "2813" },
        { id: "match-2", numero: "2814" },
      ],
      insertedRows,
    });

    const result = await enqueueEmarqueDiscoveryJobsForClub(supabase, CLUB_ID);

    expect(result).toEqual({ candidatesExamined: 2, jobsCreated: 2, alreadyQueued: 0, skippedNotConfigured: false });
    expect(insertedRows).toEqual([
      { club_id: CLUB_ID, match_id: "match-1", type: "discover_emarque" },
      { club_id: CLUB_ID, match_id: "match-2", type: "discover_emarque" },
    ]);
  });

  it("ignore les matchs sans numéro de rencontre (rien à chercher)", async () => {
    const insertedRows: Array<{ club_id: string; match_id: string; type: string }> = [];
    const supabase = makeFakeSupabase({
      fbiStatus: { configured: true, auto_import_emarque: true },
      candidates: [{ id: "match-1", numero: null }],
      insertedRows,
    });

    const result = await enqueueEmarqueDiscoveryJobsForClub(supabase, CLUB_ID);

    expect(result.candidatesExamined).toBe(0);
    expect(insertedRows).toHaveLength(0);
  });

  it("compte comme alreadyQueued (pas une erreur) un job déjà en attente pour ce match", async () => {
    const insertedRows: Array<{ club_id: string; match_id: string; type: string }> = [];
    const supabase = makeFakeSupabase({
      fbiStatus: { configured: true, auto_import_emarque: true },
      candidates: [{ id: "match-1", numero: "2813" }],
      alreadyQueuedMatchIds: ["match-1"],
      insertedRows,
    });

    const result = await enqueueEmarqueDiscoveryJobsForClub(supabase, CLUB_ID);

    expect(result).toEqual({ candidatesExamined: 1, jobsCreated: 0, alreadyQueued: 1, skippedNotConfigured: false });
  });

  it("crée quand même les jobs si FBI est configuré mais actuellement en erreur (le calendrier FFBB reste indépendant, §46)", async () => {
    const insertedRows: Array<{ club_id: string; match_id: string; type: string }> = [];
    const supabase = makeFakeSupabase({
      fbiStatus: { configured: true, auto_import_emarque: true },
      candidates: [{ id: "match-1", numero: "2813" }],
      insertedRows,
    });

    const result = await enqueueEmarqueDiscoveryJobsForClub(supabase, CLUB_ID);

    expect(result.jobsCreated).toBe(1);
  });
});
