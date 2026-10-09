import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";
import { hashPublicToken } from "../public-tables/token.js";

/**
 * Vie d'équipe — Lot 1 : entraînements (retour du club, 2026-10-09).
 * Espace club (comptes) et espace public (lien personnel). Données fictives.
 */
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
const U15F = "11111111-1111-4111-8111-000000000015";
const U11M = "11111111-1111-4111-8111-000000000011";
const VENUE = "22222222-2222-4222-8222-00000000000a";

function lic(id: string, firstName: string, teamId: string | null, extra: Partial<FakeLicencieRow> = {}): FakeLicencieRow {
  return { id, club_id: CLUB_A.id, first_name: firstName, last_name: "MARTIN", license_number: null, birth_date: null, email: null, phone: null, photo_url: null, active: true, team_id: teamId, ...extra };
}

function club(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}/team-life${path}`, { method: init.method ?? "GET", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
function pub(path: string, init: { method?: string; body?: unknown; token?: string; slug?: string } = {}) {
  const q = init.token ? `${path.includes("?") ? "&" : "?"}token=${init.token}` : "";
  return app.request(`/v1/public/clubs/${init.slug ?? "club-a"}/team-life${path}${q}`, { method: init.method ?? "GET", headers: { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const json = async <T>(res: Response) => (await res.json()) as T;

interface Occ {
  id: string;
  startsAt: string;
  status: string;
  isModified: boolean;
  counts: { present: number; absent: number; uncertain: number; noResponse: number; total: number } | null;
  team: { id: string };
}

const WEEK = { startsOn: "2026-10-06", endsOn: "2026-10-31", slots: [{ weekday: 2, startTime: "19:00", endTime: "20:30", clubVenueId: VENUE }, { weekday: 4, startTime: "19:00", endTime: "20:30", clubVenueId: VENUE }] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T08:00:00.000Z"));
  currentUserId = "coach-u15";
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    teams: [
      { id: U15F, club_id: CLUB_A.id, name: "U15", sexe: "F", active: true },
      { id: U11M, club_id: CLUB_A.id, name: "U11", sexe: "M", active: true },
    ],
    memberships: [
      { id: "m-coach15", club_id: CLUB_A.id, user_id: "coach-u15", status: "active" },
      { id: "m-coach11", club_id: CLUB_A.id, user_id: "coach-u11", status: "active" },
      { id: "m-b", club_id: CLUB_B.id, user_id: "admin-b", status: "active" },
    ],
    roles: [
      { membership_id: "m-coach15", role: "coach", scope_team_id: U15F },
      { membership_id: "m-coach11", role: "coach", scope_team_id: U11M },
      { membership_id: "m-b", role: "club_admin", scope_team_id: null },
    ],
    clubVenues: [{ id: VENUE, club_id: CLUB_A.id, name: "Gymnase Maurice Clavel", address: "22 rue Maurice Clavel", venue_id: null, active: true, sort_order: 0 }],
    licencies: [
      lic("lina", "Lina", U15F),
      lic("sarah", "Sarah", U15F),
      lic("mathis", "Mathis", U11M),
      lic("coach-lic", "Claire", null, { public_coach: true, coached_team_ids: [U15F] }),
    ],
  });
  state.publicTokens = ["lina", "mathis", "coach-lic"].map((id) => ({ id: `tok-${id}`, club_id: CLUB_A.id, licencie_id: id, token_hash: hashPublicToken(`token-${id}`), email: null, created_at: "2026-10-01T00:00:00Z", revoked_at: null, revoked_by: null }));
});

afterEach(() => vi.useRealTimers());

describe("Planifier les entraînements (coach, espace club)", () => {
  it("toute la semaine en un envoi : mardi + jeudi 19:00–20:30, séances générées jusqu'à la fin de la période", async () => {
    const res = await club(`/teams/${U15F}/training-series`, { method: "POST", body: WEEK });
    expect(res.status).toBe(201);
    const { series } = await json<{ series: { weekday: number; startTime: string; location: { label: string }; upcomingCount: number }[] }>(res);
    expect(series.map((s) => [s.weekday, s.startTime, s.location.label, s.upcomingCount])).toEqual([
      [2, "19:00", "Gymnase Maurice Clavel", 4],
      [4, "19:00", "Gymnase Maurice Clavel", 4],
    ]);
    expect(state.trainingOccurrences).toHaveLength(8);
    const { trainings } = await json<{ trainings: Occ[] }>(await club(`/trainings?teamId=${U15F}&from=2026-10-05T00:00:00Z&to=2026-11-01T00:00:00Z`));
    expect(trainings[0]!.startsAt).toBe("2026-10-06T17:00:00.000Z");
    expect(trainings.at(-1)!.startsAt).toBe("2026-10-29T18:00:00.000Z"); // heure d'hiver
    expect(trainings[0]!.counts).toEqual({ present: 0, absent: 0, uncertain: 0, noResponse: 2, total: 2 });
  });

  it("un coach ne planifie que son équipe (403 sur une autre) ; un autre club ne voit rien", async () => {
    currentUserId = "coach-u11";
    expect((await club(`/teams/${U15F}/training-series`, { method: "POST", body: WEEK })).status).toBe(403);
    currentUserId = "admin-b";
    expect((await app.request(`/v1/clubs/${CLUB_B.id}/team-life/teams/${U15F}/training-series`, { headers: { authorization: "Bearer t" } })).status).toBe(404);
  });

  it("modifier le créneau à partir du 20 octobre : les séances passées et avant cette date ne bougent pas, une séance modifiée à la main non plus", async () => {
    await club(`/teams/${U15F}/training-series`, { method: "POST", body: WEEK });
    const tuesday = state.trainingSeries.find((s) => s.weekday === 2)!;
    const thursday15 = state.trainingOccurrences.find((o) => o.series_date === "2026-10-15")!;
    await club(`/trainings/${thursday15.id}`, { method: "PATCH", body: { date: "2026-10-14", startTime: "18:30", endTime: "20:00" } });

    const res = await club(`/training-series/${tuesday.id}`, { method: "PATCH", body: { fromDate: "2026-10-20", startTime: "19:30", endTime: "21:00" } });
    expect(res.status).toBe(200);
    const tue = (d: string) => state.trainingOccurrences.find((o) => o.series_date === d && new Date(o.starts_at as string).getUTCDay() === 2)!;
    expect(tue("2026-10-13").starts_at).toBe("2026-10-13T17:00:00.000Z");
    expect(tue("2026-10-20").starts_at).toBe("2026-10-20T17:30:00.000Z");
    expect(tue("2026-10-27").starts_at).toBe("2026-10-27T18:30:00.000Z");
    expect(state.trainingOccurrences.find((o) => o.id === thursday15.id)).toMatchObject({ starts_at: "2026-10-14T16:30:00.000Z", is_modified: true });
    expect(state.trainingOccurrences).toHaveLength(8);
  });

  it("annuler une séance : elle reste visible « annulée », plus de réponse possible ; rétablir la remet", async () => {
    await club(`/teams/${U15F}/training-series`, { method: "POST", body: WEEK });
    const occ = state.trainingOccurrences.find((o) => o.series_date === "2026-10-13")!;
    const cancelled = await json<Occ & { cancelReason: string }>(await club(`/trainings/${occ.id}/cancel`, { method: "POST", body: { reason: "Gymnase fermé" } }));
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Gymnase fermé" });
    expect((await pub(`/trainings/${occ.id}/response`, { method: "PUT", token: "token-lina", body: { response: "PRESENT" } })).status).toBe(409);
    expect((await json<Occ>(await club(`/trainings/${occ.id}/restore`, { method: "POST" }))).status).toBe("scheduled");
  });

  it("supprimer le créneau : séances futures retirées, celles où quelqu'un a répondu sont annulées (jamais supprimées en silence)", async () => {
    await club(`/teams/${U15F}/training-series`, { method: "POST", body: WEEK });
    const tuesday = state.trainingSeries.find((s) => s.weekday === 2)!;
    const answered = state.trainingOccurrences.find((o) => o.series_date === "2026-10-20")!;
    await pub(`/trainings/${answered.id}/response`, { method: "PUT", token: "token-lina", body: { response: "PRESENT" } });
    await club(`/training-series/${tuesday.id}?from=2026-10-10`, { method: "DELETE" });
    const tuesdays = state.trainingOccurrences.filter((o) => o.series_id === tuesday.id);
    expect(tuesdays.map((o) => [o.series_date, o.status])).toEqual([
      ["2026-10-06", "scheduled"],
      ["2026-10-20", "cancelled"],
    ]);
  });
});

describe("Répondre et Home « À faire » (lien personnel)", () => {
  beforeEach(async () => {
    await club(`/teams/${U15F}/training-series`, { method: "POST", body: WEEK });
    // Le coach U15 ne gère pas les U11 : c'est leur coach qui planifie.
    currentUserId = "coach-u11";
    await club(`/teams/${U11M}/training-series`, { method: "POST", body: { startsOn: "2026-10-06", endsOn: "2026-10-31", slots: [{ weekday: 3, startTime: "17:30", endTime: "19:00", locationLabel: "Gymnase du Barrou" }] } });
  });

  it("un parent avec deux enfants voit les entraînements de chacun, répond en un clic, et l'action passe en « répondue »", async () => {
    const home = await json<{ people: { firstName: string; tokenIndex: number }[]; actions: { type: string; firstName: string; currentResponse: string | null; training: { id: string; counts: unknown; location: { label: string } } }[] }>(
      await pub("/action-center", { method: "POST", body: { tokens: ["token-lina", "token-mathis"] } }),
    );
    expect(home.people.map((p) => [p.firstName, p.tokenIndex]).sort()).toEqual([
      ["Lina", 0],
      ["Mathis", 1],
    ]);
    const lina = home.actions.filter((a) => a.type === "TRAINING_RESPONSE" && a.firstName === "Lina");
    const mathis = home.actions.filter((a) => a.type === "TRAINING_RESPONSE" && a.firstName === "Mathis");
    expect(lina).toHaveLength(3);
    expect(mathis[0]!.training.location.label).toBe("Gymnase du Barrou");
    // Un parent ne voit jamais les réponses des autres enfants.
    expect(home.actions.every((a) => a.training.counts === null)).toBe(true);

    const res = await pub(`/trainings/${lina[0]!.training.id}/response`, { method: "PUT", token: "token-lina", body: { response: "PRESENT" } });
    expect(res.status).toBe(200);
    expect(state.trainingResponses[0]).toMatchObject({ licencie_id: "lina", response: "PRESENT", responded_by_licencie_id: "lina", responded_by_user_id: null });

    const after = await json<{ actions: { firstName: string; currentResponse: string | null; training: { id: string } }[] }>(await pub("/action-center", { method: "POST", body: { tokens: ["token-lina", "token-mathis"] } }));
    expect(after.actions.find((a) => a.training.id === lina[0]!.training.id && a.firstName === "Lina")!.currentResponse).toBe("PRESENT");

    // Changer d'avis : Présente → Absente (une seule réponse conservée).
    await pub(`/trainings/${lina[0]!.training.id}/response`, { method: "PUT", token: "token-lina", body: { response: "ABSENT" } });
    expect(state.trainingResponses).toHaveLength(1);
    expect(state.trainingResponses[0]!.response).toBe("ABSENT");
  });

  it("jamais pour quelqu'un d'une autre équipe ; un lien d'un autre club ne marche pas", async () => {
    const u15 = state.trainingOccurrences.find((o) => o.team_id === U15F)!;
    expect((await pub(`/trainings/${u15.id}/response`, { method: "PUT", token: "token-mathis", body: { response: "PRESENT" } })).status).toBe(403);
    expect((await pub(`/trainings/${u15.id}/response`, { method: "PUT", token: "token-lina", slug: "club-b", body: { response: "PRESENT" } })).status).toBe(401);
  });

  it("coach (lien personnel) : résumé des réponses de son équipe sur la Home, détail nominatif ; un parent n'a pas accès au détail", async () => {
    const u15 = state.trainingOccurrences.filter((o) => o.team_id === U15F).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))[0]!;
    await pub(`/trainings/${u15.id}/response`, { method: "PUT", token: "token-lina", body: { response: "PRESENT" } });
    const home = await json<{ actions: { type: string; training: { id: string; counts: unknown } }[] }>(await pub("/action-center", { method: "POST", body: { tokens: ["token-coach-lic"] } }));
    const summary = home.actions.find((a) => a.type === "COACH_TRAINING_SUMMARY")!;
    expect(summary.training).toMatchObject({ id: u15.id, counts: { present: 1, absent: 0, uncertain: 0, noResponse: 1, total: 2 } });

    const detail = await json<{ roster: { licencie: { firstName: string }; response: string | null }[] }>(await pub(`/trainings/${u15.id}`, { token: "token-coach-lic" }));
    expect(detail.roster.map((r) => [r.licencie.firstName, r.response])).toEqual([
      ["Lina", "PRESENT"],
      ["Sarah", null],
    ]);
    expect((await pub(`/trainings/${u15.id}`, { token: "token-lina" })).status).toBe(403);
    // Le coach planifie depuis l'espace public, seulement ses équipes.
    expect((await pub(`/teams/${U11M}/training-series`, { method: "POST", token: "token-coach-lic", body: WEEK })).status).toBe(403);
    // Page « Entraînements » du coach : séances de son équipe avec compteurs ; jamais pour un parent.
    const list = await json<{ trainings: Occ[] }>(await pub(`/teams/${U15F}/trainings`, { token: "token-coach-lic" }));
    expect(list.trainings.find((t) => t.id === u15.id)?.counts).toMatchObject({ present: 1, total: 2 });
    expect((await pub(`/teams/${U15F}/trainings`, { token: "token-lina" })).status).toBe(403);
  });

  it("planning : matchs FFBB + entraînements de l'équipe, dans une seule liste", async () => {
    state.matches = [{ id: "m1", club_id: CLUB_A.id, numero: "1", journee: null, match_datetime: "2026-10-10T16:00:00.000Z", is_home: false, opponent_name: "AGDE", venue_raw_label: "Gymnase Agde", score_home: null, score_away: null, status: "scheduled", emarque_status: "not_applicable", team_id: U15F }];
    const res = await json<{ events: { kind: string; title: string; startsAt: string }[] }>(await pub("/planning?from=2026-10-05T00:00:00Z&to=2026-10-12T00:00:00Z", { method: "POST", body: { tokens: ["token-lina"] } }));
    expect(res.events.map((e) => [e.kind, e.title])).toEqual([
      ["TRAINING", "Entraînement"],
      ["TRAINING", "Entraînement"],
      ["MATCH", "AGDE"],
    ]);
  });
});
