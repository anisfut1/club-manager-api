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

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}${path}`, {
    ...init,
    headers: { authorization: "Bearer test-jwt", "content-type": "application/json", ...init.headers },
  });
}

beforeEach(() => {
  currentUserId = "user-a";
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }],
    memberships: [
      { id: "membership-a1", club_id: CLUB_A.id, user_id: "user-a", status: "active" },
      { id: "membership-a2-coach", club_id: CLUB_A.id, user_id: "user-coach", status: "active" },
    ],
    roles: [
      { membership_id: "membership-a1", role: "club_admin" },
      { membership_id: "membership-a2-coach", role: "coach" },
    ],
  });
});

describe("PATCH /integrations/ffbb (gap 2 de la demande)", () => {
  it("club_admin peut changer le code club FFBB — replanifie next_sync_at", async () => {
    const res = await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({ clubCode: "occ0099999" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clubCode).toBe("OCC0099999"); // normalisé en majuscules
    expect(body.nextSyncAt).not.toBeNull();
    expect(state.clubs[0]!.ffbb_club_id).toBe("OCC0099999");
  });

  it("un coach reçoit 403", async () => {
    currentUserId = "user-coach";
    const res = await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({ clubCode: "OCC0099999" }) });
    expect(res.status).toBe(403);
  });

  it("rejette un code FFBB mal formé (validation sérieuse)", async () => {
    const res = await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({ clubCode: "a" }) });
    expect(res.status).toBe(400);
  });

  it("rejette un corps vide (au moins un champ requis)", async () => {
    const res = await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("enabled=false désactive la synchro sans toucher au code club", async () => {
    const res = await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(res.status).toBe(200);
    expect(state.clubs[0]!.ffbb_enabled).toBe(false);
    expect(state.clubs[0]!.ffbb_club_id).toBe("AAA0000001");
  });

  it("ne supprime jamais l'historique déjà synchronisé (aucun DELETE sur matches — cette route ne touche que `clubs`)", async () => {
    await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({ clubCode: "OCC0099999" }) });
    // Le fake Supabase ne connaît PAS la table `matches` : si la route
    // tentait d'y toucher, cet appel lèverait "Table inattendue" et le test précédent aurait déjà échoué.
    expect(state.clubs).toHaveLength(1);
  });
});

describe("PATCH /integrations/fbi (gap 4 de la demande)", () => {
  it("rejette autoImportEmarque=true sans identifiants configurés (FBI_NOT_CONFIGURED, §6 de la demande)", async () => {
    const res = await request("/integrations/fbi", { method: "PATCH", body: JSON.stringify({ autoImportEmarque: true }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("FBI_NOT_CONFIGURED");
  });

  it("rejette enabled=true sans identifiants configurés", async () => {
    const res = await request("/integrations/fbi", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    expect(res.status).toBe(409);
  });

  it("enabled=false est toujours permis, même sans identifiants configurés", async () => {
    const res = await request("/integrations/fbi", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(res.status).toBe(200);
  });

  it("autoImportEmarque=true fonctionne une fois des identifiants enregistrés, et ne redemande jamais username/password", async () => {
    const encrypted = encryptSecret("s3cret-fbi-password", CLUB_A.id);
    state.fbiCredentials.push({
      club_id: CLUB_A.id,
      username: "club-a-fbi",
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      password_auth_tag: encrypted.authTag,
    });

    const res = await request("/integrations/fbi", { method: "PATCH", body: JSON.stringify({ autoImportEmarque: true }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fbi.autoImportEmarque).toBe(true);
    expect(body.fbi.username).toBe("club-a-fbi"); // gap 8 : le username reste affichable
    expect(JSON.stringify(body)).not.toMatch(/ciphertext|password/i);
  });

  it("un coach reçoit 403", async () => {
    currentUserId = "user-coach";
    const res = await request("/integrations/fbi", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(res.status).toBe(403);
  });
});

describe("GET /integrations (gap 8 de la demande)", () => {
  it("expose le username FBI configuré, jamais le mot de passe", async () => {
    state.fbiCredentials.push({
      club_id: CLUB_A.id,
      username: "club-a-fbi",
      password_ciphertext: "secret-cipher",
      password_iv: "iv",
      password_auth_tag: "tag",
    });

    const res = await request("/integrations", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fbi.username).toBe("club-a-fbi");
    expect(JSON.stringify(body)).not.toContain("secret-cipher");
  });

  it("username = null quand FBI n'est pas configuré (jamais une erreur)", async () => {
    const res = await request("/integrations", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fbi.username).toBeNull();
    expect(body.fbi.configured).toBe(false);
  });
});
