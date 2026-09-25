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

describe("GET /:clubId/derogations (voir docs/FBI.md)", () => {
  it("renvoie une liste vide pour un club sans dérogation connue (jamais une erreur)", async () => {
    const res = await request(`/${CLUB_A.id}/derogations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ derogations: [] });
  });

  it("renvoie toutes les dérogations connues, enrichies du match FFBB correspondant", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "1",
        journee: null,
        match_datetime: "2026-09-26T13:30:00.000Z",
        is_home: true,
        opponent_name: "Castelnau Basket - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
      },
    ];
    state.fbiDerogationChecks = [
      {
        id: "check-1",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "1",
        etat: "A Créer",
        date_depot: null,
        date_derogation: null,
        date_rencontre: "26/09/2026",
        heure: "15:30",
        domicile: "SPORT CLUB DE SETE BASKET - 1",
        visiteur: "CASTELNAU BASKET - 2",
        checked_at: "2026-09-25T16:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations).toHaveLength(1);
    expect(body.derogations[0]).toMatchObject({
      matchId: "match-1",
      opponentName: "Castelnau Basket - 2",
      matchDatetime: "2026-09-26T13:30:00.000Z",
      numero: "1",
      etat: "A Créer",
    });
  });
});
