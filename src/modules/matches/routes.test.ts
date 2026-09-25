import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";
import { encryptSecret } from "../../security/crypto.js";

let state: FakeClubSupabaseState;
let currentUserId = "user-a";

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

// Zod v4 `.uuid()` exige les nibbles de version/variant RFC 4122
// ([1-8] puis [89ab]) — un placeholder "tout répété" comme
// "11111111-0000-..." échoue la validation et casse §20 avec un faux 400.
const TEAM_A = { id: "11111111-1111-4111-8111-111111111111", club_id: CLUB_A.id, name: "Seniors M" };
const TEAM_B = { id: "22222222-2222-4222-8222-222222222222", club_id: CLUB_B.id, name: "Seniors F" };

function match(overrides: Partial<(typeof state.matches)[number]>): (typeof state.matches)[number] {
  return {
    id: `match-${Math.random().toString(36).slice(2)}`,
    club_id: CLUB_A.id,
    numero: "1",
    journee: "1",
    match_datetime: "2026-01-10T18:00:00.000Z",
    is_home: true,
    opponent_name: "Adversaire",
    venue_raw_label: "Gymnase",
    score_home: null,
    score_away: null,
    status: "scheduled",
    emarque_status: "not_applicable",
    team_id: TEAM_A.id,
    ...overrides,
  };
}

function fakeFbiCredentials(): (typeof state.fbiCredentials)[number] {
  const encrypted = encryptSecret("s3cret-fbi-password", CLUB_A.id);
  return { club_id: CLUB_A.id, username: "club1234", password_ciphertext: encrypted.ciphertext, password_iv: encrypted.iv, password_auth_tag: encrypted.authTag };
}

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}/matches${path}`, {
    ...init,
    headers: { authorization: "Bearer test-jwt", "content-type": "application/json", ...init.headers },
  });
}

beforeEach(() => {
  currentUserId = "user-a";
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    memberships: [{ id: "membership-a1", club_id: CLUB_A.id, user_id: "user-a", status: "active" }],
    roles: [{ membership_id: "membership-a1", role: "joueur" }],
    teams: [TEAM_A, TEAM_B],
  });
});

describe("GET /v1/clubs/:clubId/matches — filtres (gap 7 de la demande)", () => {
  it("filtre par homeAway", async () => {
    state.matches = [match({ id: "home-1", is_home: true }), match({ id: "away-1", is_home: false })];
    const res = await request("?homeAway=away");
    const body = await res.json();
    expect(body.matches.map((m: { id: string }) => m.id)).toEqual(["away-1"]);
  });

  it("filtre par status", async () => {
    state.matches = [match({ id: "played-1", status: "played" }), match({ id: "scheduled-1", status: "scheduled" })];
    const res = await request("?status=played");
    const body = await res.json();
    expect(body.matches.map((m: { id: string }) => m.id)).toEqual(["played-1"]);
  });

  it("filtre par from/to (plage explicite)", async () => {
    state.matches = [
      match({ id: "early", match_datetime: "2026-01-01T10:00:00.000Z" }),
      match({ id: "mid", match_datetime: "2026-01-15T10:00:00.000Z" }),
      match({ id: "late", match_datetime: "2026-02-01T10:00:00.000Z" }),
    ];
    const res = await request("?from=2026-01-10T00:00:00Z&to=2026-01-20T00:00:00Z");
    const body = await res.json();
    expect(body.matches.map((m: { id: string }) => m.id)).toEqual(["mid"]);
  });

  it("rejette period ET from/to en même temps (mutuellement exclusifs)", async () => {
    const res = await request("?period=weekend&from=2026-01-10T00:00:00Z");
    expect(res.status).toBe(400);
  });

  it("§20 de la demande — teamId d'un AUTRE club ne fuit jamais : réponse vide, jamais une erreur ni un indice d'existence", async () => {
    state.matches = [match({ id: "match-a", team_id: TEAM_A.id })];
    const res = await request(`?teamId=${TEAM_B.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toEqual([]);
  });

  it("rejette un teamId mal formé (pas un UUID)", async () => {
    const res = await request("?teamId=not-a-uuid");
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/clubs/:clubId/matches — pagination (§12 de la demande)", () => {
  it("limite le nombre de résultats et expose le total réel", async () => {
    state.matches = Array.from({ length: 5 }, (_, i) => match({ id: `m${i}`, match_datetime: `2026-01-0${i + 1}T10:00:00.000Z` }));
    const res = await request("?limit=2&offset=0");
    const body = await res.json();
    expect(body.matches).toHaveLength(2);
    expect(body.pagination).toEqual({ limit: 2, offset: 0, total: 5 });
  });

  it("applique l'offset", async () => {
    state.matches = Array.from({ length: 5 }, (_, i) => match({ id: `m${i}`, match_datetime: `2026-01-0${i + 1}T10:00:00.000Z` }));
    const res = await request("?limit=2&offset=4");
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
  });

  it("rejette une limite au-delà du maximum documenté", async () => {
    const res = await request("?limit=99999");
    expect(res.status).toBe(400);
  });

  it("utilise une limite par défaut raisonnable sans paramètre (jamais un dump complet non borné)", async () => {
    state.matches = Array.from({ length: 3 }, (_, i) => match({ id: `m${i}` }));
    const res = await request("");
    const body = await res.json();
    expect(body.pagination.limit).toBeGreaterThan(0);
  });
});

describe("GET /v1/clubs/:clubId/matches — isolation cross-tenant", () => {
  it("un utilisateur non membre du club reçoit 404, jamais les matchs", async () => {
    currentUserId = "user-not-a-member";
    const res = await request("");
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/clubs/:clubId/matches/:matchId/derogation (voir docs/FBI.md)", () => {
  it("renvoie derogation: null quand aucune vérification n'a encore été lancée", async () => {
    state.matches = [match({ id: "match-1" })];
    const res = await request("/match-1/derogation");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.derogation).toBeNull();
  });

  it("renvoie le dernier état connu, converti en camelCase", async () => {
    state.matches = [match({ id: "match-1" })];
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

    const res = await request("/match-1/derogation");
    const body = await res.json();
    expect(body.derogation).toMatchObject({ numero: "1", etat: "A Créer", dateRencontre: "26/09/2026", heure: "15:30", checkedAt: "2026-09-25T16:00:00.000Z" });
  });
});

describe("POST /v1/clubs/:clubId/matches/:matchId/derogation/check (club_admin, voir docs/FBI.md)", () => {
  beforeEach(() => {
    state.roles = [{ membership_id: "membership-a1", role: "club_admin" }];
  });

  it("empile un job check_derogation quand FBI est configuré", async () => {
    state.matches = [match({ id: "match-1", numero: "42" })];
    state.fbiCredentials = [fakeFbiCredentials()];

    const res = await request("/match-1/derogation/check", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ queued: true });
    expect(state.fbiJobs).toHaveLength(1);
    expect(state.fbiJobs[0]).toMatchObject({ club_id: CLUB_A.id, match_id: "match-1", type: "check_derogation" });
  });

  it("rejette (409) quand FBI n'est pas configuré pour ce club", async () => {
    state.matches = [match({ id: "match-1", numero: "42" })];
    const res = await request("/match-1/derogation/check", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("rejette (409) une deuxième vérification tant que la première est en attente", async () => {
    state.matches = [match({ id: "match-1", numero: "42" })];
    state.fbiCredentials = [fakeFbiCredentials()];

    const first = await request("/match-1/derogation/check", { method: "POST" });
    expect(first.status).toBe(200);
    const second = await request("/match-1/derogation/check", { method: "POST" });
    expect(second.status).toBe(409);
  });

  it("refuse (403) à un membre non club_admin", async () => {
    state.roles = [{ membership_id: "membership-a1", role: "joueur" }];
    state.matches = [match({ id: "match-1", numero: "42" })];
    state.fbiCredentials = [fakeFbiCredentials()];

    const res = await request("/match-1/derogation/check", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("404 pour un match introuvable/d'un autre club", async () => {
    state.fbiCredentials = [fakeFbiCredentials()];
    const res = await request("/match-inexistant/derogation/check", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
