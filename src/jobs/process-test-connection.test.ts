import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FbiJobRow } from "../db/types.js";
import { FbiError } from "../integrations/fbi/errors.js";

const loginMock = vi.fn();
const closeSessionMock = vi.fn();

vi.mock("../integrations/fbi/browser-client.js", () => ({
  BrowserFbiClient: class FakeBrowserFbiClient {
    login = loginMock;
    closeSession = closeSessionMock;
  },
}));

const closeBrowserMock = vi.fn();
vi.mock("../integrations/fbi/browser-launcher.js", () => ({ launchServerlessBrowser: vi.fn(async () => ({ close: closeBrowserMock })) }));

const getFbiCredentialsMock = vi.fn();
vi.mock("../integrations/fbi/credentials-store.js", () => ({ getFbiCredentials: getFbiCredentialsMock }));

const { processTestConnectionJob } = await import("./process-test-connection.js");

function baseJob(overrides: Partial<FbiJobRow> = {}): FbiJobRow {
  return {
    id: "job-1",
    club_id: "club-1",
    match_id: null,
    type: "test_connection",
    status: "claimed",
    attempt_count: 1,
    max_attempts: 6,
    scheduled_at: "2026-01-01T00:00:00.000Z",
    claimed_at: "2026-01-01T00:00:00.000Z",
    claimed_by: "cron#0",
    started_at: null,
    finished_at: null,
    last_error: null,
    result: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeFakeSupabase(recorders: { jobUpdates: unknown[]; statusUpserts: unknown[] }) {
  return {
    from(table: string) {
      if (table === "fbi_jobs") {
        return { update: (patch: unknown) => ({ eq: () => { recorders.jobUpdates.push(patch); return Promise.resolve({ error: null }); } }) };
      }
      if (table === "fbi_integration_status") {
        return { upsert: (payload: unknown) => { recorders.statusUpserts.push(payload); return Promise.resolve({ error: null }); } };
      }
      throw new Error(`Table inattendue : ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processTestConnectionJob", () => {
  it("marque le job réussi et fbi_integration_status connecté sur un login réussi", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
    loginMock.mockResolvedValue({ context: {}, page: {} });

    const recorders = { jobUpdates: [], statusUpserts: [] };
    const supabase = makeFakeSupabase(recorders);

    await processTestConnectionJob(supabase, baseJob());

    expect(recorders.jobUpdates).toContainEqual(expect.objectContaining({ status: "succeeded" }));
    expect(recorders.statusUpserts).toContainEqual(expect.objectContaining({ last_test_success: true, last_login_success: true, last_error: null }));
    expect(closeSessionMock).toHaveBeenCalledOnce();
    expect(closeBrowserMock).toHaveBeenCalledOnce();
  });

  it("marque le job en échec et enregistre le message sur un login refusé", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "mauvais" });
    loginMock.mockRejectedValue(new FbiError("refusé", "LOGIN_FAILED"));

    const recorders = { jobUpdates: [], statusUpserts: [] };
    const supabase = makeFakeSupabase(recorders);

    await processTestConnectionJob(supabase, baseJob());

    expect(recorders.jobUpdates).toContainEqual(expect.objectContaining({ status: "failed" }));
    expect(recorders.statusUpserts).toContainEqual(expect.objectContaining({ last_test_success: false, last_login_success: false }));
  });

  it("échoue proprement quand aucun identifiant n'est enregistré, sans jamais appeler login", async () => {
    getFbiCredentialsMock.mockResolvedValue(null);

    const recorders = { jobUpdates: [], statusUpserts: [] };
    const supabase = makeFakeSupabase(recorders);

    await processTestConnectionJob(supabase, baseJob());

    expect(loginMock).not.toHaveBeenCalled();
    expect(recorders.jobUpdates).toContainEqual(expect.objectContaining({ status: "failed" }));
  });
});
