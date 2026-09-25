import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";

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

const CLUB_B = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b", ffbb_club_id: "BBB0000002" };

function licencie(overrides: Partial<FakeLicencieRow> = {}): FakeLicencieRow {
  return {
    id: `licencie-${Math.random().toString(36).slice(2)}`,
    club_id: CLUB_A.id,
    first_name: "Julie",
    last_name: "MESTRES",
    license_number: "JN870663",
    birth_date: null,
    email: null,
    phone: null,
    photo_url: null,
    active: true,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}/licencies${path}`, {
    ...init,
    headers: { authorization: "Bearer test-jwt", "content-type": "application/json", ...init.headers },
  });
}

beforeEach(() => {
  currentUserId = "user-admin";
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    memberships: [
      { id: "membership-admin", club_id: CLUB_A.id, user_id: "user-admin", status: "active" },
      { id: "membership-player", club_id: CLUB_A.id, user_id: "user-player", status: "active", licencie_id: "licencie-self" },
      { id: "membership-plain", club_id: CLUB_A.id, user_id: "user-plain", status: "active" },
    ],
    roles: [{ membership_id: "membership-admin", role: "club_admin" }],
  });
});

describe("GET /v1/clubs/:clubId/licencies — roster", () => {
  it("liste les licenciés DU CLUB uniquement (jamais ceux d'un autre club), triés par nom", async () => {
    state.licencies = [
      licencie({ id: "l1", last_name: "ZEBRA", first_name: "A" }),
      licencie({ id: "l2", last_name: "ABEL", first_name: "B" }),
      licencie({ id: "l3", club_id: CLUB_B.id, last_name: "AUTRECLUB" }),
    ];

    const res = await request("");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { licencies: { id: string; lastName: string }[] };
    expect(body.licencies.map((l) => l.id)).toEqual(["l2", "l1"]);
    expect(body.licencies.every((l) => l.lastName !== "AUTRECLUB")).toBe(true);
  });
});

describe("GET /v1/clubs/:clubId/licencies/:licencieId — fiche joueur", () => {
  it("404 pour un licencié d'un AUTRE club, jamais une erreur qui en révèle l'existence", async () => {
    state.licencies = [licencie({ id: "l-other-club", club_id: CLUB_B.id })];

    const res = await request("/l-other-club");
    expect(res.status).toBe(404);
  });

  it("404 pour un identifiant inconnu", async () => {
    const res = await request("/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });

  it("club_admin peut tout éditer, même la fiche d'un·e autre licencié·e (isSelf=false)", async () => {
    state.licencies = [licencie({ id: "l1" })];

    const res = await request("/l1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canEdit: boolean; isSelf: boolean };
    expect(body).toMatchObject({ canEdit: true, isSelf: false });
  });

  it("le licencié lui-même (rattaché via club_memberships.licencie_id) peut éditer SA PROPRE fiche (isSelf=true)", async () => {
    currentUserId = "user-player";
    state.licencies = [licencie({ id: "licencie-self" })];

    const res = await request("/licencie-self");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canEdit: boolean; isSelf: boolean };
    expect(body).toMatchObject({ canEdit: true, isSelf: true });
  });

  it("un membre quelconque (ni admin, ni le licencié lui-même) peut LIRE la fiche mais pas la modifier", async () => {
    currentUserId = "user-plain";
    state.licencies = [licencie({ id: "l1" })];

    const res = await request("/l1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canEdit: boolean; isSelf: boolean };
    expect(body).toMatchObject({ canEdit: false, isSelf: false });
  });
});

describe("PATCH /v1/clubs/:clubId/licencies/:licencieId/profile — permissions", () => {
  it("club_admin peut modifier l'identité complète (nom, licence, statut actif...)", async () => {
    state.licencies = [licencie({ id: "l1" })];

    const res = await request("/l1/profile", { method: "PATCH", body: JSON.stringify({ lastName: "NOUVEAU-NOM", active: false }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lastName: string; active: boolean };
    expect(body).toMatchObject({ lastName: "NOUVEAU-NOM", active: false });
  });

  it("le licencié lui-même peut modifier sa photo/son contact", async () => {
    currentUserId = "user-player";
    state.licencies = [licencie({ id: "licencie-self" })];

    const res = await request("/licencie-self/profile", { method: "PATCH", body: JSON.stringify({ photoUrl: "https://example.com/moi.jpg" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { photoUrl: string };
    expect(body.photoUrl).toBe("https://example.com/moi.jpg");
  });

  it("le licencié lui-même NE PEUT JAMAIS modifier son propre nom ou numéro de licence (400, jamais un rejet silencieux)", async () => {
    currentUserId = "user-player";
    state.licencies = [licencie({ id: "licencie-self" })];

    const res = await request("/licencie-self/profile", { method: "PATCH", body: JSON.stringify({ lastName: "TRICHE" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/lastName/);
  });

  it("un membre qui n'est ni admin ni le licencié lui-même reçoit 403, jamais 200", async () => {
    currentUserId = "user-plain";
    state.licencies = [licencie({ id: "l1" })];

    const res = await request("/l1/profile", { method: "PATCH", body: JSON.stringify({ photoUrl: "https://example.com/x.jpg" }) });
    expect(res.status).toBe(403);
  });

  const TEAM_A_ID = "11111111-1111-4111-8111-111111111111";
  const TEAM_B_ID = "22222222-2222-4222-8222-222222222222";

  it("club_admin peut rattacher un licencié à une équipe DE SON CLUB (demande du club, docs/TEAMS.md)", async () => {
    state.licencies = [licencie({ id: "l1" })];
    state.teams = [{ id: TEAM_A_ID, club_id: CLUB_A.id, name: "U11 1", active: true }];

    const res = await request("/l1/profile", { method: "PATCH", body: JSON.stringify({ teamId: TEAM_A_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.teamId).toBe(TEAM_A_ID);
  });

  it("rejette un teamId appartenant à un AUTRE club (400, jamais un rattachement cross-tenant silencieux)", async () => {
    state.licencies = [licencie({ id: "l1" })];
    state.teams = [{ id: TEAM_B_ID, club_id: CLUB_B.id, name: "Équipe B", active: true }];

    const res = await request("/l1/profile", { method: "PATCH", body: JSON.stringify({ teamId: TEAM_B_ID }) });
    expect(res.status).toBe(400);
    expect(state.licencies.find((l) => l.id === "l1")?.team_id).toBeUndefined();
  });
});
