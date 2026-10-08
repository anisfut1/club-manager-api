import { describe, expect, it } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState } from "../test-support/fake-club-supabase.js";
import { buildFbiLicenceXlsx, licenceRow } from "../test-support/fbi-licence-xlsx.js";
import { processImportLicencesJob } from "./process-import-licences.js";
import type { FbiJobRow } from "../db/types.js";
import type { SharedFbiSession } from "./shared-session.js";
import type { DbClient } from "../db/client.js";

const CLUB_ID = "aaaaaaaa-0000-0000-0000-000000000000";

function job(overrides: Partial<FbiJobRow> = {}): FbiJobRow {
  return { id: "fbi-job-1", club_id: CLUB_ID, match_id: null, type: "import_licences", status: "claimed", attempt_count: 1, max_attempts: 5, scheduled_at: new Date().toISOString(), created_at: new Date().toISOString(), ...overrides } as FbiJobRow;
}

function sharedSession(download: () => Promise<{ buffer: Buffer; fileName: string }>): SharedFbiSession {
  return { client: { downloadValidatedLicencesExport: download } as unknown as SharedFbiSession["client"], session: {} as SharedFbiSession["session"] };
}

describe("processImportLicencesJob — export FBI des licences validées → liste des joueurs", () => {
  it("dans la session du worker : télécharge, lit, met à jour, et garde les compteurs (jamais le fichier)", async () => {
    const state = makeFakeClubSupabaseState({ fbiJobs: [{ id: "fbi-job-1", club_id: CLUB_ID, match_id: null, type: "import_licences", status: "claimed" } as never] });
    const db = buildFakeClubSupabase(state) as unknown as DbClient;
    const xlsx = Buffer.from(await buildFbiLicenceXlsx([licenceRow({ id: "1", numero: "BC1", nom: "A", prenom: "B" }), licenceRow({ id: "2", numero: "BC2", nom: "C", prenom: "D" })]));

    const ok = await processImportLicencesJob(db, job(), sharedSession(async () => ({ buffer: xlsx, fileName: "rechercherLicence.xlsx" })));

    expect(ok).toBe(true);
    expect(state.licencies.filter((l) => l.club_id === CLUB_ID)).toHaveLength(2);
    expect(state.fbiJobs[0]).toMatchObject({ status: "succeeded", result: expect.objectContaining({ total: 2, inserted: 2, skippedLines: 0 }) });
    expect(state.licenceImportRuns).toEqual([expect.objectContaining({ source: "fbi", inserted: 2, created_by: null })]);
  });

  it("FBI a changé son export (fichier méconnaissable) : échec direct, sans nouvel essai, aucun joueur touché", async () => {
    const state = makeFakeClubSupabaseState({ fbiJobs: [{ id: "fbi-job-1", club_id: CLUB_ID, match_id: null, type: "import_licences", status: "claimed" } as never] });
    const db = buildFakeClubSupabase(state) as unknown as DbClient;
    const ok = await processImportLicencesJob(db, job(), sharedSession(async () => ({ buffer: Buffer.from("<html>erreur</html>"), fileName: "x.xls" })));
    expect(ok).toBe(false);
    expect(state.fbiJobs[0]).toMatchObject({ status: "failed" });
    expect(state.licencies).toHaveLength(0);
  });

  it("erreur FBI passagère : nouvel essai planifié", async () => {
    const state = makeFakeClubSupabaseState({ fbiJobs: [{ id: "fbi-job-1", club_id: CLUB_ID, match_id: null, type: "import_licences", status: "claimed" } as never] });
    const db = buildFakeClubSupabase(state) as unknown as DbClient;
    const ok = await processImportLicencesJob(db, job(), sharedSession(async () => Promise.reject(new Error("timeout"))));
    expect(ok).toBe(false);
    expect(state.fbiJobs[0]).toMatchObject({ status: "pending", last_error: "timeout" });
  });
});
