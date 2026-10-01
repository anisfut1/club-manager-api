import { hashPublicToken } from "../public-tables/token.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow, type FakeMatchRow, type FakeTeamRow } from "../../test-support/fake-club-supabase.js";

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

// `licencieId` est validé comme UUID v4 strict par PutTableAssignmentDtoSchema
// (z.string().uuid() exige le nibble de version 4 et le nibble de variante 8-b)
// — jamais un id court comme ailleurs dans ce fichier de tests, ni un
// "00000000-..." qui échoue cette regex (version nibble '0' invalide).
const L1 = "00000000-0000-4000-8000-000000000001";
const L2 = "00000000-0000-4000-8000-000000000002";
const L_CLUB_B = "00000000-0000-4000-8000-000000000003";

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

const AWAY_MATCH: FakeMatchRow = {
  ...TARGET_MATCH,
  id: "match-u13f-away",
  numero: "16",
  match_datetime: "2026-10-03T14:00:00Z", // 16:00 Paris
  is_home: false,
  team_id: TEAM_U13F.id,
};

function licencie(overrides: Partial<FakeLicencieRow> = {}): FakeLicencieRow {
  return {
    id: `licencie-${Math.random().toString(36).slice(2)}`,
    club_id: CLUB_A.id,
    first_name: "Thomas",
    last_name: "Martin",
    license_number: null,
    birth_date: null,
    email: null,
    phone: null,
    photo_url: null,
    active: true,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}${path}`, {
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
      { id: "membership-table-manager", club_id: CLUB_A.id, user_id: "user-table-manager", status: "active" },
      { id: "membership-plain", club_id: CLUB_A.id, user_id: "user-plain", status: "active" },
    ],
    roles: [
      { membership_id: "membership-admin", role: "club_admin" },
      { membership_id: "membership-table-manager", role: "responsable_tables" },
    ],
    teams: [TEAM_U13M, TEAM_U13F],
    matches: [TARGET_MATCH],
  });
});

describe("GET /v1/clubs/:clubId/matches/:matchId/table-suggestions — permissions", () => {
  it("403 pour un membre sans club_admin ni responsable_tables", async () => {
    currentUserId = "user-plain";
    const res = await request(`/matches/${TARGET_MATCH.id}/table-suggestions?role=SCORER`);
    expect(res.status).toBe(403);
  });

  it("200 pour un membre ayant UNIQUEMENT responsable_tables (§31 : rôle dédié, jamais besoin de club_admin)", async () => {
    currentUserId = "user-table-manager";
    state.licencies = [licencie({ id: "l1", team_id: null })];
    const res = await request(`/matches/${TARGET_MATCH.id}/table-suggestions?role=SCORER`);
    expect(res.status).toBe(200);
  });

  it("400 sans le paramètre ?role= (obligatoire, §37)", async () => {
    const res = await request(`/matches/${TARGET_MATCH.id}/table-suggestions`);
    expect(res.status).toBe(400);
  });
});

describe("GET .../table-suggestions — §4/§44 : jamais pour un match extérieur", () => {
  it("409 AWAY_MATCH_NOT_SUPPORTED", async () => {
    state.matches = [TARGET_MATCH, AWAY_MATCH];
    const res = await request(`/matches/${AWAY_MATCH.id}/table-suggestions?role=SCORER`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AWAY_MATCH_NOT_SUPPORTED");
  });
});

describe("GET .../table-suggestions — §50 : match extérieur qui chevauche rend l'équipe adverse indisponible", () => {
  it("un licencié U13F (match extérieur 16h-18h qui chevauche la table 15h-17h) est UNAVAILABLE/MATCH_CONFLICT", async () => {
    state.matches = [TARGET_MATCH, AWAY_MATCH];
    state.licencies = [licencie({ id: "sarah", first_name: "Sarah", last_name: "Martin", team_id: TEAM_U13F.id })];

    const res = await request(`/matches/${TARGET_MATCH.id}/table-suggestions?role=SCORER`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unavailable: { licencie: { id: string }; reasonCode: string }[] };
    expect(body.unavailable).toEqual([expect.objectContaining({ licencie: { id: "sarah", firstName: "Sarah", lastName: "Martin" }, reasonCode: "MATCH_CONFLICT" })]);
  });
});

describe("§57 : GET table-suggestions est STRICTEMENT en lecture — ne crée jamais d'affectation", () => {
  it("le nombre de lignes table_assignments est identique avant/après l'appel", async () => {
    state.licencies = [licencie({ id: "l1" })];
    const before = state.tableAssignments.length;

    await request(`/matches/${TARGET_MATCH.id}/table-suggestions?role=SCORER`);
    await request(`/matches/${TARGET_MATCH.id}/table-suggestions?role=TIMEKEEPER`);
    await request(`/matches/${TARGET_MATCH.id}/table-suggestions?role=CLUB_DELEGATE`);

    expect(state.tableAssignments.length).toBe(before);
  });
});

describe("PUT .../table-assignments/:role — §40/§58 : seule action qui crée une affectation", () => {
  it("crée exactement une affectation, puis GET la retourne", async () => {
    const target = licencie({ id: L1, team_id: null });
    state.licencies = [target];

    const putRes = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER`, { method: "PUT", body: JSON.stringify({ licencieId: L1 }) });
    expect(putRes.status).toBe(200);
    expect(state.tableAssignments).toHaveLength(1);
    expect(state.tableAssignments[0]).toMatchObject({ club_id: CLUB_A.id, match_id: TARGET_MATCH.id, role: "SCORER", licencie_id: L1, created_by: "user-admin" });

    const listRes = await request(`/table-assignments`);
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { matches: { match: { id: string }; assignments: { scorer: { licencie: { id: string } } | null } }[] };
    const match = body.matches.find((m) => m.match.id === TARGET_MATCH.id);
    expect(match?.assignments.scorer?.licencie.id).toBe(L1);
  });

  it("ré-affecter le même rôle REMPLACE le titulaire précédent (une seule ligne, jamais deux) — §77 Modifier", async () => {
    state.licencies = [licencie({ id: L1, team_id: null }), licencie({ id: L2, team_id: null })];

    await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER`, { method: "PUT", body: JSON.stringify({ licencieId: L1 }) });
    await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER`, { method: "PUT", body: JSON.stringify({ licencieId: L2 }) });

    expect(state.tableAssignments).toHaveLength(1);
    expect(state.tableAssignments[0]?.licencie_id).toBe(L2);
  });

  it("409 AWAY_MATCH_NOT_SUPPORTED pour un match extérieur (§44)", async () => {
    state.matches = [TARGET_MATCH, AWAY_MATCH];
    state.licencies = [licencie({ id: L1, team_id: null })];

    const res = await request(`/matches/${AWAY_MATCH.id}/table-assignments/SCORER`, { method: "PUT", body: JSON.stringify({ licencieId: L1 }) });
    expect(res.status).toBe(409);
  });

  it("404 pour un licencié d'un AUTRE club, même UUID connu (§59 — jamais une affectation cross-tenant)", async () => {
    state.licencies = [licencie({ id: L_CLUB_B, club_id: CLUB_B.id })];

    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER`, { method: "PUT", body: JSON.stringify({ licencieId: L_CLUB_B }) });
    expect(res.status).toBe(404);
    expect(state.tableAssignments).toHaveLength(0);
  });

  it("403 pour un membre sans club_admin ni responsable_tables", async () => {
    currentUserId = "user-plain";
    state.licencies = [licencie({ id: L1 })];
    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER`, { method: "PUT", body: JSON.stringify({ licencieId: L1 }) });
    expect(res.status).toBe(403);
    expect(state.tableAssignments).toHaveLength(0);
  });

  /**
   * §42 : RECALCULE les conflits au moment de l'écriture, ne fait jamais
   * confiance à une suggestion vieille de quelques secondes.
   */
  it("409 TABLE_ASSIGNMENT_CONFLICT si le candidat est déjà affecté à une AUTRE table qui chevauche", async () => {
    const otherMatch: FakeMatchRow = { ...TARGET_MATCH, id: "match-other", numero: "13", match_datetime: "2026-10-03T14:00:00Z" }; // 16h Paris, chevauche 15h-17h
    state.matches = [TARGET_MATCH, otherMatch];
    state.licencies = [licencie({ id: L1, team_id: null })];
    state.tableAssignments = [{ id: "existing", club_id: CLUB_A.id, match_id: otherMatch.id, role: "SCORER", licencie_id: L1, created_by: "user-admin" }];

    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/TIMEKEEPER`, { method: "PUT", body: JSON.stringify({ licencieId: L1 }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TABLE_ASSIGNMENT_CONFLICT");
    expect(state.tableAssignments).toHaveLength(1); // inchangé, aucune écriture en cas de conflit
  });

  it("409 ALREADY_ASSIGNED_ON_MATCH si le candidat occupe déjà un AUTRE rôle sur CE match (§11/§28)", async () => {
    state.licencies = [licencie({ id: L1, team_id: null })];
    state.tableAssignments = [{ id: "existing", club_id: CLUB_A.id, match_id: TARGET_MATCH.id, role: "SCORER", licencie_id: L1, created_by: "user-admin" }];

    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/TIMEKEEPER`, { method: "PUT", body: JSON.stringify({ licencieId: L1 }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ALREADY_ASSIGNED_ON_MATCH");
  });
});

describe("PUT .../table-assignments/REFEREE — retour du club, 2026-09-28 : l'arbitre est un 4e poste, mêmes règles que les 3 autres", () => {
  it("crée exactement une affectation REFEREE, puis GET la retourne", async () => {
    const target = licencie({ id: L1, team_id: null });
    state.licencies = [target];

    const putRes = await request(`/matches/${TARGET_MATCH.id}/table-assignments/REFEREE`, { method: "PUT", body: JSON.stringify({ licencieId: L1 }) });
    expect(putRes.status).toBe(200);
    expect(state.tableAssignments).toEqual([expect.objectContaining({ role: "REFEREE", licencie_id: L1 })]);

    const listRes = await request(`/table-assignments`);
    const body = (await listRes.json()) as { matches: { match: { id: string }; assignments: { referee: { licencie: { id: string } } | null } }[] };
    const match = body.matches.find((m) => m.match.id === TARGET_MATCH.id);
    expect(match?.assignments.referee?.licencie.id).toBe(L1);
  });

  it("un arbitre affecté sur un AUTRE match qui chevauche rend le candidat indisponible pour REFEREE ici (même moteur générique, pas de règle spécifique au rôle)", async () => {
    const otherMatch: FakeMatchRow = { ...TARGET_MATCH, id: "match-other", numero: "13", match_datetime: "2026-10-03T14:00:00Z" }; // 16h Paris, chevauche 15h-17h
    state.matches = [TARGET_MATCH, otherMatch];
    state.licencies = [licencie({ id: L1, team_id: null })];
    state.tableAssignments = [{ id: "existing", club_id: CLUB_A.id, match_id: otherMatch.id, role: "REFEREE", licencie_id: L1, created_by: "user-admin" }];

    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/REFEREE`, { method: "PUT", body: JSON.stringify({ licencieId: L1 }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TABLE_ASSIGNMENT_CONFLICT");
  });
});

describe("PUT .../matches/:matchId/referee-status — retour du club, 2026-09-28 : 'pas besoin d'arbitre' (officiel FFBB déjà désigné)", () => {
  it("cocher renvoie refereeNotNeeded=true, reflété par GET .../table-assignments, sans jamais toucher table_assignments", async () => {
    const res = await request(`/matches/${TARGET_MATCH.id}/referee-status`, { method: "PUT", body: JSON.stringify({ noRefereeNeeded: true }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refereeNotNeeded: true });
    expect(state.tableAssignments).toHaveLength(0);

    const listRes = await request(`/table-assignments`);
    const body = (await listRes.json()) as { matches: { match: { id: string }; refereeNotNeeded: boolean }[] };
    const match = body.matches.find((m) => m.match.id === TARGET_MATCH.id);
    expect(match?.refereeNotNeeded).toBe(true);
  });

  it("décocher (noRefereeNeeded: false) remet l'état par défaut (arbitre du club à nouveau nécessaire)", async () => {
    await request(`/matches/${TARGET_MATCH.id}/referee-status`, { method: "PUT", body: JSON.stringify({ noRefereeNeeded: true }) });
    await request(`/matches/${TARGET_MATCH.id}/referee-status`, { method: "PUT", body: JSON.stringify({ noRefereeNeeded: false }) });

    expect(state.refereeOverrides).toHaveLength(0); // absence de ligne = état par défaut (voir migration)

    const listRes = await request(`/table-assignments`);
    const body = (await listRes.json()) as { matches: { match: { id: string }; refereeNotNeeded: boolean }[] };
    const match = body.matches.find((m) => m.match.id === TARGET_MATCH.id);
    expect(match?.refereeNotNeeded).toBe(false);
  });

  it("409 AWAY_MATCH_NOT_SUPPORTED pour un match extérieur", async () => {
    state.matches = [TARGET_MATCH, AWAY_MATCH];
    const res = await request(`/matches/${AWAY_MATCH.id}/referee-status`, { method: "PUT", body: JSON.stringify({ noRefereeNeeded: true }) });
    expect(res.status).toBe(409);
  });

  it("403 pour un membre sans club_admin ni responsable_tables", async () => {
    currentUserId = "user-plain";
    const res = await request(`/matches/${TARGET_MATCH.id}/referee-status`, { method: "PUT", body: JSON.stringify({ noRefereeNeeded: true }) });
    expect(res.status).toBe(403);
  });
});

describe("DELETE .../table-assignments/:role — §41 : remet le poste à 'À attribuer'", () => {
  it("retire uniquement l'affectation ciblée, jamais les autres", async () => {
    state.tableAssignments = [
      { id: "a1", club_id: CLUB_A.id, match_id: TARGET_MATCH.id, role: "SCORER", licencie_id: "l1", created_by: "user-admin" },
      { id: "a2", club_id: CLUB_A.id, match_id: TARGET_MATCH.id, role: "TIMEKEEPER", licencie_id: "l2", created_by: "user-admin" },
    ];

    const res = await request(`/matches/${TARGET_MATCH.id}/table-assignments/SCORER`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(state.tableAssignments).toHaveLength(1);
    expect(state.tableAssignments[0]?.role).toBe("TIMEKEEPER");
  });
});

describe("GET /v1/clubs/:clubId/table-assignments — §36 : matchs à domicile uniquement", () => {
  it("un match extérieur n'apparaît jamais dans la liste (§4)", async () => {
    state.matches = [TARGET_MATCH, AWAY_MATCH];

    const res = await request(`/table-assignments`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: { match: { id: string } }[] };
    expect(body.matches.map((m) => m.match.id)).toEqual([TARGET_MATCH.id]);
  });

  /** §45/§79 : un conflit apparu APRÈS coup (ex: FFBB a déplacé le match de l'équipe du titulaire) est signalé, JAMAIS supprimé/remplacé automatiquement. */
  it("signale un conflit sur une affectation existante devenue incompatible, sans jamais la supprimer", async () => {
    const conflictingAwayMatch: FakeMatchRow = { ...AWAY_MATCH, id: "match-conflict-source", team_id: TEAM_U13F.id, match_datetime: "2026-10-03T13:30:00Z" }; // 15h30 Paris, chevauche 15h-17h
    state.matches = [TARGET_MATCH, conflictingAwayMatch];
    state.licencies = [licencie({ id: "l1", team_id: TEAM_U13F.id })];
    state.tableAssignments = [{ id: "a1", club_id: CLUB_A.id, match_id: TARGET_MATCH.id, role: "SCORER", licencie_id: "l1", created_by: "user-admin" }];

    const res = await request(`/table-assignments`);
    const body = (await res.json()) as { matches: { match: { id: string }; assignments: { scorer: { hasConflict: boolean; conflictReason: string | null } | null }; hasConflict: boolean }[] };
    const match = body.matches.find((m) => m.match.id === TARGET_MATCH.id)!;

    expect(match.hasConflict).toBe(true);
    expect(match.assignments.scorer?.hasConflict).toBe(true);
    expect(match.assignments.scorer?.conflictReason).toContain("Match extérieur");
    expect(state.tableAssignments).toHaveLength(1); // jamais supprimée/remplacée automatiquement
    expect(state.tableAssignments[0]?.licencie_id).toBe("l1"); // toujours "Thomas Martin", pas d'auto-remplacement
  });
});

describe("Cross-tenant — §30/§59 : Club B ne voit jamais les données Club A", () => {
  it("GET .../table-assignments d'un club dont on n'est pas membre échoue (404, jamais une fuite)", async () => {
    const res = await app.request(`/v1/clubs/${CLUB_B.id}/table-assignments`, { headers: { authorization: "Bearer test-jwt" } });
    expect([403, 404]).toContain(res.status);
  });
});

describe("GET .../table-assignments/public-access — retour du club, 2026-09-29 : vue admin des accès publics", () => {
  it("club_admin uniquement — 403 pour responsable_tables (gestion d'accès/identité, plus sensible)", async () => {
    currentUserId = "user-table-manager";
    const res = await request(`/table-assignments/public-access`);
    expect(res.status).toBe(403);
  });

  it("liste `claimed`/`email`/`claimedAt` sans exposer le jeton lui-même", async () => {
    state.licencies = [licencie({ id: L1, first_name: "Thomas", last_name: "Martin", team_id: null })];
    state.publicTokens = [{ id: "pt1", club_id: CLUB_A.id, licencie_id: L1, token_hash: "hash", email: "thomas@example.test", created_at: "2026-09-29T10:00:00Z", revoked_at: null, revoked_by: null }];

    const res = await request(`/table-assignments/public-access`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { licencie: { id: string }; claimed: boolean; email: string | null; claimedAt: string | null }[] };
    expect(body.entries).toEqual([{ licencie: { id: L1, firstName: "Thomas", lastName: "Martin" }, claimed: true, email: "thomas@example.test", claimedAt: "2026-09-29T10:00:00Z" }]);
    expect(JSON.stringify(body)).not.toContain("hash"); // jamais le token_hash exposé
  });
});

describe("POST .../public-access/:licencieId/reset — retour du club : \"sauf si admin remet à reset son profil\"", () => {
  it("révoque le jeton actif — le nom redevient choisissable, les affectations existantes restent intactes", async () => {
    state.licencies = [licencie({ id: L1, team_id: null })];
    state.publicTokens = [{ id: "pt1", club_id: CLUB_A.id, licencie_id: L1, token_hash: "hash", email: null, created_at: "2026-09-29T10:00:00Z", revoked_at: null, revoked_by: null }];
    state.tableAssignments = [{ id: "a1", club_id: CLUB_A.id, match_id: TARGET_MATCH.id, role: "SCORER", licencie_id: L1, created_by: null }];

    const res = await request(`/table-assignments/public-access/${L1}/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reset: true });

    expect(state.publicTokens[0]?.revoked_at).not.toBeNull();
    expect(state.tableAssignments).toHaveLength(1); // jamais touché par la réinitialisation d'accès
  });

  it("403 pour responsable_tables", async () => {
    currentUserId = "user-table-manager";
    state.licencies = [licencie({ id: L1, team_id: null })];
    const res = await request(`/table-assignments/public-access/${L1}/reset`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("404 pour un licencié d'un autre club, même UUID connu (jamais un reset cross-tenant)", async () => {
    state.licencies = [licencie({ id: L_CLUB_B, club_id: CLUB_B.id })];
    const res = await request(`/table-assignments/public-access/${L_CLUB_B}/reset`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST .../public-access/:licencieId/link — retour du club : « l'admin doit avoir accès au lien unique par joueur »", () => {
  it("émet un lien s'il n'y en a pas, puis réaffiche LE MÊME (lien déjà utilisé toujours valable)", async () => {
    state.licencies = [licencie({ id: L1, team_id: null })];
    const first = await request(`/table-assignments/public-access/${L1}/link`, { method: "POST" });
    expect(first.status).toBe(200);
    const a = (await first.json()) as { link: string; created: boolean };
    expect(a.created).toBe(true);
    expect(a.link).toMatch(/\/public\/[^/]+\/accueil\?token=/);
    const token = new URL(a.link).searchParams.get("token")!;
    expect(state.publicTokens).toHaveLength(1);
    expect(state.publicTokens[0]).toMatchObject({ token_hash: hashPublicToken(token), revoked_at: null });
    expect(JSON.stringify(state.publicTokens[0]?.token_ciphertext)).not.toContain(token); // jamais en clair

    const again = (await (await request(`/table-assignments/public-access/${L1}/link`, { method: "POST" })).json()) as { link: string; created: boolean };
    expect(again).toEqual({ link: a.link, created: false });
    expect(state.publicTokens.filter((t) => t.revoked_at === null)).toHaveLength(1);
  });

  it("ancien lien sans copie chiffrée → remplacé (révoqué) par un nouveau", async () => {
    state.licencies = [licencie({ id: L1, team_id: null })];
    state.publicTokens = [{ id: "legacy", club_id: CLUB_A.id, licencie_id: L1, token_hash: "legacy-hash", email: null, created_at: "2026-09-29T10:00:00Z", revoked_at: null, revoked_by: null }];
    const body = (await (await request(`/table-assignments/public-access/${L1}/link`, { method: "POST" })).json()) as { created: boolean };
    expect(body.created).toBe(true);
    expect(state.publicTokens.find((t) => t.id === "legacy")?.revoked_at).not.toBeNull();
  });

  it("403 pour responsable_tables ; 404 pour un licencié d'un autre club", async () => {
    currentUserId = "user-table-manager";
    state.licencies = [licencie({ id: L1, team_id: null }), licencie({ id: L_CLUB_B, club_id: CLUB_B.id })];
    expect((await request(`/table-assignments/public-access/${L1}/link`, { method: "POST" })).status).toBe(403);
    currentUserId = "user-admin";
    expect((await request(`/table-assignments/public-access/${L_CLUB_B}/link`, { method: "POST" })).status).toBe(404);
    expect(state.publicTokens).toHaveLength(0);
  });
});
