import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";
import { conflict, notFound } from "../../api-error.js";

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

const { mockCheckDerogationForMatchSync } = vi.hoisted(() => ({ mockCheckDerogationForMatchSync: vi.fn() }));
vi.mock("../derogations/check-derogation-sync.js", () => ({ checkDerogationForMatchSync: mockCheckDerogationForMatchSync }));

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

// Zod v4 `.uuid()` exige les nibbles de version/variant RFC 4122
// ([1-8] puis [89ab]) — un placeholder "tout répété" comme
// "11111111-0000-..." échoue la validation et casse §20 avec un faux 400.
const TEAM_A = { id: "11111111-1111-4111-8111-111111111111", club_id: CLUB_A.id, name: "Seniors M" };
const TEAM_B = { id: "22222222-2222-4222-8222-222222222222", club_id: CLUB_B.id, name: "Seniors F" };

function match(overrides: Partial<(typeof state.matches)[number]>): (typeof state.matches)[number] {
  return {
    id: `match-${Math.random().toString(36).slice(2)}`,
    club_id: CLUB_A.id,
    numero: "1",
    journee: "1",
    match_datetime: "2026-01-10T18:00:00.000Z",
    is_home: true,
    opponent_name: "Adversaire",
    venue_raw_label: "Gymnase",
    score_home: null,
    score_away: null,
    status: "scheduled",
    emarque_status: "not_applicable",
    team_id: TEAM_A.id,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}/matches${path}`, {
    ...init,
    headers: { authorization: "Bearer test-jwt", "content-type": "application/json", ...init.headers },
  });
}

beforeEach(() => {
  currentUserId = "user-a";
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    memberships: [{ id: "membership-a1", club_id: CLUB_A.id, user_id: "user-a", status: "active" }],
    roles: [{ membership_id: "membership-a1", role: "joueur" }],
    teams: [TEAM_A, TEAM_B],
  });
});

describe("GET /v1/clubs/:clubId/matches — filtres (gap 7 de la demande)", () => {
  it("filtre par homeAway", async () => {
    state.matches = [match({ id: "home-1", is_home: true }), match({ id: "away-1", is_home: false })];
    const res = await request("?homeAway=away");
    const body = await res.json();
    expect(body.matches.map((m: { id: string }) => m.id)).toEqual(["away-1"]);
  });

  it("filtre par status", async () => {
    state.matches = [match({ id: "played-1", status: "played" }), match({ id: "scheduled-1", status: "scheduled" })];
    const res = await request("?status=played");
    const body = await res.json();
    expect(body.matches.map((m: { id: string }) => m.id)).toEqual(["played-1"]);
  });

  it("filtre par from/to (plage explicite)", async () => {
    state.matches = [
      match({ id: "early", match_datetime: "2026-01-01T10:00:00.000Z" }),
      match({ id: "mid", match_datetime: "2026-01-15T10:00:00.000Z" }),
      match({ id: "late", match_datetime: "2026-02-01T10:00:00.000Z" }),
    ];
    const res = await request("?from=2026-01-10T00:00:00Z&to=2026-01-20T00:00:00Z");
    const body = await res.json();
    expect(body.matches.map((m: { id: string }) => m.id)).toEqual(["mid"]);
  });

  it("rejette period ET from/to en même temps (mutuellement exclusifs)", async () => {
    const res = await request("?period=weekend&from=2026-01-10T00:00:00Z");
    expect(res.status).toBe(400);
  });

  it("§20 de la demande — teamId d'un AUTRE club ne fuit jamais : réponse vide, jamais une erreur ni un indice d'existence", async () => {
    state.matches = [match({ id: "match-a", team_id: TEAM_A.id })];
    const res = await request(`?teamId=${TEAM_B.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toEqual([]);
  });

  it("rejette un teamId mal formé (pas un UUID)", async () => {
    const res = await request("?teamId=not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("derogationStatus : catégorise chaque état FBI réel connu pour un badge coloré (demande du club : \"acceptée = vert en cours = orange refusée = rouge\"), jamais \"A Créer\" (état de bruit, voir docs/FBI.md) ni un état inconnu", async () => {
    state.matches = [
      match({ id: "match-en-cours" }),
      match({ id: "match-a-creer" }),
      match({ id: "match-acceptee-organisme" }),
      match({ id: "match-acceptee-deux-assos" }),
      match({ id: "match-refusee" }),
      match({ id: "match-sans-derog" }),
    ];
    state.fbiDerogationChecks = [
      { id: "check-1", club_id: CLUB_A.id, match_id: "match-en-cours", numero: "1", etat: "En Cours", date_depot: null, date_derogation: null, date_rencontre: null, heure: null, domicile: null, visiteur: null, checked_at: "2026-09-26T16:00:00.000Z" },
      { id: "check-2", club_id: CLUB_A.id, match_id: "match-a-creer", numero: "2", etat: "A Créer", date_depot: null, date_derogation: null, date_rencontre: null, heure: null, domicile: null, visiteur: null, checked_at: "2026-09-26T16:00:00.000Z" },
      { id: "check-3", club_id: CLUB_A.id, match_id: "match-acceptee-organisme", numero: "3", etat: "Acceptée par l'organisme dirigeant", date_depot: null, date_derogation: null, date_rencontre: null, heure: null, domicile: null, visiteur: null, checked_at: "2026-09-26T16:00:00.000Z" },
      { id: "check-4", club_id: CLUB_A.id, match_id: "match-acceptee-deux-assos", numero: "4", etat: "Acceptée par les deux associations sportives", date_depot: null, date_derogation: null, date_rencontre: null, heure: null, domicile: null, visiteur: null, checked_at: "2026-09-26T16:00:00.000Z" },
      { id: "check-5", club_id: CLUB_A.id, match_id: "match-refusee", numero: "5", etat: "Refusée", date_depot: null, date_derogation: null, date_rencontre: null, heure: null, domicile: null, visiteur: null, checked_at: "2026-09-26T16:00:00.000Z" },
    ];

    const res = await request("");
    const body = await res.json();
    const statusById = new Map(body.matches.map((m: { id: string; derogationStatus: string | null }) => [m.id, m.derogationStatus]));

    expect(statusById.get("match-en-cours")).toBe("en_cours");
    expect(statusById.get("match-a-creer")).toBeNull();
    expect(statusById.get("match-acceptee-organisme")).toBe("acceptee");
    expect(statusById.get("match-acceptee-deux-assos")).toBe("acceptee");
    expect(statusById.get("match-refusee")).toBe("refusee");
    expect(statusById.get("match-sans-derog")).toBeNull();
  });

  it("derogationStatus : \"en_cours\" l'emporte quand une même rencontre a plusieurs dérogations distinctes (demande du club : \"si ya accepté + en cours, c'est le en cours qui prend le dessus\")", async () => {
    state.matches = [match({ id: "match-1" })];
    state.fbiDerogationChecks = [
      { id: "check-acceptee", club_id: CLUB_A.id, match_id: "match-1", numero: "1", etat: "Acceptée par l'organisme dirigeant", date_depot: null, date_derogation: null, date_rencontre: null, heure: null, domicile: null, visiteur: null, checked_at: "2026-09-26T16:00:00.000Z" },
      { id: "check-en-cours", club_id: CLUB_A.id, match_id: "match-1", numero: "1", etat: "En Cours", date_depot: null, date_derogation: null, date_rencontre: null, heure: null, domicile: null, visiteur: null, checked_at: "2026-09-26T16:00:00.000Z" },
    ];

    const res = await request("");
    const body = await res.json();

    expect(body.matches.find((m: { id: string }) => m.id === "match-1")?.derogationStatus).toBe("en_cours");
  });
});

describe("GET /v1/clubs/:clubId/matches — pagination (§12 de la demande)", () => {
  it("limite le nombre de résultats et expose le total réel", async () => {
    state.matches = Array.from({ length: 5 }, (_, i) => match({ id: `m${i}`, match_datetime: `2026-01-0${i + 1}T10:00:00.000Z` }));
    const res = await request("?limit=2&offset=0");
    const body = await res.json();
    expect(body.matches).toHaveLength(2);
    expect(body.pagination).toEqual({ limit: 2, offset: 0, total: 5 });
  });

  it("applique l'offset", async () => {
    state.matches = Array.from({ length: 5 }, (_, i) => match({ id: `m${i}`, match_datetime: `2026-01-0${i + 1}T10:00:00.000Z` }));
    const res = await request("?limit=2&offset=4");
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
  });

  it("rejette une limite au-delà du maximum documenté", async () => {
    const res = await request("?limit=99999");
    expect(res.status).toBe(400);
  });

  it("utilise une limite par défaut raisonnable sans paramètre (jamais un dump complet non borné)", async () => {
    state.matches = Array.from({ length: 3 }, (_, i) => match({ id: `m${i}` }));
    const res = await request("");
    const body = await res.json();
    expect(body.pagination.limit).toBeGreaterThan(0);
  });
});

describe("GET /v1/clubs/:clubId/matches — isolation cross-tenant", () => {
  it("un utilisateur non membre du club reçoit 404, jamais les matchs", async () => {
    currentUserId = "user-not-a-member";
    const res = await request("");
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/clubs/:clubId/matches/:matchId/derogation (voir docs/FBI.md)", () => {
  it("renvoie derogation: null quand aucune vérification n'a encore été lancée", async () => {
    state.matches = [match({ id: "match-1" })];
    const res = await request("/match-1/derogation");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.derogation).toBeNull();
  });

  it("renvoie le dernier état connu, converti en camelCase", async () => {
    state.matches = [match({ id: "match-1" })];
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

    const res = await request("/match-1/derogation");
    const body = await res.json();
    expect(body.derogation).toMatchObject({ numero: "1", etat: "A Créer", dateRencontre: "26/09/2026", heure: "15:30", checkedAt: "2026-09-25T16:00:00.000Z" });
  });

  it("PLUSIEURS lignes pour la même rencontre (§ \"82 vs 51\", jusqu'à 8 dérogations distinctes) -> renvoie celle RÉELLEMENT \"En Cours\" même SANS détail, jamais null (bug confirmé par le club, 2026-09-27 : \"ya une derog mais quand je clique c ecrit aucune derog en cours\" — `.maybeSingle()` échouait silencieusement dès qu'une 2e ligne existait)", async () => {
    state.matches = [match({ id: "match-1" })];
    state.fbiDerogationChecks = [
      {
        id: "check-en-cours-sans-detail",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "5009",
        etat: "En Cours",
        date_depot: null,
        date_derogation: null,
        date_rencontre: "26/09/2026",
        heure: "15:30",
        domicile: "SPORT CLUB DE SETE BASKET - 1",
        visiteur: "CASTELNAU BASKET - 2",
        demandeur: null,
        motif: null,
        checked_at: "2026-09-26T22:17:27.000Z",
      },
      {
        id: "check-acceptee-avec-detail",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "5009",
        etat: "Acceptée par l'organisme dirigeant",
        date_depot: null,
        date_derogation: null,
        date_rencontre: "26/09/2026",
        heure: "15:30",
        domicile: "SPORT CLUB DE SETE BASKET - 1",
        visiteur: "CASTELNAU BASKET - 2",
        demandeur: "Domicile",
        motif: "Organisation journée. Merci",
        heure_demandee: "17:00",
        adversaire: "CASTELNAU BASKET",
        date_reponse: "15/09/2026 08:49",
        acceptation: "Acceptée",
        checked_at: "2026-09-26T22:17:27.000Z",
      },
    ];

    const res = await request("/match-1/derogation");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Round 3 du bug (toujours 2026-09-27, "c pas la en cours qui a pris le
    // dessus") : le club confirme que "En Cours" doit rester PRIORITAIRE sur
    // tout état déjà tranché même sans détail — cohérent avec le badge
    // coloré de la liste des matchs ("si ya accepté + en cours, c'est le en
    // cours qui prend le dessus").
    expect(body.derogation).toMatchObject({ numero: "5009", etat: "En Cours", demandeur: null, motif: null });
  });

  it("plusieurs lignes détaillées mais AUCUNE \"En Cours\" -> retombe sur la complétude du détail pour départager (round 2 du même bug, toujours utile quand aucune ligne n'est active)", async () => {
    state.matches = [match({ id: "match-1" })];
    state.fbiDerogationChecks = [
      {
        id: "check-refusee-sans-detail",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "16",
        etat: "Refusée",
        date_depot: null,
        date_derogation: null,
        date_rencontre: null,
        heure: null,
        domicile: null,
        visiteur: null,
        checked_at: "2026-09-26T22:17:27.000Z",
      },
      {
        id: "check-acceptee-avec-detail",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "16",
        etat: "Acceptée par l'organisme dirigeant",
        date_depot: null,
        date_derogation: null,
        date_rencontre: null,
        heure: null,
        domicile: null,
        visiteur: null,
        demandeur: "Domicile",
        motif: "Organisation journée. Merci",
        checked_at: "2026-09-20T08:00:00.000Z",
      },
    ];

    const res = await request("/match-1/derogation");
    const body = await res.json();
    expect(body.derogation).toMatchObject({ etat: "Acceptée par l'organisme dirigeant", demandeur: "Domicile" });
  });

  it("plusieurs lignes SANS AUCUN détail -> renvoie la plus récemment vérifiée (jamais null)", async () => {
    state.matches = [match({ id: "match-1" })];
    state.fbiDerogationChecks = [
      {
        id: "check-ancienne",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "16",
        etat: "Refusée",
        date_depot: null,
        date_derogation: null,
        date_rencontre: null,
        heure: null,
        domicile: null,
        visiteur: null,
        checked_at: "2026-09-20T10:00:00.000Z",
      },
      {
        id: "check-recente",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "16",
        etat: "Acceptée par l'organisme dirigeant",
        date_depot: null,
        date_derogation: null,
        date_rencontre: null,
        heure: null,
        domicile: null,
        visiteur: null,
        checked_at: "2026-09-26T22:17:27.000Z",
      },
    ];

    const res = await request("/match-1/derogation");
    const body = await res.json();
    expect(body.derogation).toMatchObject({ etat: "Acceptée par l'organisme dirigeant", checkedAt: "2026-09-26T22:17:27.000Z" });
  });

  it("deux lignes AVEC détail -> départage par date_depot (date de dépôt RÉELLE côté FBI), jamais checked_at (l'heure de NOTRE vérification)", async () => {
    state.matches = [match({ id: "match-1" })];
    state.fbiDerogationChecks = [
      {
        id: "check-depot-recent-mais-verifie-avant",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "23",
        etat: "En Cours",
        date_depot: "20/09/2026 10:00",
        date_derogation: null,
        date_rencontre: null,
        heure: null,
        domicile: null,
        visiteur: null,
        demandeur: "Domicile",
        motif: "Deuxième demande",
        checked_at: "2026-09-20T08:00:00.000Z",
      },
      {
        id: "check-depot-ancien-mais-verifie-apres",
        club_id: CLUB_A.id,
        match_id: "match-1",
        numero: "23",
        etat: "Refusée",
        date_depot: "01/09/2026 10:00",
        date_derogation: null,
        date_rencontre: null,
        heure: null,
        domicile: null,
        visiteur: null,
        demandeur: "Domicile",
        motif: "Première demande",
        checked_at: "2026-09-26T22:17:27.000Z",
      },
    ];

    const res = await request("/match-1/derogation");
    const body = await res.json();
    expect(body.derogation).toMatchObject({ motif: "Deuxième demande" });
  });
});

describe("POST /v1/clubs/:clubId/matches/:matchId/derogation/check (club_admin, voir docs/FBI.md — SYNCHRONE depuis 2026-09-28, 'doit y avoir rien en attente')", () => {
  beforeEach(() => {
    state.roles = [{ membership_id: "membership-a1", role: "club_admin" }];
  });

  it("délègue à checkDerogationForMatchSync (scopé club+match) et renvoie son résultat immédiatement", async () => {
    mockCheckDerogationForMatchSync.mockResolvedValueOnce({ found: true });

    const res = await request("/match-1/derogation/check", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: true });
    expect(mockCheckDerogationForMatchSync).toHaveBeenCalledWith(expect.anything(), { clubId: CLUB_A.id, matchId: "match-1" });
  });

  it("rejette (409) quand FBI n'est pas configuré pour ce club (propagé depuis checkDerogationForMatchSync)", async () => {
    mockCheckDerogationForMatchSync.mockRejectedValueOnce(conflict("Configure d'abord un identifiant/mot de passe FBI avant de vérifier une dérogation.", "FBI_NOT_CONFIGURED"));

    const res = await request("/match-1/derogation/check", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("refuse (403) à un membre non club_admin", async () => {
    state.roles = [{ membership_id: "membership-a1", role: "joueur" }];

    const res = await request("/match-1/derogation/check", { method: "POST" });
    expect(res.status).toBe(403);
    expect(mockCheckDerogationForMatchSync).not.toHaveBeenCalled();
  });

  it("404 pour un match introuvable/d'un autre club (propagé depuis checkDerogationForMatchSync)", async () => {
    mockCheckDerogationForMatchSync.mockRejectedValueOnce(notFound("Match introuvable ou sans numéro de rencontre connu."));

    const res = await request("/match-inexistant/derogation/check", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
