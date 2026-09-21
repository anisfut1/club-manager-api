import { describe, expect, it } from "vitest";
import { claimNextJob } from "./claim";
import type { FbiJobRow } from "@/db/types";

function makeFakeSupabase(response: { data: FbiJobRow | null; error: { message: string } | null }) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  return {
    calls,
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return Promise.resolve(response);
    },
  };
}

const A_JOB: FbiJobRow = {
  id: "job-1",
  club_id: "club-1",
  match_id: "match-1",
  type: "discover_emarque",
  status: "claimed",
  attempt_count: 1,
  max_attempts: 6,
  scheduled_at: "2026-01-01T00:00:00.000Z",
  claimed_at: "2026-01-01T00:00:00.000Z",
  claimed_by: "worker-1#0",
  started_at: null,
  finished_at: null,
  last_error: null,
  result: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("claimNextJob", () => {
  it("appelle claim_next_fbi_job avec l'identifiant du worker et renvoie le job réclamé", async () => {
    const supabase = makeFakeSupabase({ data: A_JOB, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const job = await claimNextJob(supabase as any, "worker-1#0");

    expect(job).toEqual(A_JOB);
    expect(supabase.calls).toEqual([{ fn: "claim_next_fbi_job", args: { p_worker_id: "worker-1#0" } }]);
  });

  it("renvoie null quand la file est vide", async () => {
    const supabase = makeFakeSupabase({ data: null, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await claimNextJob(supabase as any, "worker-1#0")).toBeNull();
  });

  it("propage une erreur explicite si le RPC échoue", async () => {
    const supabase = makeFakeSupabase({ data: null, error: { message: "connexion DB perdue" } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(claimNextJob(supabase as any, "worker-1#0")).rejects.toThrow(/connexion DB perdue/);
  });
});
