import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";
import { encryptSecret } from "../../security/crypto.js";
import { FbiError } from "../../integrations/fbi/errors.js";

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

const { mockSyncFfbb } = vi.hoisted(() => ({ mockSyncFfbb: vi.fn() }));
vi.mock("../../integrations/ffbb/sync.js", () => ({ syncFfbb: mockSyncFfbb }));
vi.mock("../../integrations/ffbb/public-provider.js", () => ({ FfbbPublicProvider: vi.fn() }));

const { mockHttpLogin } = vi.hoisted(() => ({ mockHttpLogin: vi.fn() }));
vi.mock("../../integrations/fbi/http-client.js", () => ({
  HttpFbiClient: class FakeHttpFbiClient {
    login = mockHttpLogin;
  },
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
  mockSyncFfbb.mockReset();
  mockSyncFfbb.mockResolvedValue({ syncRunId: "run-1", status: "success", stats: {} });
  mockHttpLogin.mockReset();
  mockHttpLogin.mockResolvedValue({ cookieJar: {} });
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

describe("POST /integrations/ffbb/sync — verrou de concurrence", () => {
  it("synchronise et libère le verrou, même déclenché plusieurs fois d'affilée", async () => {
    const res1 = await request("/integrations/ffbb/sync", { method: "POST" });
    expect(res1.status).toBe(200);
    expect(mockSyncFfbb).toHaveBeenCalledTimes(1);

    // Le verrou a été libéré après le premier appel : un second déclenchement passe aussi.
    const res2 = await request("/integrations/ffbb/sync", { method: "POST" });
    expect(res2.status).toBe(200);
    expect(mockSyncFfbb).toHaveBeenCalledTimes(2);
  });

  it("refuse avec 409 un déclenchement pendant qu'une synchronisation est déjà en cours pour ce club", async () => {
    state.syncLocks.add(`${CLUB_A.id}:ffbb`);

    const res = await request("/integrations/ffbb/sync", { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("FFBB_SYNC_ALREADY_RUNNING");
    expect(mockSyncFfbb).not.toHaveBeenCalled();
  });

  it("libère le verrou même si syncFfbb lève une exception (jamais de verrou bloqué durablement)", async () => {
    mockSyncFfbb.mockRejectedValueOnce(new Error("panne FFBB simulée"));

    const res = await request("/integrations/ffbb/sync", { method: "POST" });
    expect(res.status).toBe(500);
    expect(state.syncLocks.has(`${CLUB_A.id}:ffbb`)).toBe(false);

    // Le verrou étant libéré, un nouveau déclenchement est accepté.
    const res2 = await request("/integrations/ffbb/sync", { method: "POST" });
    expect(res2.status).toBe(200);
  });

  it("un coach reçoit 403 (jamais d'acquisition de verrou pour un rôle non autorisé)", async () => {
    currentUserId = "user-coach";
    const res = await request("/integrations/ffbb/sync", { method: "POST" });
    expect(res.status).toBe(403);
    expect(mockSyncFfbb).not.toHaveBeenCalled();
  });
});

describe("POST /integrations/fbi/test", () => {
  it("connexion réussie : efface un last_error précédent (jamais un statut « Connecté » affiché à côté d'une erreur périmée)", async () => {
    const encrypted = encryptSecret("s3cret-fbi-password", CLUB_A.id);
    state.fbiCredentials.push({
      club_id: CLUB_A.id,
      username: "club-a-fbi",
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      password_auth_tag: encrypted.authTag,
    });
    state.fbiIntegrationStatus.push({
      club_id: CLUB_A.id,
      configured: true,
      last_login_success: false,
      last_login_at: null,
      auto_import_emarque: false,
      last_error: "Connexion FBI impossible : identifiant ou mot de passe incorrect.",
    });

    const res = await request("/integrations/fbi/test", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(state.fbiIntegrationStatus.find((r) => r.club_id === CLUB_A.id)?.last_error).toBeNull();
  });

  it("connexion refusée : enregistre le message d'erreur", async () => {
    const encrypted = encryptSecret("mauvais-mdp", CLUB_A.id);
    state.fbiCredentials.push({
      club_id: CLUB_A.id,
      username: "club-a-fbi",
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      password_auth_tag: encrypted.authTag,
    });
    mockHttpLogin.mockRejectedValue(new FbiError("refusé", "LOGIN_FAILED"));

    const res = await request("/integrations/fbi/test", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(state.fbiIntegrationStatus.find((r) => r.club_id === CLUB_A.id)?.last_error).not.toBeNull();
  });
});
