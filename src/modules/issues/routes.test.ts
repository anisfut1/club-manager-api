import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";

let state: FakeClubSupabaseState;
const currentUserId = "user-a";

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

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs${path}`, { ...init, headers: { authorization: "Bearer test-jwt", "content-type": "application/json", ...init.headers } });
}

beforeEach(() => {
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }],
    memberships: [{ id: "membership-a1", club_id: CLUB_A.id, user_id: "user-a", status: "active" }],
    roles: [{ membership_id: "membership-a1", role: "club_admin" }],
  });
});

describe("GET /:clubId/issues", () => {
  it("renvoie les anomalies e-Marque (emarque_status en erreur/à vérifier), comme avant l'ajout du rapprochement FBI", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "42",
        journee: null,
        match_datetime: "2026-09-26T13:30:00.000Z",
        is_home: true,
        opponent_name: "Adversaire",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "played",
        emarque_status: "needs_review",
        team_id: null,
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({
      matchId: "match-1",
      integration: "emarque",
      type: "emarque_needs_review",
      severity: "warning",
    });
  });

  it("renvoie une anomalie de rapprochement calendrier FBI enrichie des infos du match FFBB correspondant", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "3",
        journee: null,
        match_datetime: "2026-09-26T11:30:00.000Z",
        is_home: true,
        opponent_name: "Frontignan",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
      },
    ];
    state.fbiScheduleDiscrepancies = [
      {
        id: "disc-1",
        club_id: CLUB_A.id,
        match_id: "match-1",
        division_code: "BU13MN23",
        numero: "3",
        kind: "mismatch",
        field_name: "match_datetime",
        ffbb_value: "26/09/2026 13:30",
        fbi_value: "27/09/2026 15:00",
        fbi_opponent_name: "Frontignan",
        detected_at: "2026-09-25T10:00:00.000Z",
        resolved_at: null,
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({
      matchId: "match-1",
      opponentName: "Frontignan",
      matchDatetime: "2026-09-26T11:30:00.000Z",
      integration: "fbi_schedule",
      type: "fbi_schedule_mismatch",
      severity: "warning",
      technicalCode: "FBI_SCHEDULE_MISMATCH",
    });
    expect(body.issues[0].message).toContain("26/09/2026 13:30");
    expect(body.issues[0].message).toContain("27/09/2026 15:00");
  });

  it("renvoie une anomalie missing_in_ffbb SANS match_id (rencontre vue sur FBI, absente de notre calendrier FFBB)", async () => {
    state.fbiScheduleDiscrepancies = [
      {
        id: "disc-2",
        club_id: CLUB_A.id,
        match_id: null,
        division_code: "BU11FN2",
        numero: "12",
        kind: "missing_in_ffbb",
        field_name: null,
        ffbb_value: null,
        fbi_value: "SC Sète – Agde",
        fbi_opponent_name: "SC Sète – Agde",
        detected_at: "2026-09-25T10:00:00.000Z",
        resolved_at: null,
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    const body = await res.json();

    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({
      matchId: null,
      opponentName: "SC Sète – Agde",
      integration: "fbi_schedule",
      type: "fbi_schedule_missing_in_ffbb",
      severity: "error",
      technicalCode: "FBI_SCHEDULE_MISSING_IN_FFBB",
    });
  });

  it("n'inclut jamais une anomalie déjà résolue (resolved_at renseigné)", async () => {
    state.fbiScheduleDiscrepancies = [
      {
        id: "disc-3",
        club_id: CLUB_A.id,
        match_id: null,
        division_code: "RM3",
        numero: "5",
        kind: "missing_in_ffbb",
        field_name: null,
        ffbb_value: null,
        fbi_value: null,
        fbi_opponent_name: null,
        detected_at: "2026-09-20T10:00:00.000Z",
        resolved_at: "2026-09-24T10:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    const body = await res.json();
    expect(body.issues).toEqual([]);
  });
});
