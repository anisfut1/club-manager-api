import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow, type FakeMatchRow, type FakeTeamRow } from "../../test-support/fake-club-supabase.js";

let state: FakeClubSupabaseState;

// Écritures FBI réelles jamais exécutées en test : seuls les droits d'accès sont vérifiés ici.
const fbiWrites = vi.hoisted(() => ({
  create: vi.fn(async () => ({ outcome: "success" as const, message: null })),
  respond: vi.fn(async () => ({ outcome: "success" as const, message: null })),
}));
vi.mock("../derogations/create-derogation.js", () => ({ createDerogationForClub: fbiWrites.create }));
vi.mock("../derogations/respond-derogation.js", () => ({ respondToDerogationForClub: fbiWrites.respond }));

vi.mock("../../db/client.js", () => ({
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");
const { resetEnvCacheForTests } = await import("../../config/env.js");

/** Appels interceptés vers l'API Resend — jamais un vrai envoi en test. */
let sentEmails: { to: string[]; subject: string; html: string; text: string; from: string }[];
let resendStatus: number;

/**
 * Flux PUBLIC sans compte (retour du club, 2026-09-29) — AUCUN de ces
 * tests n'envoie de header Authorization : il n'y a pas de session
 * Supabase, l'identité vient exclusivement de `?token=`. Toutes les
 * lectures/écritures passent par `createServiceSupabaseClient` (RLS
 * bypass), c'est ce que ce fichier vérifie : que le code applicatif, et
 * lui seul, isole correctement club/identité.
 */

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

const TEAM_U13M: FakeTeamRow = { id: "team-u13m", club_id: CLUB_A.id, name: "U13 M", sexe: "M", active: true };
const TEAM_U13F: FakeTeamRow = { id: "team-u13f", club_id: CLUB_A.id, name: "U13 F", sexe: "F", active: true };

// 2026-10-03 est en heure d'été (CEST, UTC+2) : 15:00 Paris == 13:00 UTC.
const TARGET_MATCH: FakeMatchRow = {
  id: "match-target",
  club_id: CLUB_A.id,
  numero: "15",
  journee: null,
  match_datetime: "2026-10-03T13:00:00Z", // 15:00 Paris
  is_home: true,
  opponent_name: "MEZE LOUPIAN",
  venue_raw_label: "GYMNASE MAURICE CLAVEL",
  score_home: null,
  score_away: null,
  status: "scheduled",
  emarque_status: "not_applicable",
  team_id: TEAM_U13M.id,
};

const AWAY_MATCH: FakeMatchRow = { ...TARGET_MATCH, id: "match-away", numero: "16", match_datetime: "2026-10-03T14:00:00Z", is_home: false, team_id: TEAM_U13F.id };

const THOMAS: FakeLicencieRow = {
  id: "licencie-thomas",
  club_id: CLUB_A.id,
  first_name: "Thomas",
  last_name: "Martin",
  license_number: null,
  birth_date: null,
  email: null,
  phone: null,
  photo_url: null,
  team_id: null,
  active: true,
};
const LEA: FakeLicencieRow = { ...THOMAS, id: "licencie-lea", first_name: "Léa", last_name: "Fontaine" };

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/public/clubs/club-a${path}`, init);
}

function requestLink(licencieId: string, body: { email?: string | null; returnTo?: string } = {}, slug = "club-a") {
  return app.request(`/v1/public/clubs/${slug}/licencies/${licencieId}/request-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
}

/** Le jeton n'est JAMAIS dans la réponse : on le récupère, comme la vraie personne, depuis le lien de l'email. */
function tokenFromLastEmail(): string {
  const last = sentEmails.at(-1);
  const match = last ? /[?&]token=([^\s"&<]+)/.exec(last.text) : null;
  if (!match?.[1]) throw new Error("Aucun lien personnel dans le dernier email envoyé.");
  return decodeURIComponent(match[1]);
}

async function claim(licencieId: string, email = `${licencieId}@example.test`): Promise<string> {
  const res = await requestLink(licencieId, { email });
  expect(res.status).toBe(200);
  return tokenFromLastEmail();
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_not_real";
  resetEnvCacheForTests();
  sentEmails = [];
  resendStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url !== "https://api.resend.com/emails") throw new Error(`fetch inattendu : ${url}`);
      if (resendStatus !== 200) return new Response(JSON.stringify({ message: "refusé" }), { status: resendStatus });
      sentEmails.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    }),
  );
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    teams: [TEAM_U13M, TEAM_U13F],
    matches: [TARGET_MATCH],
    licencies: [{ ...THOMAS }, { ...LEA }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  resetEnvCacheForTests();
});

describe("GET /v1/public/clubs/:clubSlug — pas de compte requis", () => {
  it("renvoie les infos club minimales, sans header Authorization", async () => {
    const res = await request("");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: "club-a", name: "Club A Basket", logoUrl: null, accentColor: null, timezone: "Europe/Paris" });
  });

  it("404 pour un slug inconnu", async () => {
    const res = await app.request("/v1/public/clubs/club-inconnu");
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/public/clubs/:clubSlug/licencies — roster pour choisir son nom", () => {
  it("liste les licenciés actifs avec `claimed`, jamais qui a revendiqué quoi", async () => {
    await claim(THOMAS.id);
    const res = await request("/licencies");
    const body = (await res.json()) as { licencies: { id: string; claimed: boolean }[] };
    expect(body.licencies).toEqual(
      expect.arrayContaining([
        { id: THOMAS.id, firstName: "Thomas", lastName: "Martin", claimed: true },
        { id: LEA.id, firstName: "Léa", lastName: "Fontaine", claimed: false },
      ]),
    );
  });
});

describe("POST .../licencies/:licencieId/request-link — retour du club : \"il va chercher son nom, il va mettre son mail\"", () => {
  it("envoie le lien par email (bouton + lien texte), JAMAIS le jeton dans la réponse, et enregistre l'adresse du licencié", async () => {
    const res = await requestLink(THOMAS.id, { email: "thomas@example.test", returnTo: "derogations" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ sent: true, maskedEmail: "t***@example.test" });
    expect(JSON.stringify(body)).not.toContain("token");

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toEqual(["thomas@example.test"]);
    expect(sentEmails[0]!.from).toBe("Club A Basket <onboarding@resend.dev>");
    expect(sentEmails[0]!.html).toContain("Ouvrir l'espace du club");
    expect(sentEmails[0]!.text).toContain("http://localhost:3000/public/club-a/derogations?token=");

    const token = tokenFromLastEmail();
    const meRes = await request(`/me?token=${token}`);
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({ licencie: { id: THOMAS.id, firstName: "Thomas", lastName: "Martin" }, isClubAdmin: false, derogationRequests: { canCreate: false, canManage: false }, tables: { canManage: false } });

    expect(state.licencies.find((l) => l.id === THOMAS.id)?.email).toBe("thomas@example.test");
  });

  it("400 EMAIL_REQUIRED sans adresse connue ni saisie — rien n'est créé", async () => {
    const res = await requestLink(THOMAS.id, {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("EMAIL_REQUIRED");
    expect(state.publicTokens).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("adresse déjà connue : l'email part TOUJOURS à cette adresse, l'adresse saisie est ignorée (\"lien perdu ?\")", async () => {
    state.licencies = [{ ...THOMAS, email: "vrai.thomas@example.test" }, { ...LEA }];
    const res = await requestLink(THOMAS.id, { email: "attaquant@example.test" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { maskedEmail: string }).maskedEmail).toBe("v***@example.test");
    expect(sentEmails[0]!.to).toEqual(["vrai.thomas@example.test"]);
    expect(state.licencies.find((l) => l.id === THOMAS.id)?.email).toBe("vrai.thomas@example.test");
  });

  it("une nouvelle demande remplace l'ancien lien (l'ancien jeton est révoqué)", async () => {
    const first = await claim(THOMAS.id, "thomas@example.test");
    state.publicTokens = state.publicTokens.map((t) => ({ ...t, created_at: new Date(Date.now() - 5 * 60_000).toISOString() }));

    const res = await requestLink(THOMAS.id, {});
    expect(res.status).toBe(200);
    const second = tokenFromLastEmail();
    expect(second).not.toBe(first);
    expect((await request(`/me?token=${first}`)).status).toBe(401);
    expect((await request(`/me?token=${second}`)).status).toBe(200);
  });

  it("429 LINK_RECENTLY_SENT si un lien vient d'être envoyé — le lien actif reste valide", async () => {
    const token = await claim(THOMAS.id, "thomas@example.test");
    const res = await requestLink(THOMAS.id, {});
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("LINK_RECENTLY_SENT");
    expect((await request(`/me?token=${token}`)).status).toBe(200);
  });

  it("409 ALREADY_CLAIMED si le nom a été choisi sans adresse (ancien flux) — impossible de le détourner avec sa propre adresse", async () => {
    state.publicTokens = [{ id: "legacy", club_id: CLUB_A.id, licencie_id: THOMAS.id, token_hash: "legacy-hash", email: null, created_at: "2026-09-29T10:00:00Z", revoked_at: null, revoked_by: null }];
    const res = await requestLink(THOMAS.id, { email: "attaquant@example.test" });
    expect(res.status).toBe(409);
    expect(sentEmails).toHaveLength(0);
  });

  it("503 EMAIL_NOT_CONFIGURED sans clé Resend — aucun lien existant n'est révoqué", async () => {
    const token = await claim(THOMAS.id, "thomas@example.test");
    state.publicTokens = state.publicTokens.map((t) => ({ ...t, created_at: new Date(Date.now() - 5 * 60_000).toISOString() }));
    delete process.env.RESEND_API_KEY;
    resetEnvCacheForTests();

    const res = await requestLink(THOMAS.id, {});
    expect(res.status).toBe(503);
    expect((await request(`/me?token=${token}`)).status).toBe(200);
  });

  it("502 si Resend refuse l'envoi — le nouveau jeton est révoqué, l'ancien lien est restauré, l'adresse n'est pas enregistrée", async () => {
    const token = await claim(THOMAS.id, "thomas@example.test");
    state.publicTokens = state.publicTokens.map((t) => ({ ...t, created_at: new Date(Date.now() - 5 * 60_000).toISOString() }));
    resendStatus = 403;

    const res = await requestLink(THOMAS.id, {});
    expect(res.status).toBe(502);
    expect((await request(`/me?token=${token}`)).status).toBe(200);
    expect(state.publicTokens.filter((t) => t.revoked_at === null)).toHaveLength(1);

    resendStatus = 403;
    const leaRes = await requestLink(LEA.id, { email: "lea@example.test" });
    expect(leaRes.status).toBe(502);
    expect(state.licencies.find((l) => l.id === LEA.id)?.email).toBeNull();
  });

  it("n'utilise jamais une origine non autorisée dans le lien", async () => {
    await app.request(`/v1/public/clubs/club-a/licencies/${THOMAS.id}/request-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://site-piege.example" },
      body: JSON.stringify({ email: "thomas@example.test" }),
    });
    expect(sentEmails[0]!.text).not.toContain("site-piege");
    expect(sentEmails[0]!.text).toContain("http://localhost:3000/public/club-a/tables?token=");
  });

  it("404 pour un licencié d'un autre club, même UUID connu", async () => {
    const res = await requestLink(THOMAS.id, { email: "x@example.test" }, "club-b");
    expect(res.status).toBe(404);
  });

  it("l'ancienne route /claim (lien affiché à l'écran) n'existe plus", async () => {
    const res = await request(`/licencies/${THOMAS.id}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(res.status).toBe(404);
  });
});

describe("GET .../derogations?token= — retour du club : dérogations publiques réservées aux admins du club", () => {
  const ADMIN_USER = "user-thomas";

  beforeEach(() => {
    state.fbiDerogationChecks = [];
  });

  it("401 sans jeton valide", async () => {
    const res = await request("/derogations?token=jeton-invalide");
    expect(res.status).toBe(401);
  });

  it("403 CLUB_ADMIN_REQUIRED avec un jeton valide d'un licencié non admin", async () => {
    const token = await claim(LEA.id);
    const res = await request(`/derogations?token=${token}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CLUB_ADMIN_REQUIRED");
  });

  it("403 si le compte rattaché n'est admin que d'un AUTRE club, ou si l'appartenance est suspendue", async () => {
    state.memberships = [
      { id: "m-b", club_id: CLUB_B.id, user_id: ADMIN_USER, status: "active", licencie_id: THOMAS.id },
      { id: "m-a", club_id: CLUB_A.id, user_id: ADMIN_USER, status: "suspended", licencie_id: THOMAS.id },
    ];
    state.roles = [
      { membership_id: "m-b", role: "club_admin" },
      { membership_id: "m-a", role: "club_admin" },
    ];
    const token = await claim(THOMAS.id);
    expect((await request(`/derogations?token=${token}`)).status).toBe(403);
    expect(((await (await request(`/me?token=${token}`)).json()) as { isClubAdmin: boolean }).isClubAdmin).toBe(false);
  });

  it("200 pour un licencié sans compte à qui un club_admin a donné le profil admin depuis /joueurs (licencies.public_admin)", async () => {
    state.licencies = state.licencies.map((l) => (l.id === LEA.id ? { ...l, public_admin: true } : l));
    const token = await claim(LEA.id);

    expect((await request(`/derogations?token=${token}`)).status).toBe(200);
    expect(((await (await request(`/me?token=${token}`)).json()) as { isClubAdmin: boolean }).isClubAdmin).toBe(true);
  });

  it("200 pour un licencié rattaché à un compte club_admin actif du club — et /me renvoie isClubAdmin", async () => {
    state.memberships = [{ id: "m-a", club_id: CLUB_A.id, user_id: ADMIN_USER, status: "active", licencie_id: THOMAS.id }];
    state.roles = [{ membership_id: "m-a", role: "club_admin" }];
    const token = await claim(THOMAS.id);

    const res = await request(`/derogations?token=${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ derogations: [] });

    expect(((await (await request(`/me?token=${token}`)).json()) as { isClubAdmin: boolean }).isClubAdmin).toBe(true);
  });
});

describe("Le jeton n'authentifie que SON club — jamais un autre, même avec un slug connu", () => {
  it("un jeton du club A échoue sur les routes du club B", async () => {
    const token = await claim(THOMAS.id);
    const res = await app.request(`/v1/public/clubs/club-b/me?token=${token}`);
    expect(res.status).toBe(401);
  });
});

describe("PUT .../table-assignments/:role — auto-affectation, retour du club : \"la personne qui va se mettre sur un match\"", () => {
  it("licencieId vient TOUJOURS du jeton — crée l'affectation pour SOI, jamais pour quelqu'un d'autre", async () => {
    const token = await claim(THOMAS.id);
    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER?token=${token}`, { method: "PUT" });
    expect(res.status).toBe(200);
    expect(state.tableAssignments).toEqual([expect.objectContaining({ role: "SCORER", licencie_id: THOMAS.id, created_by: null })]);
  });

  it("409 ALREADY_TAKEN_BY_SOMEONE_ELSE si le poste est déjà occupé par quelqu'un d'autre — jamais un remplacement silencieux", async () => {
    const thomasToken = await claim(THOMAS.id);
    const leaToken = await claim(LEA.id);

    await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER?token=${thomasToken}`, { method: "PUT" });
    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER?token=${leaToken}`, { method: "PUT" });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ALREADY_TAKEN_BY_SOMEONE_ELSE");
    expect(state.tableAssignments).toHaveLength(1);
    expect(state.tableAssignments[0]?.licencie_id).toBe(THOMAS.id); // inchangé
  });

  it("409 AWAY_MATCH_NOT_SUPPORTED pour un match extérieur", async () => {
    state.matches = [TARGET_MATCH, AWAY_MATCH];
    const token = await claim(THOMAS.id);
    const res = await request(`/matches/${AWAY_MATCH.id}/table-assignments/SCORER?token=${token}`, { method: "PUT" });
    expect(res.status).toBe(409);
  });

  it("401 sans jeton (ou jeton révoqué/invalide)", async () => {
    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER?token=jeton-invalide`, { method: "PUT" });
    expect(res.status).toBe(401);
  });
});

describe("DELETE .../table-assignments/:role — retour du club : \"peuvent se supprimer eux-mêmes si le token est tjr actif\"", () => {
  it("retire SA PROPRE affectation", async () => {
    const token = await claim(THOMAS.id);
    await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER?token=${token}`, { method: "PUT" });

    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER?token=${token}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(state.tableAssignments).toHaveLength(0);
  });

  it('403 en tentant de retirer l\'affectation de QUELQU\'UN D\'AUTRE — "ne peut pas être supprimé par quelqu\'un d\'autre sauf un admin"', async () => {
    const thomasToken = await claim(THOMAS.id);
    const leaToken = await claim(LEA.id);
    await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER?token=${thomasToken}`, { method: "PUT" });

    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER?token=${leaToken}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(state.tableAssignments).toHaveLength(1); // toujours affecté à Thomas
  });
});

describe("Réinitialisation admin — retour du club : \"sinon faut faire une demande admin\"", () => {
  it("après révocation, le token perd son accès ET le nom redevient choisissable", async () => {
    const token = await claim(THOMAS.id);

    // Révocation directe en base (équivalent du POST admin .../public-access/:licencieId/reset, testé côté modules/tables/routes.test.ts).
    state.publicTokens = state.publicTokens.map((t) => (t.licencie_id === THOMAS.id ? { ...t, revoked_at: new Date().toISOString() } : t));

    const meRes = await request(`/me?token=${token}`);
    expect(meRes.status).toBe(401);

    // Adresse enregistrée lors de la première demande : le nouveau lien repart à cette adresse.
    const reclaimRes = await requestLink(THOMAS.id, {});
    expect(reclaimRes.status).toBe(200);
    expect(sentEmails.at(-1)!.to).toEqual([`${THOMAS.id}@example.test`]);
  });
});

describe("Coach / admin du club depuis l'espace public — retour du club, 2026-10-02 : « désigner qui il veut et retirer, comme un admin général »", () => {
  const asCoach = () => {
    state.licencies = state.licencies.map((l) => (l.id === THOMAS.id ? { ...l, public_coach: true } : l));
  };
  const put = (token: string, role: string, body?: unknown) =>
    request(`/matches/${TARGET_MATCH.id}/table-assignments/${role}?token=${token}`, {
      method: "PUT",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });

  it("/me expose tables.canManage : vrai pour un coach ou un admin, faux sinon", async () => {
    const leaToken = await claim(LEA.id);
    expect(((await (await request(`/me?token=${leaToken}`)).json()) as { tables: { canManage: boolean } }).tables.canManage).toBe(false);

    asCoach();
    const thomasToken = await claim(THOMAS.id);
    expect(((await (await request(`/me?token=${thomasToken}`)).json()) as { tables: { canManage: boolean } }).tables.canManage).toBe(true);

    state.licencies = state.licencies.map((l) => (l.id === LEA.id ? { ...l, public_admin: true } : l));
    expect(((await (await request(`/me?token=${leaToken}`)).json()) as { tables: { canManage: boolean } }).tables.canManage).toBe(true);
  });

  it("un coach désigne quelqu'un d'autre — et peut remplacer le titulaire (jamais le cas pour un licencié sans rôle)", async () => {
    asCoach();
    const coachToken = await claim(THOMAS.id);
    const leaToken = await claim(LEA.id);

    await put(leaToken, "SCORER");
    expect(state.tableAssignments[0]?.licencie_id).toBe(LEA.id);

    const res = await put(coachToken, "SCORER", { licencieId: THOMAS.id });
    expect(res.status).toBe(200);
    expect(state.tableAssignments).toEqual([expect.objectContaining({ role: "SCORER", licencie_id: THOMAS.id })]);

    const designate = await put(coachToken, "TIMEKEEPER", { licencieId: LEA.id });
    expect(designate.status).toBe(200);
    expect(state.tableAssignments.find((a) => a.role === "TIMEKEEPER")?.licencie_id).toBe(LEA.id);
  });

  it("403 TABLES_MANAGER_REQUIRED : un licencié sans rôle ne désigne jamais quelqu'un d'autre", async () => {
    const leaToken = await claim(LEA.id);
    const res = await put(leaToken, "SCORER", { licencieId: THOMAS.id });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TABLES_MANAGER_REQUIRED");
    expect(state.tableAssignments).toHaveLength(0);
  });

  it("404 pour un licencié d'un autre club, même désigné par un coach", async () => {
    asCoach();
    state.licencies.push({ ...LEA, id: "licencie-autre-club", club_id: CLUB_B.id });
    const coachToken = await claim(THOMAS.id);
    const res = await put(coachToken, "SCORER", { licencieId: "licencie-autre-club" });
    expect(res.status).toBe(404);
    expect(state.tableAssignments).toHaveLength(0);
  });

  it("un coach retire l'affectation de quelqu'un d'autre", async () => {
    asCoach();
    const coachToken = await claim(THOMAS.id);
    const leaToken = await claim(LEA.id);
    await put(leaToken, "SCORER");

    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER?token=${coachToken}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(state.tableAssignments).toHaveLength(0);
  });

  it("suggestions : 200 pour un coach (mêmes sections que l'admin), 403 sans rôle", async () => {
    const leaToken = await claim(LEA.id);
    expect((await request(`/matches/${TARGET_MATCH.id}/table-suggestions?token=${leaToken}&role=SCORER`)).status).toBe(403);

    asCoach();
    const coachToken = await claim(THOMAS.id);
    const res = await request(`/matches/${TARGET_MATCH.id}/table-suggestions?token=${coachToken}&role=SCORER`);
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(["available", "recommended", "unavailable"]);
  });

  it("« pas besoin d'arbitre » : coach uniquement", async () => {
    const leaToken = await claim(LEA.id);
    const body = { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ noRefereeNeeded: true }) };
    expect((await request(`/matches/${TARGET_MATCH.id}/referee-status?token=${leaToken}`, body)).status).toBe(403);
    expect(state.refereeOverrides).toHaveLength(0);

    asCoach();
    const coachToken = await claim(THOMAS.id);
    const res = await request(`/matches/${TARGET_MATCH.id}/referee-status?token=${coachToken}`, body);
    expect(res.status).toBe(200);
    expect(state.refereeOverrides).toEqual([expect.objectContaining({ match_id: TARGET_MATCH.id, no_referee_needed: true, created_by: null })]);
  });
});

describe("Coordinateur — retour du club, 2026-10-02 : mêmes droits qu'un admin sur les Tables et les dérogations officielles", () => {
  const asCoordinator = () => {
    state.licencies = state.licencies.map((l) => (l.id === THOMAS.id ? { ...l, public_coordinator: true } : l));
  };
  const createBody = { motif: "Gymnase indisponible", modifierDate: false, dateDerogation: null, modifierHoraire: true, horaire: "18:00", inverserRencontre: false, inverserEquipe: false };
  const post = (path: string, body: unknown) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("tables.canManage et désignation d'un autre licencié", async () => {
    asCoordinator();
    const token = await claim(THOMAS.id);
    expect(((await (await request(`/me?token=${token}`)).json()) as { tables: { canManage: boolean } }).tables.canManage).toBe(true);
    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER?token=${token}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ licencieId: LEA.id }),
    });
    expect(res.status).toBe(200);
    expect(state.tableAssignments[0]?.licencie_id).toBe(LEA.id);
  });

  it("liste des dérogations FBI, création et réponse : 200 pour le coordinateur", async () => {
    asCoordinator();
    const token = await claim(THOMAS.id);
    expect((await request(`/derogations?token=${token}`)).status).toBe(200);

    const created = await post(`/matches/${TARGET_MATCH.id}/derogation/create?token=${token}`, createBody);
    expect(created.status).toBe(200);
    expect(fbiWrites.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clubId: CLUB_A.id, matchId: TARGET_MATCH.id, horaire: "18:00", submittedBy: null }));

    const responded = await post(`/derogations/derog-1/respond?token=${token}`, { decision: "accepted" });
    expect(responded.status).toBe(200);
    expect(fbiWrites.respond).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clubId: CLUB_A.id, derogationCheckId: "derog-1", decision: "accepted" }));
  });

  it("403 pour un licencié sans rôle (et pour un simple coach) — aucune écriture FBI", async () => {
    fbiWrites.create.mockClear();
    fbiWrites.respond.mockClear();
    state.licencies = state.licencies.map((l) => (l.id === LEA.id ? { ...l, public_coach: true } : l));
    for (const id of [THOMAS.id, LEA.id]) {
      const token = await claim(id);
      expect((await post(`/matches/${TARGET_MATCH.id}/derogation/create?token=${token}`, createBody)).status).toBe(403);
      expect((await post(`/derogations/derog-1/respond?token=${token}`, { decision: "accepted" })).status).toBe(403);
    }
    expect(fbiWrites.create).not.toHaveBeenCalled();
    expect(fbiWrites.respond).not.toHaveBeenCalled();
  });
});

describe("GET /v1/public/clubs/:clubSlug/table-leaderboard — visible de tous", () => {
  it("sans jeton, uniquement ce club, avec la photo", async () => {
    const past = { ...TARGET_MATCH, id: "match-past", match_datetime: new Date(Date.now() - 86_400_000).toISOString() };
    state.matches = [past, { ...past, id: "match-b", club_id: CLUB_B.id }];
    state.licencies = [{ ...THOMAS, photo_url: "https://example.test/t.webp" }, { ...LEA }];
    state.tableAssignments = [
      { id: "t1", club_id: CLUB_A.id, match_id: past.id, licencie_id: THOMAS.id, role: "SCORER", created_by: null },
      { id: "t2", club_id: CLUB_B.id, match_id: "match-b", licencie_id: LEA.id, role: "SCORER", created_by: null },
    ];

    const res = await request("/table-leaderboard");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalDone).toBe(1);
    expect(body.entries).toEqual([
      { rank: 1, licencie: { id: THOMAS.id, firstName: "Thomas", lastName: "Martin", photoUrl: "https://example.test/t.webp" }, done: 1, upcoming: 0, byRole: [{ role: "SCORER", count: 1 }] },
    ]);
  });
});
