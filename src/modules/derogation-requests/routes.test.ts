import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeMatchRow } from "../../test-support/fake-club-supabase.js";

let state: FakeClubSupabaseState;
let currentUserId = "coach-u15";

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

const CLUB_A = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "A1", ffbb_enabled: true, ffbb_next_sync_at: null };
const CLUB_B = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b", ffbb_club_id: "B1" };

const TEAM_U15F = "11111111-1111-4111-8111-000000000015";
const TEAM_U18M = "11111111-1111-4111-8111-000000000018";
const TEAM_U13M = "11111111-1111-4111-8111-000000000013";
const VENUE_A = "22222222-2222-4222-8222-00000000000a";
const VENUE_B = "22222222-2222-4222-8222-00000000000b";
const FFBB_VENUE_A = "ffbb-venue-a";

const TARGET: FakeMatchRow = {
  id: "33333333-3333-4333-8333-000000000001",
  club_id: CLUB_A.id,
  numero: "101",
  journee: null,
  match_datetime: "2026-10-03T16:00:00.000Z", // samedi 3 octobre 18:00 Paris
  is_home: true,
  opponent_name: "SAUVIAN SERIGNAN",
  venue_raw_label: "GYMNASE A — 1 rue A",
  score_home: null,
  score_away: null,
  status: "scheduled",
  emarque_status: "not_applicable",
  team_id: TEAM_U15F,
  venue_id: FFBB_VENUE_A,
};
// Dimanche 11 octobre, 15:00 Paris = 13:00 UTC, gymnase A.
const SUNDAY_OTHER: FakeMatchRow = { ...TARGET, id: "33333333-3333-4333-8333-000000000002", numero: "102", opponent_name: "AGDE", match_datetime: "2026-10-11T13:00:00.000Z", team_id: TEAM_U13M };
const U18_MATCH: FakeMatchRow = { ...TARGET, id: "33333333-3333-4333-8333-000000000003", numero: "103", team_id: TEAM_U18M, match_datetime: "2026-10-04T08:00:00.000Z" };
const PAST_MATCH: FakeMatchRow = { ...TARGET, id: "33333333-3333-4333-8333-000000000004", match_datetime: "2026-09-20T13:00:00.000Z", status: "played" };

const SUNDAY_15H = "2026-10-11T15:00:00+02:00";

function as(userId: string) {
  currentUserId = userId;
}

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: "Bearer test-jwt", "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface Detail {
  id: string;
  status: string;
  requesterDisplayName: string;
  requestedVenue: { name: string } | null;
  proposals: { requestedStartAt: string }[];
  messages: { type: string; body: string; authorDisplayName: string; authorRoleLabel: string | null; event: string | null }[];
  permissions: { canPropose: boolean; actions: string[] };
}

async function createRequest(body: Record<string, unknown> = {}) {
  as("coach-u15");
  return request("/derogation-requests", { method: "POST", body: { matchId: TARGET.id, requestedStartAt: SUNDAY_15H, requestedVenueId: VENUE_B, comment: "L'équipe adverse nous propose cette date.", ...body } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T10:00:00.000Z"));
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    teams: [
      { id: TEAM_U15F, club_id: CLUB_A.id, name: "U15", sexe: "F", active: true },
      { id: TEAM_U18M, club_id: CLUB_A.id, name: "U18", sexe: "M", active: true },
      { id: TEAM_U13M, club_id: CLUB_A.id, name: "U13", sexe: "M", active: true },
    ],
    memberships: [
      { id: "m-coach15", club_id: CLUB_A.id, user_id: "coach-u15", status: "active", licencie_id: "lic-anis" },
      { id: "m-coach18", club_id: CLUB_A.id, user_id: "coach-u18", status: "active" },
      { id: "m-coord", club_id: CLUB_A.id, user_id: "coord", status: "active" },
      { id: "m-admin", club_id: CLUB_A.id, user_id: "admin", status: "active" },
      { id: "m-b", club_id: CLUB_B.id, user_id: "user-b", status: "active" },
    ],
    roles: [
      { membership_id: "m-coach15", role: "coach", scope_team_id: TEAM_U15F },
      { membership_id: "m-coach18", role: "coach", scope_team_id: TEAM_U18M },
      { membership_id: "m-coord", role: "correspondant_club", scope_team_id: null },
      { membership_id: "m-admin", role: "club_admin", scope_team_id: null },
      { membership_id: "m-b", role: "club_admin", scope_team_id: null },
    ],
    licencies: [{ id: "lic-anis", club_id: CLUB_A.id, first_name: "Anis", last_name: "Coach", license_number: null, birth_date: null, email: null, phone: null, photo_url: null, active: true }],
    profiles: [{ user_id: "coord", display_name: "Claire" }],
    clubVenues: [
      { id: VENUE_A, club_id: CLUB_A.id, name: "Gymnase A", address: null, venue_id: FFBB_VENUE_A, active: true, sort_order: 0 },
      { id: VENUE_B, club_id: CLUB_A.id, name: "Gymnase B", address: null, venue_id: "ffbb-venue-b", active: true, sort_order: 1 },
    ],
    schedulingRules: [
      { club_id: CLUB_A.id, weekday: 6, earliest_start: "13:00:00", latest_start: "21:00:00" },
      { club_id: CLUB_A.id, weekday: 0, earliest_start: "09:00:00", latest_start: "16:00:00" },
    ],
    matches: [{ ...TARGET }, { ...SUNDAY_OTHER }, { ...U18_MATCH }, { ...PAST_MATCH }],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("création (scénario coach)", () => {
  it("Anis crée une demande : statut « Demande envoyée », nom snapshot, proposition, événement système + commentaire", async () => {
    const res = await createRequest();
    expect(res.status).toBe(201);
    const detail = await json<Detail>(res);
    expect(detail.status).toBe("REQUESTED");
    expect(detail.requesterDisplayName).toBe("Anis");
    expect(detail.requestedVenue?.name).toBe("Gymnase B");
    expect(detail.proposals).toHaveLength(1);
    expect(detail.messages.map((m) => [m.type, m.body])).toEqual([
      ["SYSTEM", "Anis a envoyé la demande : dimanche 11 octobre à 15:00 — Gymnase B."],
      ["USER", "L'équipe adverse nous propose cette date."],
    ]);
    expect(detail.messages[1]!.authorRoleLabel).toBe("Coach");
    // Snapshot de l'horaire officiel au moment de la demande.
    expect(state.derogationRequests[0]!.original_scheduled_at).toBe(TARGET.match_datetime);
  });

  it("409 DEROGATION_SLOT_CONFLICT : match programmé 15h–17h dans le même gymnase (détails inclus)", async () => {
    const res = await createRequest({ requestedVenueId: VENUE_A });
    expect(res.status).toBe(409);
    const body = await json<{ error: { code: string; message: string; details: { conflicts: { opponentName: string; venueName: string }[] } } }>(res);
    expect(body.error.code).toBe("DEROGATION_SLOT_CONFLICT");
    expect(body.error.message).toContain("15:00 → 17:00");
    expect(body.error.details.conflicts[0]).toMatchObject({ opponentName: "AGDE", venueName: "Gymnase A" });
    expect(state.derogationRequests).toHaveLength(0);
  });

  it("course : 17h disponible à la consultation, puis un match apparaît à 17h → la création est refusée", async () => {
    as("coach-u15");
    const availabilityRes = await request(`/matches/${TARGET.id}/derogation-availability?date=2026-10-10`);
    const availability = await json<{ venues: { venue: { id: string }; candidateStartTimes: { localStart: string; available: boolean }[] }[] }>(availabilityRes);
    expect(availabilityRes.status).toBe(200);
    const venueA = availability.venues.find((v) => v.venue.id === VENUE_A)!;
    expect(venueA.candidateStartTimes.find((c) => c.localStart === "17:00")!.available).toBe(true);

    state.matches.push({ ...SUNDAY_OTHER, id: "33333333-3333-4333-8333-000000000099", match_datetime: "2026-10-10T15:00:00.000Z" }); // samedi 17:00 Paris, synchronisé entre-temps

    const res = await createRequest({ requestedStartAt: "2026-10-10T17:00:00+02:00", requestedVenueId: VENUE_A });
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("DEROGATION_SLOT_CONFLICT");
  });

  it("400 hors plage horaire du samedi (12:00) et 400 gymnase manquant pour un match à domicile", async () => {
    const early = await createRequest({ requestedStartAt: "2026-10-10T12:00:00+02:00" });
    expect(early.status).toBe(400);
    expect((await json<{ error: { code: string } }>(early)).error.code).toBe("DEROGATION_SLOT_OUT_OF_RANGE");
    const noVenue = await createRequest({ requestedVenueId: null });
    expect((await json<{ error: { code: string } }>(noVenue)).error.code).toBe("DEROGATION_VENUE_REQUIRED");
  });

  it("coach U15 sur un match U18 → 403 ; match passé → 409 ; demande déjà active → 409", async () => {
    as("coach-u15");
    const u18 = await request("/derogation-requests", { method: "POST", body: { matchId: U18_MATCH.id, requestedStartAt: SUNDAY_15H, requestedVenueId: VENUE_B } });
    expect(u18.status).toBe(403);

    const past = await createRequest({ matchId: PAST_MATCH.id });
    expect((await json<{ error: { code: string } }>(past)).error.code).toBe("MATCH_NOT_UPCOMING");

    expect((await createRequest()).status).toBe(201);
    const duplicate = await createRequest({ requestedStartAt: "2026-10-11T10:00:00+02:00" });
    expect(duplicate.status).toBe(409);
    expect((await json<{ error: { code: string } }>(duplicate)).error.code).toBe("DEROGATION_REQUEST_ALREADY_ACTIVE");
  });

  it("aucun coordinateur configuré → envoi refusé avec le message attendu", async () => {
    state.roles = state.roles.filter((r) => r.role !== "correspondant_club");
    const res = await createRequest();
    expect(res.status).toBe(409);
    expect((await json<{ error: { message: string } }>(res)).error.message).toBe("Aucun coordinateur n'est actuellement configuré pour recevoir les demandes de dérogation.");
  });

  it("le contexte donne le nom réel du demandeur, les gymnases et uniquement les matchs futurs de ses équipes", async () => {
    as("coach-u15");
    const ctx = await json<{ requesterDisplayName: string; coordinatorsConfigured: boolean; venues: unknown[]; eligibleMatches: { id: string }[] }>(await request("/derogation-requests/context"));
    expect(ctx.requesterDisplayName).toBe("Anis");
    expect(ctx.coordinatorsConfigured).toBe(true);
    expect(ctx.venues).toHaveLength(2);
    expect(ctx.eligibleMatches.map((m) => m.id)).toEqual([TARGET.id]);
  });
});

describe("conversation et statuts (scénario complet du critère final)", () => {
  it("coach → coordinateur « pas possible » → coach répond et repropose → « Je m'en occupe » → « Traitée »", async () => {
    const created = await json<Detail>(await createRequest());
    const path = `/derogation-requests/${created.id}`;

    as("coord");
    const list = await json<{ requests: { id: string; needsCoordinatorAttention: boolean }[] }>(await request("/derogation-requests"));
    expect(list.requests[0]).toMatchObject({ id: created.id, needsCoordinatorAttention: true });

    const withoutMessage = await request(`${path}/actions`, { method: "POST", body: { action: "REQUEST_CHANGE" } });
    expect(withoutMessage.status).toBe(422);
    expect((await json<{ error: { code: string } }>(withoutMessage)).error.code).toBe("MESSAGE_REQUIRED");

    const refused = await json<Detail>(await request(`${path}/actions`, { method: "POST", body: { action: "REQUEST_CHANGE", message: "Ce n'est pas possible, le club adverse ne peut pas." } }));
    expect(refused.status).toBe("NEEDS_CHANGE");

    as("coach-u15");
    const seen = await json<Detail>(await request(path));
    expect(seen.messages.at(-1)).toMatchObject({ type: "USER", body: "Ce n'est pas possible, le club adverse ne peut pas.", authorDisplayName: "Claire", authorRoleLabel: "Coordinateur" });
    expect(seen.permissions.canPropose).toBe(true);
    expect(seen.permissions.actions).toEqual(["CANCEL"]);

    await request(`${path}/messages`, { method: "POST", body: { message: "OK, est-ce que samedi 17h fonctionne ?" } });
    const reproposed = await json<Detail>(await request(`${path}/proposals`, { method: "POST", body: { requestedStartAt: "2026-10-10T17:00:00+02:00", requestedVenueId: VENUE_A } }));
    expect(reproposed.status).toBe("REQUESTED");
    expect(reproposed.proposals).toHaveLength(2);
    expect(reproposed.messages.at(-1)!.body).toBe("Anis a proposé un nouveau créneau : samedi 10 octobre à 17:00 — Gymnase A.");

    as("coord");
    const inProgress = await json<Detail>(await request(`${path}/actions`, { method: "POST", body: { action: "TAKE_IN_CHARGE", message: "OK, je m'en occupe." } }));
    expect(inProgress.status).toBe("IN_PROGRESS");
    const done = await json<Detail>(await request(`${path}/actions`, { method: "POST", body: { action: "COMPLETE" } }));
    expect(done.status).toBe("COMPLETED");

    // Ordre chronologique stable, auteurs figés au moment du message.
    expect(done.messages.map((m) => `${m.type}:${m.event ?? ""}:${m.authorDisplayName}`)).toEqual([
      "SYSTEM:REQUEST_CREATED:Anis",
      "USER::Anis",
      "SYSTEM:CHANGE_REQUESTED:Claire",
      "USER::Claire",
      "USER::Anis",
      "SYSTEM:SLOT_PROPOSED:Anis",
      "SYSTEM:TAKEN_IN_CHARGE:Claire",
      "USER::Claire",
      "SYSTEM:COMPLETED:Claire",
    ]);

    // Une demande terminée libère le match pour une nouvelle demande.
    expect((await createRequest({ requestedStartAt: "2026-10-11T10:00:00+02:00" })).status).toBe(201);
  });

  it("le coach ne traite pas ; transitions invalides refusées ; le coach peut annuler", async () => {
    const created = await json<Detail>(await createRequest());
    const path = `/derogation-requests/${created.id}/actions`;
    as("coach-u15");
    expect((await request(path, { method: "POST", body: { action: "TAKE_IN_CHARGE" } })).status).toBe(403);
    as("coord");
    const invalid = await request(path, { method: "POST", body: { action: "COMPLETE" } });
    expect(invalid.status).toBe(409);
    expect((await json<{ error: { code: string } }>(invalid)).error.code).toBe("INVALID_TRANSITION");
    as("coach-u15");
    const cancelled = await json<Detail>(await request(path, { method: "POST", body: { action: "CANCEL" } }));
    expect(cancelled.status).toBe("CANCELLED");
    expect((await request(`/derogation-requests/${created.id}/messages`, { method: "POST", body: { message: "?" } })).status).toBe(409);
  });

  it("message vide refusé ; message > 3000 caractères refusé ; retours à la ligne conservés", async () => {
    const created = await json<Detail>(await createRequest());
    const path = `/derogation-requests/${created.id}/messages`;
    expect((await request(path, { method: "POST", body: { message: "   " } })).status).toBe(400);
    expect((await request(path, { method: "POST", body: { message: "x".repeat(3001) } })).status).toBe(400);
    const ok = await json<Detail>(await request(path, { method: "POST", body: { message: "Ligne 1\nLigne 2" } }));
    expect(ok.messages.at(-1)!.body).toBe("Ligne 1\nLigne 2");
  });
});

describe("permissions de lecture (§68, §102)", () => {
  it("coach sans rapport → 404 ; demandeur → OK ; coordinateur → OK ; club B → 404 même avec l'UUID", async () => {
    const created = await json<Detail>(await createRequest());
    as("coach-u18");
    expect((await request(`/derogation-requests/${created.id}`)).status).toBe(404);
    expect((await json<{ requests: unknown[] }>(await request("/derogation-requests"))).requests).toHaveLength(0);
    as("coach-u15");
    expect((await request(`/derogation-requests/${created.id}`)).status).toBe(200);
    as("coord");
    expect((await request(`/derogation-requests/${created.id}`)).status).toBe(200);
    as("user-b");
    expect((await request(`/derogation-requests/${created.id}`)).status).toBe(404);
    const viaClubB = await app.request(`/v1/clubs/${CLUB_B.id}/derogation-requests/${created.id}`, { headers: { authorization: "Bearer test-jwt" } });
    expect(viaClubB.status).toBe(404);
  });
});

describe("disponibilité des gymnases", () => {
  it("dimanche : grille 09:00→16:00, match existant affiché, demande en cours en avertissement (soft)", async () => {
    await createRequest(); // vise Gymnase B dimanche 15h
    as("admin");
    const res = await request(`/matches/${U18_MATCH.id}/derogation-availability?date=2026-10-11`);
    const body = await json<{
      matchType: string;
      rules: { earliestStart: string; latestStart: string; durationMinutes: number };
      venues: { venue: { id: string }; existingMatches: { opponentName: string; localStart: string; localEnd: string }[]; pendingRequests: unknown[]; candidateStartTimes: { localStart: string; available: boolean; warnings: unknown[]; conflicts: unknown[] }[] }[];
    }>(res);
    expect(body.matchType).toBe("HOME");
    expect(body.rules).toMatchObject({ earliestStart: "09:00", latestStart: "16:00", durationMinutes: 120 });
    const a = body.venues.find((v) => v.venue.id === VENUE_A)!;
    const b = body.venues.find((v) => v.venue.id === VENUE_B)!;
    expect(a.existingMatches).toEqual([expect.objectContaining({ opponentName: "AGDE", localStart: "15:00", localEnd: "17:00" })]);
    expect(a.candidateStartTimes.find((c) => c.localStart === "14:00")!.available).toBe(false);
    expect(a.candidateStartTimes.find((c) => c.localStart === "13:00")!.available).toBe(true);
    const b15 = b.candidateStartTimes.find((c) => c.localStart === "15:00")!;
    expect(b15.available).toBe(true);
    expect(b15.warnings).toHaveLength(1);
    expect(b.pendingRequests).toHaveLength(1);
  });

  it("le match cible est exclu de sa propre occupation ; vérification serveur d'une heure personnalisée", async () => {
    as("coach-u15");
    const sat = await json<{ venues: { venue: { id: string }; existingMatches: unknown[]; candidateStartTimes: { localStart: string; available: boolean }[] }[] }>(await request(`/matches/${TARGET.id}/derogation-availability?date=2026-10-03`));
    expect(sat.venues.find((v) => v.venue.id === VENUE_A)!.existingMatches).toHaveLength(0);
    expect(sat.venues.find((v) => v.venue.id === VENUE_A)!.candidateStartTimes.find((c) => c.localStart === "18:00")!.available).toBe(true);

    const bad = await json<{ ok: boolean; code: string }>(await request(`/matches/${TARGET.id}/derogation-slot-check?startAt=${encodeURIComponent("2026-10-11T16:30:00+02:00")}&venueId=${VENUE_A}`));
    expect(bad).toMatchObject({ ok: false, code: "DEROGATION_SLOT_OUT_OF_RANGE" });
    const conflictCheck = await json<{ ok: boolean; code: string; conflicts: unknown[] }>(await request(`/matches/${TARGET.id}/derogation-slot-check?startAt=${encodeURIComponent("2026-10-11T14:30:00+02:00")}&venueId=${VENUE_A}`));
    expect(conflictCheck.ok).toBe(false);
    expect(conflictCheck.conflicts).toHaveLength(1);
  });

  it("un coach ne consulte pas la disponibilité d'une équipe qu'il n'encadre pas", async () => {
    as("coach-u15");
    expect((await request(`/matches/${U18_MATCH.id}/derogation-availability?date=2026-10-11`)).status).toBe(403);
  });
});

describe("aucune écriture externe (§94, §106)", () => {
  it("créer, répondre, changer de statut ne modifient jamais les matchs, n'enfilent aucun job FBI et n'appellent aucun service externe", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const matchesBefore = JSON.stringify(state.matches);

    const created = await json<Detail>(await createRequest());
    as("coord");
    await request(`/derogation-requests/${created.id}/messages`, { method: "POST", body: { message: "Je regarde." } });
    await request(`/derogation-requests/${created.id}/actions`, { method: "POST", body: { action: "TAKE_IN_CHARGE" } });
    await request(`/derogation-requests/${created.id}/actions`, { method: "POST", body: { action: "COMPLETE" } });

    expect(JSON.stringify(state.matches)).toBe(matchesBefore);
    expect(state.fbiJobs).toHaveLength(0);
    expect(state.fbiDerogationChecks).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
