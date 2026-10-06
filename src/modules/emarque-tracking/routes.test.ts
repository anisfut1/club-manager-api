import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeMatchRow } from "../../test-support/fake-club-supabase.js";
import { describeLastCheck } from "./routes.js";

let state: FakeClubSupabaseState;
let currentUserId = "user-admin";

vi.mock("../../auth/jwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/jwt.js")>();
  return { ...actual, verifyAccessToken: vi.fn(async () => ({ id: currentUserId, email: `${currentUserId}@example.test` })) };
});

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

const CLUB_A = {
  id: "aaaaaaaa-0000-0000-0000-000000000000",
  slug: "club-a",
  name: "Club A Basket",
  short_name: null,
  logo_url: null,
  accent_color: null,
  timezone: "Europe/Paris",
  status: "active" as const,
  ffbb_club_id: "AAA0000001",
  ffbb_enabled: true,
  ffbb_next_sync_at: null,
};

const recent = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();

function playedMatch(id: string, emarqueStatus: string, overrides: Partial<FakeMatchRow> = {}): FakeMatchRow {
  return {
    id,
    club_id: CLUB_A.id,
    numero: id,
    journee: null,
    match_datetime: recent(5),
    is_home: true,
    opponent_name: "ADVERSAIRE",
    venue_raw_label: null,
    score_home: 52,
    score_away: 53,
    status: "played",
    emarque_status: emarqueStatus,
    team_id: null,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}/emarque-tracking${path}`, { ...init, headers: { Authorization: "Bearer test", ...(init.headers ?? {}) } });
}

beforeEach(() => {
  currentUserId = "user-admin";
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }],
    memberships: [
      { id: "membership-admin", club_id: CLUB_A.id, user_id: "user-admin", status: "active" },
      { id: "membership-plain", club_id: CLUB_A.id, user_id: "user-plain", status: "active" },
    ],
    roles: [{ membership_id: "membership-admin", role: "club_admin" }],
    matches: [
      playedMatch("waiting", "waiting_for_emarque"),
      playedMatch("published", "imported"),
      playedMatch("review", "needs_review"),
      { ...playedMatch("upcoming", "not_applicable"), status: "scheduled" },
    ],
    emarqueImports: [
      {
        id: "imp-review",
        club_id: CLUB_A.id,
        match_id: "review",
        status: "needs_review",
        source: "fbi",
        parser_version: "2026.10.2",
        quality_warnings: [
          { code: "PLAYER_POINTS_TOTAL_MISMATCH", message: "Équipe extérieur : total des points des joueurs 50 différent du score officiel 53.", severity: "error" },
          { code: "PLAYER_LICENSE_MISSING", message: "Licence non lue", severity: "warning" },
        ],
        discovered_at: recent(4),
        downloaded_at: recent(4),
        imported_at: recent(4),
        last_error: null,
        attempt_count: 1,
        next_attempt_at: null,
        created_at: recent(4),
      },
    ],
    fbiJobs: [
      {
        id: "job-waiting",
        club_id: CLUB_A.id,
        match_id: "waiting",
        type: "discover_emarque",
        status: "pending",
        scheduled_at: "2026-10-06T10:15:00.000Z",
        claimed_at: "2026-10-06T10:00:00.000Z",
        last_error: "[info, pas une erreur] Page confirmée pour la rencontre waiting mais aucun document retenu après filtrage.",
        created_at: recent(5),
      },
    ],
  });
});

describe("GET /v1/clubs/:clubId/emarque-tracking", () => {
  it("un état clair par match JOUÉ : prochain essai prévu, résultat du dernier essai en clair, raisons de non-publication", async () => {
    const res = await request("");
    expect(res.status).toBe(200);
    const { matches } = await res.json();

    expect(matches.map((m: { matchId: string }) => m.matchId).sort()).toEqual(["published", "review", "waiting"]);
    const byId = Object.fromEntries(matches.map((m: { matchId: string }) => [m.matchId, m]));
    expect(byId.waiting).toMatchObject({ state: "waiting", nextCheckAt: "2026-10-06T10:15:00.000Z", lastCheckResult: "Feuille pas encore publiée sur FBI" });
    expect(byId.published).toMatchObject({ state: "published", problems: [] });
    expect(byId.review).toMatchObject({ state: "needs_review", problems: ["Équipe extérieur : total des points des joueurs 50 différent du score officiel 53."] });
  });

  it("réservé à l'admin du club", async () => {
    currentUserId = "user-plain";
    const res = await request("");
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/clubs/:clubId/emarque-tracking/:matchId/relaunch", () => {
  it("relance immédiate + nouvelle fenêtre de 7 jours (window_start) sur le job en attente", async () => {
    const res = await request("/waiting/relaunch", { method: "POST" });
    expect(res.status).toBe(202);
    const job = state.fbiJobs.find((j) => j.id === "job-waiting")!;
    expect(job.window_start).toBeTruthy();
    expect(new Date(job.scheduled_at!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("crée le job s'il n'y en a pas, et repasse le match en attente", async () => {
    const res = await request("/review/relaunch", { method: "POST" });
    expect(res.status).toBe(202);
    const job = state.fbiJobs.find((j) => j.match_id === "review");
    expect(job).toMatchObject({ type: "discover_emarque", status: "pending" });
    expect(job?.window_start).toBeTruthy();
    expect(state.matches.find((m) => m.id === "review")?.emarque_status).toBe("waiting_for_emarque");
  });

  it("refuse un match non joué", async () => {
    const res = await request("/upcoming/relaunch", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("describeLastCheck — jamais le message technique brut", () => {
  it("classe les messages stockés en phrases claires", () => {
    expect(describeLastCheck(null, "succeeded")).toBe("Feuille récupérée sur FBI");
    expect(describeLastCheck("Page de connexion FBI injoignable", "pending")).toContain("FBI injoignable");
    expect(describeLastCheck("Pas de feuille e-Marque récupérée sur FBI 7 jours après le match — ...", "failed")).toContain("7 jours");
    expect(describeLastCheck("TypeError: x is undefined at /var/task/...", "pending")).toBe("Erreur technique au dernier essai — nouvel essai au prochain créneau");
  });
});
