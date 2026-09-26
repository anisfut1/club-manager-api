import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";

let state: FakeClubSupabaseState;
const currentUserId = "user-a";

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
  return app.request(`/v1/clubs${path}`, { ...init, headers: { authorization: "Bearer test-jwt", "content-type": "application/json", ...init.headers } });
}

beforeEach(() => {
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }],
    memberships: [{ id: "membership-a1", club_id: CLUB_A.id, user_id: "user-a", status: "active" }],
    roles: [{ membership_id: "membership-a1", role: "club_admin" }],
  });
});

describe("GET /:clubId/derogations (voir docs/FBI.md)", () => {
  it("renvoie une liste vide pour un club sans dérogation connue (jamais une erreur)", async () => {
    const res = await request(`/${CLUB_A.id}/derogations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ derogations: [] });
  });

  it("renvoie toutes les dérogations connues, enrichies du match FFBB correspondant", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "1",
        journee: null,
        match_datetime: "2026-09-26T13:30:00.000Z",
        is_home: true,
        opponent_name: "Castelnau Basket - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
      },
    ];
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
        demandeur: null,
        motif: null,
        date_rencontre_demandee: null,
        heure_demandee: null,
        adversaire: null,
        date_reponse: null,
        acceptation: null,
        motif_refus: null,
        checked_at: "2026-09-25T16:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations).toHaveLength(1);
    expect(body.derogations[0]).toMatchObject({
      id: "check-1",
      matchId: "match-1",
      opponentName: "Castelnau Basket - 2",
      matchDatetime: "2026-09-26T13:30:00.000Z",
      numero: "1",
      etat: "A Créer",
    });
  });

  it("inclut le détail (motif, dates demandées, réponse adversaire) quand la page de détail a été consultée ('il me faut du détail sur le motif... comme sur fbi')", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "1",
        journee: null,
        match_datetime: "2026-09-26T13:30:00.000Z",
        is_home: true,
        opponent_name: "Castelnau Basket - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
      },
    ];
    state.fbiDerogationChecks = [
      {
        id: "check-1",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "1",
        etat: "En Cours",
        date_depot: "19/08/2026 17:42",
        date_derogation: null,
        date_rencontre: "26/09/2026",
        heure: "15:30",
        domicile: "SPORT CLUB DE SETE BASKET - 1",
        visiteur: "CASTELNAU BASKET - 2",
        demandeur: "Domicile",
        motif: "Gymnase indisponible ce jour-là",
        date_rencontre_demandee: "03/10/2026",
        heure_demandee: "20:00",
        adversaire: "CASTELNAU BASKET",
        date_reponse: null,
        acceptation: null,
        motif_refus: null,
        checked_at: "2026-09-25T16:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations[0]).toMatchObject({
      demandeur: "Domicile",
      motif: "Gymnase indisponible ce jour-là",
      dateRencontreDemandee: "03/10/2026",
      heureDemandee: "20:00",
      adversaire: "CASTELNAU BASKET",
      dateReponse: null,
      acceptation: null,
      motifRefus: null,
    });
  });

  it("enrichit la dérogation de la catégorie FFBB du match (competitions.category_label, jamais le code de division cryptique)", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "23",
        journee: null,
        match_datetime: "2026-10-10T13:30:00.000Z",
        is_home: true,
        opponent_name: "FO PISCENOIS - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: "competition-u11",
      },
    ];
    state.competitions = [{ id: "competition-u11", category_label: "U11" }];
    state.fbiDerogationChecks = [
      {
        id: "check-1",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "23",
        etat: "Acceptée par l'organisme dirigeant",
        date_depot: null,
        date_derogation: null,
        date_rencontre: "10/10/2026",
        heure: null,
        domicile: "FO PISCENOIS - 2",
        visiteur: "SPORT CLUB DE SETE BASKET - 1",
        checked_at: "2026-09-26T16:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations[0]).toMatchObject({ categoryLabel: "U11" });
  });

  it("categoryLabel reste `null` si le match n'a pas de compétition connue", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "1",
        journee: null,
        match_datetime: "2026-09-26T13:30:00.000Z",
        is_home: true,
        opponent_name: "Castelnau Basket - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: null,
      },
    ];
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

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations[0]).toMatchObject({ categoryLabel: null });
  });

  it("enrichit la dérogation du nom de l'ÉQUIPE du club (teams.name) — distingue les 4 équipes seniors, pas juste la catégorie", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "9503",
        journee: null,
        match_datetime: "2026-10-10T13:30:00.000Z",
        is_home: true,
        opponent_name: "Castelnau Basket - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: "team-seniors-2",
        competition_id: "competition-seniors-d2",
      },
    ];
    state.competitions = [{ id: "competition-seniors-d2", category_label: "Seniors" }];
    state.teams = [{ id: "team-seniors-2", club_id: CLUB_A.id, name: "Seniors 2" }];
    state.fbiDerogationChecks = [
      {
        id: "check-1",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "9503",
        etat: "En Cours",
        date_depot: null,
        date_derogation: null,
        date_rencontre: "10/10/2026",
        heure: null,
        domicile: "SPORT CLUB DE SETE BASKET - 2",
        visiteur: "CASTELNAU BASKET - 2",
        checked_at: "2026-09-26T16:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations[0]).toMatchObject({ categoryLabel: "Seniors", teamName: "Seniors 2" });
  });

  it("teamName reste `null` si le match n'a pas d'équipe du club associée", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "1",
        journee: null,
        match_datetime: "2026-09-26T13:30:00.000Z",
        is_home: true,
        opponent_name: "Castelnau Basket - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: null,
      },
    ];
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

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations[0]).toMatchObject({ teamName: null });
  });

  it("signale un conflit de créneau quand la date/heure DEMANDÉE chevauche le créneau (2h) d'un AUTRE match déjà prévu ('un créneau de match est de 2h')", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "1",
        journee: null,
        match_datetime: "2026-10-03T13:00:00.000Z",
        is_home: true,
        opponent_name: "Castelnau Basket - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: null,
      },
      {
        // Déjà prévu 10/10/2026 15:00 heure de Paris (13:00 UTC, CEST) — son créneau va jusqu'à 17h.
        id: "match-2",
        club_id: CLUB_A.id,
        numero: "23",
        journee: null,
        match_datetime: "2026-10-10T13:00:00.000Z",
        is_home: true,
        opponent_name: "FO PISCENOIS - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: null,
      },
    ];
    state.fbiDerogationChecks = [
      {
        id: "check-1",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "1",
        etat: "En Cours",
        date_depot: "19/08/2026 17:42",
        date_derogation: null,
        date_rencontre: "26/09/2026",
        heure: "15:30",
        domicile: "SPORT CLUB DE SETE BASKET - 1",
        visiteur: "CASTELNAU BASKET - 2",
        // 10/10/2026 16:00 — tombe dans le créneau 15h-17h de match-2.
        date_rencontre_demandee: "10/10/2026",
        heure_demandee: "16:00",
        checked_at: "2026-09-26T16:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations[0]).toMatchObject({
      scheduleConflict: { matchId: "match-2", numero: "23", opponentName: "FO PISCENOIS - 2", matchDatetime: "2026-10-10T13:00:00.000Z" },
    });
  });

  it("jamais de conflit entre un match à DOMICILE et un match à l'EXTÉRIEUR même créneau (demande du club, 2026-09-27 : \"palavas sete c un match a lextérieur... si ya 1 match domicile 1 extérieur meme heure c pas un soucis\") — seul un match à domicile occupe une salle du club", async () => {
    state.matches = [
      {
        // Dérogation à domicile demandant 10/10/2026 16:00 (créneau 16h-18h).
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "1",
        journee: null,
        match_datetime: "2026-10-03T13:00:00.000Z",
        is_home: true,
        opponent_name: "Castelnau Basket - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: null,
      },
      {
        // Match à L'EXTÉRIEUR au même créneau (10/10/2026 15h-17h) — chez
        // l'adversaire, jamais dans une salle du club : aucun conflit possible.
        id: "match-2-away",
        club_id: CLUB_A.id,
        numero: "23",
        journee: null,
        match_datetime: "2026-10-10T13:00:00.000Z",
        is_home: false,
        opponent_name: "PALAVAS BASKET CLUB - 1",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: null,
      },
    ];
    state.fbiDerogationChecks = [
      {
        id: "check-1",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "1",
        etat: "En Cours",
        date_depot: "19/08/2026 17:42",
        date_derogation: null,
        date_rencontre: "26/09/2026",
        heure: "15:30",
        domicile: "SPORT CLUB DE SETE BASKET - 1",
        visiteur: "CASTELNAU BASKET - 2",
        date_rencontre_demandee: "10/10/2026",
        heure_demandee: "16:00",
        checked_at: "2026-09-26T16:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations[0]).toMatchObject({ scheduleConflict: null });
  });

  it("jamais de conflit signalé pour la dérogation d'un match À L'EXTÉRIEUR, même si sa nouvelle heure chevauche un match à domicile (déplacer un match extérieur n'affecte jamais une salle du club)", async () => {
    state.matches = [
      {
        // Dérogation sur un match à l'EXTÉRIEUR.
        id: "match-away",
        club_id: CLUB_A.id,
        numero: "1",
        journee: null,
        match_datetime: "2026-10-03T13:00:00.000Z",
        is_home: false,
        opponent_name: "Castelnau Basket - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: null,
      },
      {
        id: "match-home",
        club_id: CLUB_A.id,
        numero: "23",
        journee: null,
        match_datetime: "2026-10-10T13:00:00.000Z",
        is_home: true,
        opponent_name: "FO PISCENOIS - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: null,
      },
    ];
    state.fbiDerogationChecks = [
      {
        id: "check-1",
        club_id: CLUB_A.id,
        match_id: "match-away",
        numero: "1",
        etat: "En Cours",
        date_depot: "19/08/2026 17:42",
        date_derogation: null,
        date_rencontre: "26/09/2026",
        heure: "15:30",
        domicile: "CASTELNAU BASKET - 2",
        visiteur: "SPORT CLUB DE SETE BASKET - 1",
        date_rencontre_demandee: "10/10/2026",
        heure_demandee: "16:00",
        checked_at: "2026-09-26T16:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations[0]).toMatchObject({ scheduleConflict: null });
  });

  it("jamais d'alerte de conflit pour une dérogation Refusée (la date demandée n'a jamais pris effet)", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "1",
        journee: null,
        match_datetime: "2026-10-03T13:00:00.000Z",
        is_home: true,
        opponent_name: "Castelnau Basket - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: null,
      },
      {
        id: "match-2",
        club_id: CLUB_A.id,
        numero: "23",
        journee: null,
        match_datetime: "2026-10-10T13:00:00.000Z",
        is_home: true,
        opponent_name: "FO PISCENOIS - 2",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
        competition_id: null,
      },
    ];
    state.fbiDerogationChecks = [
      {
        id: "check-1",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "1",
        etat: "Refusée",
        date_depot: "19/08/2026 17:42",
        date_derogation: null,
        date_rencontre: "26/09/2026",
        heure: "15:30",
        domicile: "SPORT CLUB DE SETE BASKET - 1",
        visiteur: "CASTELNAU BASKET - 2",
        date_rencontre_demandee: "10/10/2026",
        heure_demandee: "16:00",
        checked_at: "2026-09-26T16:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/derogations`);
    const body = await res.json();

    expect(body.derogations[0]).toMatchObject({ scheduleConflict: null });
  });

  it("un coach reçoit 403 (réservé au club_admin, cohérent avec la policy RLS de lecture)", async () => {
    state.roles = [{ membership_id: "membership-a1", role: "coach" }];

    const res = await request(`/${CLUB_A.id}/derogations`);

    expect(res.status).toBe(403);
  });
});
