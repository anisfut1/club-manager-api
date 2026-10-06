import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFakeClubSupabase,
  makeFakeClubSupabaseState,
  type FakeClubSupabaseState,
  type FakeMatchDocumentRow,
  type FakeMatchRow,
  type FakeTeamRow,
} from "../../test-support/fake-club-supabase.js";

let state: FakeClubSupabaseState;

vi.mock("../../db/client.js", () => ({
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

/**
 * Vue PUBLIQUE en lecture seule des matchs (retour du club, 2026-09-29 :
 * "toutes les infos en vue directe... sans compte, en libre service").
 * Contrairement à `public-tables`, AUCUN jeton ici — la seule preuve
 * d'identité nécessaire est le slug du club lui-même (public par nature).
 * Ce fichier vérifie surtout l'isolation cross-tenant (le code applicatif,
 * pas la RLS, doit garantir qu'un club ne voit jamais les données d'un
 * autre) et qu'aucune fonction admin (URL de téléchargement, écriture) ne
 * fuit vers ce routeur.
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

const MATCH_A: FakeMatchRow = {
  id: "match-a",
  club_id: CLUB_A.id,
  numero: "15",
  journee: null,
  match_datetime: "2026-10-03T13:00:00Z",
  is_home: true,
  opponent_name: "MEZE LOUPIAN",
  venue_raw_label: "GYMNASE MAURICE CLAVEL",
  score_home: null,
  score_away: null,
  status: "scheduled",
  emarque_status: "not_applicable",
  team_id: TEAM_U13M.id,
};

const MATCH_B: FakeMatchRow = { ...MATCH_A, id: "match-b", club_id: CLUB_B.id };

const DOCUMENT_A: FakeMatchDocumentRow = {
  id: "document-a",
  club_id: CLUB_A.id,
  match_id: MATCH_A.id,
  type: "match_sheet",
  filename: "feuille.pdf",
  mime_type: "application/pdf",
  status: "downloaded",
  discovered_at: "2026-10-03T15:00:00Z",
  downloaded_at: "2026-10-03T15:05:00Z",
  storage_path: "club-a/match-a/feuille.pdf",
  source: "fbi",
  purged_at: null,
};

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/public/clubs/club-a${path}`, init);
}

beforeEach(() => {
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    teams: [TEAM_U13M],
    matches: [MATCH_A, MATCH_B],
    matchDocuments: [DOCUMENT_A],
  });
});

describe("GET /v1/public/clubs/:clubSlug — aucune session requise", () => {
  it("renvoie les infos club minimales sans header Authorization", async () => {
    const res = await request("");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: "club-a", name: "Club A Basket", logoUrl: null, accentColor: null, timezone: "Europe/Paris" });
  });

  it("404 pour un slug inconnu, jamais une erreur différente", async () => {
    const res = await app.request("/v1/public/clubs/club-inconnu/matches");
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/public/clubs/:clubSlug/matches", () => {
  it("renvoie les matchs de CE club uniquement, jamais ceux d'un autre club", async () => {
    const res = await request("/matches");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: { id: string }[] };
    expect(body.matches.map((m) => m.id)).toEqual(["match-a"]);
  });

  it("applique les mêmes filtres que la route authentifiée (homeAway)", async () => {
    const res = await request("/matches?homeAway=away");
    const body = (await res.json()) as { matches: unknown[] };
    expect(body.matches).toEqual([]);
  });
});

describe("GET /v1/public/clubs/:clubSlug/matches/:matchId", () => {
  it("renvoie le détail du match pour CE club", async () => {
    const res = await request("/matches/match-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("match-a");
  });

  it("une lecture « à vérifier » n'est jamais publiée : composition et statistiques vides, statut visible (processus e-Marque, 2026-10-06)", async () => {
    state.matches = [{ ...MATCH_A, status: "played", score_home: 52, score_away: 53, emarque_status: "needs_review" }, MATCH_B];

    const res = await request("/matches/match-a");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emarque.status).toBe("needs_review");
    expect(body.participants).toEqual([]);
    expect(body.stats).toEqual([]);
  });

  it("404 pour un match d'un AUTRE club, même id valide (jamais une fuite cross-tenant)", async () => {
    const res = await request("/matches/match-b");
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/public/clubs/:clubSlug/matches/:matchId/documents", () => {
  it("liste les documents SANS jamais inclure d'URL de téléchargement, même si un document existe réellement (aucune fonction admin en public)", async () => {
    const res = await request("/matches/match-a/documents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: { id: string; downloadUrl: string | null }[] };
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]!.downloadUrl).toBeNull();
  });
});

describe("GET /v1/public/clubs/:clubSlug/matches/:matchId/derogation", () => {
  it("renvoie derogation: null en l'absence de vérification connue (jamais une erreur)", async () => {
    const res = await request("/matches/match-a/derogation");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ derogation: null });
  });
});

describe("Dérogations jamais exposées sans compte (retour du club, 2026-10-01)", () => {
  const CHECK = {
    id: "derog-a",
    club_id: CLUB_A.id,
    match_id: "match-a",
    numero: "15",
    etat: "Acceptée par l'organisme dirigeant",
    date_depot: "12/09/2026",
    date_derogation: null,
    date_rencontre: "03/10/2026",
    heure: "15:00",
    domicile: "Club A Basket",
    visiteur: "MEZE LOUPIAN",
    demandeur: "Domicile",
    motif: "Organisation journée",
    checked_at: "2026-09-30T09:57:26Z",
  };

  it("la liste publique renvoie derogationStatus: null même quand une dérogation existe", async () => {
    state.fbiDerogationChecks.push(CHECK);
    const res = await request("/matches");
    const body = (await res.json()) as { matches: { id: string; derogationStatus: unknown }[] };
    expect(body.matches.map((m) => m.derogationStatus)).toEqual([null]);
  });

  it("la route publique de dérogation renvoie toujours null, même quand une dérogation existe", async () => {
    state.fbiDerogationChecks.push(CHECK);
    const res = await request("/matches/match-a/derogation");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ derogation: null });
  });
});

describe("GET /v1/public/clubs/:clubSlug/teams", () => {
  it("renvoie les équipes de CE club pour le filtre de la liste", async () => {
    const res = await request("/teams");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { teams: { id: string }[] };
    expect(body.teams.map((t) => t.id)).toEqual(["team-u13m"]);
  });
});

describe("GET /v1/public/clubs/:clubSlug/standings — classements FFBB (retour du club, 2026-10-01)", () => {
  const STANDINGS = [
    { engagementFfbbId: "eng-a", teamName: "SC CLUB A - 1", logoUrl: null, position: 1, points: 10, played: 5, won: 5, lost: 0, draws: null, forfeits: 0, pointsFor: 400, pointsAgainst: 300, difference: 100, outOfRanking: false },
    { engagementFfbbId: "eng-x", teamName: "ADVERSAIRE - 1", logoUrl: null, position: 2, points: 8, played: 5, won: 3, lost: 2, draws: null, forfeits: 0, pointsFor: 350, pointsAgainst: 330, difference: 20, outOfRanking: false },
  ];

  it("renvoie les classements des seules poules où CE club est engagé, avec sa ligne marquée", async () => {
    state.competitions = [{ id: "comp-1", category_label: "U13", name: "Départementale U13 M" }];
    state.pools = [
      { id: "11111111-1111-4111-8111-111111111111", name: "Poule A", competition_id: "comp-1", standings: STANDINGS, standings_updated_at: "2026-10-01T03:00:00Z" },
      { id: "22222222-2222-4222-8222-222222222222", name: "Poule B", competition_id: "comp-1", standings: STANDINGS, standings_updated_at: null },
    ];
    state.engagements = [
      { club_id: CLUB_A.id, team_id: TEAM_U13M.id, ffbb_engagement_id: "eng-a", pool_id: "11111111-1111-4111-8111-111111111111" },
      { club_id: CLUB_B.id, team_id: "team-b", ffbb_engagement_id: "eng-b", pool_id: "22222222-2222-4222-8222-222222222222" },
    ];

    const res = await request("/standings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { standings: { poolName: string; teamName: string; categoryLabel: string; competitionName: string; rows: { teamName: string; isClub: boolean }[] }[] };
    expect(body.standings).toHaveLength(1);
    expect(body.standings[0]).toMatchObject({ poolName: "Poule A", teamName: "U13 M", categoryLabel: "U13", competitionName: "Départementale U13 M" });
    expect(body.standings[0]!.rows.map((r) => [r.teamName, r.isClub])).toEqual([
      ["SC CLUB A - 1", true],
      ["ADVERSAIRE - 1", false],
    ]);
  });

  it("ignore une poule sans classement encore récupéré ou au format inattendu", async () => {
    state.competitions = [{ id: "comp-1", category_label: "U13", name: "D" }];
    state.pools = [{ id: "11111111-1111-4111-8111-111111111111", name: "Poule A", competition_id: "comp-1", standings: { inattendu: true }, standings_updated_at: null }];
    state.engagements = [{ club_id: CLUB_A.id, team_id: TEAM_U13M.id, ffbb_engagement_id: "eng-a", pool_id: "11111111-1111-4111-8111-111111111111" }];

    const body = (await (await request("/standings")).json()) as { standings: unknown[] };
    expect(body.standings).toEqual([]);
  });
});
