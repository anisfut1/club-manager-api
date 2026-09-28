import { describe, expect, it } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeFbiJobRow } from "../../test-support/fake-club-supabase.js";
import { reclaimStaleReconcileScheduleJob } from "./fbi-session-lock.js";

const CLUB_ID = "club-a";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function jobsFor(state: ReturnType<typeof makeFakeClubSupabaseState>): FakeFbiJobRow[] {
  return state.fbiJobs.filter((j) => j.club_id === CLUB_ID);
}

/**
 * Régression du bug constaté en production le 2026-09-28 : un job
 * `reconcile_schedule` resté `pending` (jamais réclamé par aucun worker)
 * bloquait `POST .../fbi/reconcile-schedule` indéfiniment via la contrainte
 * `fbi_jobs_unique_pending_reconcile_schedule`, contrairement au cas
 * `claimed`/`running` déjà couvert par `assertNoActiveFbiJob`/
 * `claim_next_fbi_job(_for_club)` (fenêtre de fraîcheur de 10 min).
 */
describe("reclaimStaleReconcileScheduleJob", () => {
  it("marque failed un job pending resté bloqué au-delà de 10 minutes", async () => {
    const state = makeFakeClubSupabaseState({
      fbiJobs: [{ id: "job-1", club_id: CLUB_ID, match_id: null, type: "reconcile_schedule", status: "pending", scheduled_at: minutesAgo(15) }],
    });
    const supabase = buildFakeClubSupabase(state);

    await reclaimStaleReconcileScheduleJob(supabase, CLUB_ID);

    expect(jobsFor(state)[0].status).toBe("failed");
    expect(jobsFor(state)[0].last_error).toMatch(/récupéré automatiquement/);
  });

  it("ne touche pas un job pending encore frais (< 10 minutes)", async () => {
    const state = makeFakeClubSupabaseState({
      fbiJobs: [{ id: "job-1", club_id: CLUB_ID, match_id: null, type: "reconcile_schedule", status: "pending", scheduled_at: minutesAgo(2) }],
    });
    const supabase = buildFakeClubSupabase(state);

    await reclaimStaleReconcileScheduleJob(supabase, CLUB_ID);

    expect(jobsFor(state)[0].status).toBe("pending");
  });

  it("marque failed un job claimed/running resté bloqué au-delà de 10 minutes (même seuil que assertNoActiveFbiJob)", async () => {
    const state = makeFakeClubSupabaseState({
      fbiJobs: [{ id: "job-1", club_id: CLUB_ID, match_id: null, type: "reconcile_schedule", status: "running", scheduled_at: minutesAgo(20), claimed_at: minutesAgo(18) }],
    });
    const supabase = buildFakeClubSupabase(state);

    await reclaimStaleReconcileScheduleJob(supabase, CLUB_ID);

    expect(jobsFor(state)[0].status).toBe("failed");
  });

  it("ne touche pas un job claimed/running encore frais (< 10 minutes)", async () => {
    const state = makeFakeClubSupabaseState({
      fbiJobs: [{ id: "job-1", club_id: CLUB_ID, match_id: null, type: "reconcile_schedule", status: "claimed", scheduled_at: minutesAgo(3), claimed_at: minutesAgo(1) }],
    });
    const supabase = buildFakeClubSupabase(state);

    await reclaimStaleReconcileScheduleJob(supabase, CLUB_ID);

    expect(jobsFor(state)[0].status).toBe("claimed");
  });

  it("ne touche jamais un job d'un autre club ou d'un autre type", async () => {
    const state = makeFakeClubSupabaseState({
      fbiJobs: [
        { id: "job-other-club", club_id: "club-b", match_id: null, type: "reconcile_schedule", status: "pending", scheduled_at: minutesAgo(30) },
        { id: "job-other-type", club_id: CLUB_ID, match_id: null, type: "check_all_derogations", status: "pending", scheduled_at: minutesAgo(30) },
      ],
    });
    const supabase = buildFakeClubSupabase(state);

    await reclaimStaleReconcileScheduleJob(supabase, CLUB_ID);

    expect(state.fbiJobs.every((j) => j.status === "pending")).toBe(true);
  });

  it("ne touche jamais un job déjà terminé (succeeded/failed)", async () => {
    const state = makeFakeClubSupabaseState({
      fbiJobs: [{ id: "job-1", club_id: CLUB_ID, match_id: null, type: "reconcile_schedule", status: "succeeded", scheduled_at: minutesAgo(60) }],
    });
    const supabase = buildFakeClubSupabase(state);

    await reclaimStaleReconcileScheduleJob(supabase, CLUB_ID);

    expect(jobsFor(state)[0].status).toBe("succeeded");
  });
});
