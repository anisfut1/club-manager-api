import { beforeEach, describe, expect, it, vi } from "vitest";
import { processJobBatch } from "./process-batch.js";
import type { FbiJobRow } from "../db/types.js";

const { mockProcessTestConnectionJob } = vi.hoisted(() => ({ mockProcessTestConnectionJob: vi.fn() }));
vi.mock("./process-test-connection.js", () => ({ processTestConnectionJob: mockProcessTestConnectionJob }));

const { mockProcessDiscoverEmarqueJob } = vi.hoisted(() => ({ mockProcessDiscoverEmarqueJob: vi.fn() }));
vi.mock("./process-discover-emarque.js", () => ({ processDiscoverEmarqueJob: mockProcessDiscoverEmarqueJob }));

function makeJob(overrides: Partial<FbiJobRow> = {}): FbiJobRow {
  return {
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
    ...overrides,
  };
}

function makeFakeSupabase() {
  return {
    from(_table: string) {
      return {
        update: (_patch: unknown) => ({ eq: (_col: string, _value: string) => Promise.resolve({ error: null }) }),
      };
    },
  };
}

beforeEach(() => {
  mockProcessTestConnectionJob.mockReset();
  mockProcessDiscoverEmarqueJob.mockReset();
});

describe("processJobBatch", () => {
  it("réclame jusqu'à batchSize jobs et s'arrête dès que la file est vide", async () => {
    const jobs = [makeJob({ id: "job-1" }), makeJob({ id: "job-2" })];
    const claimJob = vi.fn(() => Promise.resolve(jobs.shift() ?? null));
    mockProcessDiscoverEmarqueJob.mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processJobBatch(makeFakeSupabase() as any, 5, claimJob);

    expect(result).toEqual({ claimed: 2, succeeded: 2, failed: 0 });
    expect(claimJob).toHaveBeenCalledTimes(3); // 2 jobs + 1 appel qui renvoie null
    expect(mockProcessDiscoverEmarqueJob).toHaveBeenCalledTimes(2);
  });

  it("ne réclame jamais plus que batchSize jobs, même si la file en contient davantage", async () => {
    const claimJob = vi.fn(() => Promise.resolve(makeJob()));
    mockProcessDiscoverEmarqueJob.mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processJobBatch(makeFakeSupabase() as any, 3, claimJob);

    expect(result).toEqual({ claimed: 3, succeeded: 3, failed: 0 });
    expect(claimJob).toHaveBeenCalledTimes(3);
  });

  it("dispatche selon job.type : test_connection vs discover_emarque", async () => {
    const jobs = [makeJob({ id: "job-1", type: "test_connection" }), makeJob({ id: "job-2", type: "discover_emarque" })];
    const claimJob = vi.fn(() => Promise.resolve(jobs.shift() ?? null));
    mockProcessTestConnectionJob.mockResolvedValue(undefined);
    mockProcessDiscoverEmarqueJob.mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processJobBatch(makeFakeSupabase() as any, 5, claimJob);

    expect(mockProcessTestConnectionJob).toHaveBeenCalledTimes(1);
    expect(mockProcessDiscoverEmarqueJob).toHaveBeenCalledTimes(1);
  });

  it("compte un job en échec sans interrompre le traitement du lot", async () => {
    const jobs = [makeJob({ id: "job-1" }), makeJob({ id: "job-2" })];
    const claimJob = vi.fn(() => Promise.resolve(jobs.shift() ?? null));
    mockProcessDiscoverEmarqueJob.mockRejectedValueOnce(new Error("panne simulée")).mockResolvedValueOnce(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processJobBatch(makeFakeSupabase() as any, 5, claimJob);

    expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 1 });
  });

  it("renvoie claimed=0 immédiatement quand la file est vide", async () => {
    const claimJob = vi.fn(() => Promise.resolve(null));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processJobBatch(makeFakeSupabase() as any, 5, claimJob);

    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(claimJob).toHaveBeenCalledTimes(1);
  });
});
