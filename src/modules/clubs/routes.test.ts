import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";

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

// Testé via l'app complète (pas le routeur seul) pour bénéficier du
// gestionnaire d'erreur central (`app.onError`, voir src/app.ts) qui
// traduit une `ApiError` en réponse JSON avec le bon statut HTTP — un
// routeur monté isolément n'a pas ce gestionnaire et renverrait 500 pour
// toute erreur, même correctement typée.
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

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs${path}`, { ...init, headers: { authorization: "Bearer test-jwt", "content-type": "application/json", ...init.headers } });
}

beforeEach(() => {
  currentUserId = "user-a";
  state = makeFakeClubSupabaseState({
    // Copies fraîches à chaque test : `clubsTable.update()` mute la ligne
    // en place (`Object.assign`), jamais les objets CLUB_A/CLUB_B partagés
    // eux-mêmes, sous peine de faire fuiter l'état d'un test au suivant.
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    memberships: [
      { id: "membership-a1", club_id: CLUB_A.id, user_id: "user-a", status: "active" },
      { id: "membership-b1", club_id: CLUB_B.id, user_id: "user-b", status: "active" },
      { id: "membership-a2-coach", club_id: CLUB_A.id, user_id: "user-coach", status: "active" },
    ],
    roles: [
      { membership_id: "membership-a1", role: "club_admin" },
      { membership_id: "membership-b1", role: "club_admin" },
      { membership_id: "membership-a2-coach", role: "coach" },
    ],
  });
});

describe("PATCH /:clubId (gap 1 de la demande)", () => {
  it("club_admin peut modifier le branding de SON club", async () => {
    const res = await request(`/${CLUB_A.id}`, { method: "PATCH", body: JSON.stringify({ name: "Nouveau nom" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Nouveau nom");
    expect(body.ffbbClubCode).toBe("AAA0000001"); // jamais modifié par cette route
  });

  it("un coach (non club_admin) reçoit 403", async () => {
    currentUserId = "user-coach";
    const res = await request(`/${CLUB_A.id}`, { method: "PATCH", body: JSON.stringify({ name: "Tentative coach" }) });
    expect(res.status).toBe(403);
  });

  it("club_admin du club A NE PEUT PAS modifier le club B en fournissant son UUID (§19 de la demande)", async () => {
    // user-a est club_admin de A, mais n'est même pas membre de B.
    const res = await request(`/${CLUB_B.id}`, { method: "PATCH", body: JSON.stringify({ name: "Piraté" }) });
    expect(res.status).toBe(404); // jamais 403 : n'expose pas l'existence du club à un non-membre
    expect(state.clubs.find((c) => c.id === CLUB_B.id)?.name).toBe(CLUB_A.name); // inchangé (CLUB_B a le même nom que CLUB_A au départ)
  });

  it("club_admin du club B PEUT modifier le club B (isolation correcte, pas juste un refus global)", async () => {
    currentUserId = "user-b";
    const res = await request(`/${CLUB_B.id}`, { method: "PATCH", body: JSON.stringify({ name: "Club B renommé" }) });
    expect(res.status).toBe(200);
    expect(state.clubs.find((c) => c.id === CLUB_A.id)?.name).toBe(CLUB_A.name); // le club A n'a jamais été touché
  });

  it("rejette un fuseau horaire invalide (validation sérieuse, §2 de la demande)", async () => {
    const res = await request(`/${CLUB_A.id}`, { method: "PATCH", body: JSON.stringify({ timezone: "Pas/UnFuseau" }) });
    expect(res.status).toBe(400);
  });

  it("rejette une couleur d'accent mal formée", async () => {
    const res = await request(`/${CLUB_A.id}`, { method: "PATCH", body: JSON.stringify({ accentColor: "bleu" }) });
    expect(res.status).toBe(400);
  });

  it("ne permet jamais de modifier ffbbClubCode/status via ce DTO (rejeté par la validation zod — champ excédentaire ignoré silencieusement, comportement zod par défaut)", async () => {
    const res = await request(`/${CLUB_A.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Nom légitime", ffbbClubCode: "HACKED0001", status: "suspended" }),
    });
    expect(res.status).toBe(200);
    expect(state.clubs.find((c) => c.id === CLUB_A.id)?.ffbb_club_id).toBe("AAA0000001");
    expect(state.clubs.find((c) => c.id === CLUB_A.id)?.status).toBe("active");
  });

  it("accepte un PATCH vide sans erreur (no-op)", async () => {
    const res = await request(`/${CLUB_A.id}`, { method: "PATCH", body: JSON.stringify({}) });
    expect(res.status).toBe(200);
  });
});

describe("POST /:clubId/teams — enregistrer une équipe avant tout engagement FFBB (demande du club, docs/TEAMS.md)", () => {
  it("club_admin peut créer une équipe manuellement, avec catégorie/sexe/numéro", async () => {
    const res = await request(`/${CLUB_A.id}/teams`, {
      method: "POST",
      body: JSON.stringify({ name: "U9", category: "U9", sexe: null, numeroEquipe: null }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ name: "U9", category: "U9", sexe: null, numeroEquipe: null, active: true });
    expect(state.teams.find((t) => t.id === body.id)?.club_id).toBe(CLUB_A.id);
  });

  it("rejette un nom vide (validation)", async () => {
    const res = await request(`/${CLUB_A.id}/teams`, { method: "POST", body: JSON.stringify({ name: "" }) });
    expect(res.status).toBe(400);
  });

  it("un coach (non club_admin) reçoit 403, ne peut jamais créer d'équipe", async () => {
    currentUserId = "user-coach";
    const res = await request(`/${CLUB_A.id}/teams`, { method: "POST", body: JSON.stringify({ name: "U9" }) });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /:clubId/teams/:teamId — renommer/reclasser/activer une équipe", () => {
  beforeEach(() => {
    state.teams = [{ id: "team-1", club_id: CLUB_A.id, name: "U11 1", category: "U11", sexe: "M", numero_equipe: "1", active: true }];
  });

  it("club_admin peut renommer et désactiver une équipe", async () => {
    const res = await request(`/${CLUB_A.id}/teams/team-1`, { method: "PATCH", body: JSON.stringify({ name: "U11 Masculin 1", active: false }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: "U11 Masculin 1", active: false, sexe: "M" }); // sexe inchangé (non soumis)
  });

  it("404 pour une équipe d'un AUTRE club, jamais une erreur qui en révèle l'existence", async () => {
    state.teams.push({ id: "team-b", club_id: CLUB_B.id, name: "Équipe B", category: null, sexe: null, numero_equipe: null, active: true });
    const res = await request(`/${CLUB_A.id}/teams/team-b`, { method: "PATCH", body: JSON.stringify({ name: "Piraté" }) });
    expect(res.status).toBe(404);
  });

  it("un coach (non club_admin) reçoit 403", async () => {
    currentUserId = "user-coach";
    const res = await request(`/${CLUB_A.id}/teams/team-1`, { method: "PATCH", body: JSON.stringify({ name: "Tentative coach" }) });
    expect(res.status).toBe(403);
  });
});
