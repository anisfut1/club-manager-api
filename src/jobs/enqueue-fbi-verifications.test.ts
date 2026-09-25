import { describe, expect, it } from "vitest";
import { enqueueFbiVerificationJobsForClub } from "./enqueue-fbi-verifications.js";

const CLUB_ID = "club-1";

function makeFakeSupabase(options: {
  fbiStatus: { configured: boolean } | null;
  /** Types de job pour lesquels l'insertion doit simuler une violation unique (déjà en file). */
  alreadyQueuedTypes?: string[];
  insertedRows: Array<{ club_id: string; type: string }>;
}) {
  const alreadyQueued = new Set(options.alreadyQueuedTypes ?? []);

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
      if (table === "fbi_jobs") {
        return {
          insert: (row: { club_id: string; type: string }) => {
            if (alreadyQueued.has(row.type)) {
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

describe("enqueueFbiVerificationJobsForClub (cron daily, voir docs/FBI.md)", () => {
  it("ne crée aucun job quand FBI n'est pas configuré pour ce club (FBI facultatif)", async () => {
    const insertedRows: Array<{ club_id: string; type: string }> = [];
    const supabase = makeFakeSupabase({ fbiStatus: null, insertedRows });

    const result = await enqueueFbiVerificationJobsForClub(supabase, CLUB_ID);

    expect(result).toEqual({
      reconcileScheduleCreated: false,
      reconcileScheduleAlreadyQueued: false,
      checkAllDerogationsCreated: false,
      checkAllDerogationsAlreadyQueued: false,
      skippedNotConfigured: true,
    });
    expect(insertedRows).toHaveLength(0);
  });

  it("empile UN job reconcile_schedule ET UN job check_all_derogations quand FBI est configuré", async () => {
    const insertedRows: Array<{ club_id: string; type: string }> = [];
    const supabase = makeFakeSupabase({ fbiStatus: { configured: true }, insertedRows });

    const result = await enqueueFbiVerificationJobsForClub(supabase, CLUB_ID);

    expect(result).toEqual({
      reconcileScheduleCreated: true,
      reconcileScheduleAlreadyQueued: false,
      checkAllDerogationsCreated: true,
      checkAllDerogationsAlreadyQueued: false,
      skippedNotConfigured: false,
    });
    expect(insertedRows).toEqual([
      { club_id: CLUB_ID, type: "reconcile_schedule" },
      { club_id: CLUB_ID, type: "check_all_derogations" },
    ]);
  });

  it("compte comme déjà en file (pas une erreur) un job encore en attente de la veille — idempotent d'un jour sur l'autre", async () => {
    const insertedRows: Array<{ club_id: string; type: string }> = [];
    const supabase = makeFakeSupabase({
      fbiStatus: { configured: true },
      alreadyQueuedTypes: ["reconcile_schedule", "check_all_derogations"],
      insertedRows,
    });

    const result = await enqueueFbiVerificationJobsForClub(supabase, CLUB_ID);

    expect(result).toEqual({
      reconcileScheduleCreated: false,
      reconcileScheduleAlreadyQueued: true,
      checkAllDerogationsCreated: false,
      checkAllDerogationsAlreadyQueued: true,
      skippedNotConfigured: false,
    });
    expect(insertedRows).toHaveLength(0);
  });
});
