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
const CLUB_B = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b", ffbb_club_id: "BBB0000002" };
const POOL_ID = "11111111-1111-4111-8111-111111111111";

function request(path: string) {
  return app.request(`/v1/clubs${path}`, { headers: { authorization: "Bearer test-jwt" } });
}

beforeEach(() => {
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    memberships: [{ id: "membership-a1", club_id: CLUB_A.id, user_id: "user-a", status: "active" }],
    roles: [{ membership_id: "membership-a1", role: "joueur" }],
    teams: [{ id: "team-u13m", club_id: CLUB_A.id, name: "U13 M", sexe: "M", active: true }],
    competitions: [{ id: "comp-1", category_label: "U13", name: "Départementale U13 M" }],
    pools: [
      {
        id: POOL_ID,
        name: "Poule A",
        competition_id: "comp-1",
        standings: [{ engagementFfbbId: "eng-a", teamName: "CLUB A - 1", logoUrl: null, position: 1, points: 4, played: 2, won: 2, lost: 0, outOfRanking: false }],
        standings_updated_at: "2026-10-01T03:00:00Z",
      },
    ],
    engagements: [{ club_id: CLUB_A.id, team_id: "team-u13m", ffbb_engagement_id: "eng-a", pool_id: POOL_ID }],
  });
});

describe("GET /v1/clubs/:clubId/standings — classement dans l'espace club (retour du club, 2026-10-01)", () => {
  it("accessible à tout membre du club (pas seulement club_admin)", async () => {
    const res = await request(`/${CLUB_A.id}/standings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { standings: { teamName: string; rows: { isClub: boolean; points: number }[] }[] };
    expect(body.standings).toHaveLength(1);
    expect(body.standings[0]!.teamName).toBe("U13 M");
    expect(body.standings[0]!.rows[0]).toMatchObject({ isClub: true, points: 4 });
  });

  it("refusé (404, jamais de distinction club existant/inconnu) pour un club dont l'utilisateur n'est pas membre", async () => {
    const res = await request(`/${CLUB_B.id}/standings`);
    expect(res.status).toBe(404);
  });
});
