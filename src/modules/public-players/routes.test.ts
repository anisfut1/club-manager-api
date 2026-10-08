import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow, type FakeMatchRow, type FakeTeamRow } from "../../test-support/fake-club-supabase.js";
import { matchResult, summarizePlayedMatches, type PlayedMatchInput } from "./shared.js";

let state: FakeClubSupabaseState;

vi.mock("../../db/client.js", () => ({
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
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

const TEAM: FakeTeamRow = { id: "11111111-1111-4111-8111-111111111111", club_id: CLUB_A.id, name: "U15", sexe: "F", active: true };
const PLAYER: FakeLicencieRow = {
  id: "22222222-2222-4222-8222-222222222222",
  club_id: CLUB_A.id,
  first_name: "Léa",
  last_name: "Martin",
  license_number: "VT123456",
  birth_date: "2011-04-02",
  email: "lea@example.test",
  phone: "0600000000",
  photo_url: "https://example.test/lea.webp",
  team_id: TEAM.id,
  active: true,
  category_label: "U15",
  sexe: "F",
  public_admin: true,
  coached_team_ids: [],
};
const PLAYER_B: FakeLicencieRow = { ...PLAYER, id: "33333333-3333-4333-8333-333333333333", club_id: CLUB_B.id };

const PAST: FakeMatchRow = {
  id: "44444444-4444-4444-8444-444444444444",
  club_id: CLUB_A.id,
  numero: "15",
  journee: null,
  match_datetime: "2000-10-03T13:00:00Z",
  is_home: true,
  opponent_name: "MEZE",
  venue_raw_label: null,
  score_home: null,
  score_away: null,
  status: "played",
  emarque_status: "imported",
  team_id: TEAM.id,
};
const NEXT: FakeMatchRow = { ...PAST, id: "55555555-5555-4555-8555-555555555555", match_datetime: "2999-10-10T13:00:00Z", opponent_name: "AGDE", is_home: false, status: "scheduled" };

beforeEach(() => {
  state = makeFakeClubSupabaseState({ clubs: [{ ...CLUB_A }, { ...CLUB_B }], teams: [TEAM], licencies: [PLAYER, PLAYER_B], matches: [PAST, NEXT] });
});

describe("GET /v1/public/clubs/:clubSlug/players/:licencieId", () => {
  it("renvoie la fiche publique sans compte, sans aucune donnée personnelle", async () => {
    const res = await app.request(`/v1/public/clubs/club-a/players/${PLAYER.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.player).toEqual({ id: PLAYER.id, firstName: "Léa", lastName: "Martin", photoUrl: "https://example.test/lea.webp", categoryLabel: "U15", sexe: "F" });
    expect(body.teams).toEqual([{ id: TEAM.id, name: "U15 (F)", relation: "PLAYER" }]);
    expect(body.nextMatch).toMatchObject({ matchId: NEXT.id, opponentName: "AGDE", isHome: false });
    const raw = JSON.stringify(body);
    for (const secret of ["VT123456", "2011-04-02", "lea@example.test", "0600000000", "publicAdmin"]) expect(raw).not.toContain(secret);
  });

  it("compte les tables de marque passées et à venir", async () => {
    state.tableAssignments = [
      { id: "t1", club_id: CLUB_A.id, match_id: PAST.id, licencie_id: PLAYER.id, role: "SCORER", created_by: null },
      { id: "t2", club_id: CLUB_A.id, match_id: NEXT.id, licencie_id: PLAYER.id, role: "TIMEKEEPER", created_by: null },
    ];
    // Match passé de cette saison (date relative à aujourd'hui).
    state.matches = [{ ...PAST, match_datetime: new Date(Date.now() - 86_400_000).toISOString() }, NEXT];
    const body = await (await app.request(`/v1/public/clubs/club-a/players/${PLAYER.id}`)).json();
    expect(body.tables).toEqual({ done: 1, upcoming: 1, byRole: [{ role: "SCORER", count: 1 }] });
  });

  it("404 pour un joueur d'un autre club, jamais ses données", async () => {
    const res = await app.request(`/v1/public/clubs/club-a/players/${PLAYER_B.id}`);
    expect(res.status).toBe(404);
  });

  it("404 pour un identifiant invalide ou un club inconnu", async () => {
    expect((await app.request("/v1/public/clubs/club-a/players/pas-un-uuid")).status).toBe(404);
    expect((await app.request(`/v1/public/clubs/inconnu/players/${PLAYER.id}`)).status).toBe(404);
  });
});

describe("summarizePlayedMatches", () => {
  const base: PlayedMatchInput = { matchId: "m", matchDatetime: null, teamName: "U15", opponentName: "X", isHome: true, scoreHome: null, scoreAway: null, jerseyNumber: "7", isCaptain: false, isStarter: true, stats: null };

  it("moyenne sur les seuls matchs avec stats, meilleur match, bilan, plus récent d'abord", () => {
    const result = summarizePlayedMatches([
      { ...base, matchId: "a", matchDatetime: "2026-09-20T10:00:00Z", scoreHome: 50, scoreAway: 40, stats: { points: 12, threePointsMade: 2, freeThrowsMade: 1, secondsPlayed: 900 } },
      { ...base, matchId: "b", matchDatetime: "2026-09-27T10:00:00Z", isHome: false, scoreHome: 60, scoreAway: 41, stats: { points: 5, threePointsMade: 0, freeThrowsMade: 3, secondsPlayed: 600 } },
      { ...base, matchId: "c", matchDatetime: "2026-10-04T10:00:00Z" },
    ]);
    expect(result.season).toEqual({
      matchesPlayed: 3,
      matchesWithStats: 2,
      totalPoints: 17,
      pointsPerMatch: 8.5,
      bestPoints: 12,
      bestPointsMatchId: "a",
      threePointsMade: 2,
      freeThrowsMade: 4,
      secondsPlayed: 1500,
      wins: 1,
      losses: 1,
    });
    expect(result.recentMatches.map((m) => [m.matchId, m.result])).toEqual([
      ["c", null],
      ["b", "LOSS"],
      ["a", "WIN"],
    ]);
  });

  it("aucune moyenne inventée sans statistiques", () => {
    expect(summarizePlayedMatches([base]).season.pointsPerMatch).toBeNull();
    expect(matchResult(true, 40, 40)).toBe("DRAW");
  });
});
