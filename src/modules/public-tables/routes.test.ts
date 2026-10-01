import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow, type FakeMatchRow, type FakeTeamRow } from "../../test-support/fake-club-supabase.js";

let state: FakeClubSupabaseState;

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
    expect(sentEmails[0]!.html).toContain("Ouvrir mon espace");
    expect(sentEmails[0]!.text).toContain("http://localhost:3000/public/club-a/derogations?token=");

    const token = tokenFromLastEmail();
    const meRes = await request(`/me?token=${token}`);
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({ licencie: { id: THOMAS.id, firstName: "Thomas", lastName: "Martin" }, isClubAdmin: false, derogationRequests: { canCreate: false, canManage: false } });

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
