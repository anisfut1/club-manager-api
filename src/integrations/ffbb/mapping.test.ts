import { describe, expect, it } from "vitest";
import type { NormalizedMatch } from "@/integrations/ffbb/types";
import type { Database } from "@/db/types";
import { diffTrackedFields, mapNormalizedMatchToRow, shouldRequestEmarque } from "./mapping";

type MatchRow = Database["public"]["Tables"]["matches"]["Row"];

const CONTEXT = { clubId: "club-1", teamId: "team-1", competitionId: "comp-1", poolId: "pool-1", venueId: "venue-1" };

function buildNormalizedMatch(overrides: Partial<NormalizedMatch> = {}): NormalizedMatch {
  return {
    ffbbId: "ffbb-match-1",
    uniqueKey: "unique-1",
    gsId: "gs-1",
    numero: "2813",
    numeroJournee: "J5",
    competitionFfbbId: "comp-1",
    poolFfbbId: "pool-1",
    ourEngagementFfbbId: "engagement-1",
    isHome: true,
    opponentName: "BC Thuirinois",
    opponentOrganismeFfbbId: "org-2",
    matchDateTime: "2025-09-27T19:00:00.000Z",
    scoreHome: null,
    scoreAway: null,
    status: "scheduled",
    venue: { ffbbId: "venue-ffbb-1", name: "Gymnase Sète", commune: "Sète", raw: {} },
    raw: { source: "synthetic-fixture" },
    ...overrides,
  };
}

function buildExistingRow(overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    id: "match-1",
    club_id: "club-1",
    ffbb_match_id: "ffbb-match-1",
    ffbb_unique_key: "unique-1",
    ffbb_gs_id: "gs-1",
    numero: "2813",
    team_id: "team-1",
    competition_id: "comp-1",
    pool_id: "pool-1",
    journee: "J5",
    match_datetime: "2025-09-27T19:00:00.000Z",
    is_home: true,
    opponent_name: "BC Thuirinois",
    opponent_ffbb_organisme_id: "org-2",
    venue_id: "venue-1",
    venue_raw_label: "Gymnase Sète",
    score_home: null,
    score_away: null,
    status: "scheduled",
    emarque_status: "not_applicable",
    emarque_discovery_attempt_count: 0,
    emarque_next_discovery_attempt_at: null,
    raw_ffbb_payload: {},
    ffbb_last_seen_at: "2025-09-20T00:00:00.000Z",
    created_at: "2025-09-20T00:00:00.000Z",
    updated_at: "2025-09-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("mapNormalizedMatchToRow", () => {
  it("mappe un match normalisé vers une ligne insérable, avec le contexte résolu", () => {
    const row = mapNormalizedMatchToRow(buildNormalizedMatch(), CONTEXT);

    expect(row).toMatchObject({
      club_id: "club-1",
      ffbb_match_id: "ffbb-match-1",
      ffbb_unique_key: "unique-1",
      ffbb_gs_id: "gs-1",
      numero: "2813",
      journee: "J5",
      team_id: "team-1",
      competition_id: "comp-1",
      pool_id: "pool-1",
      is_home: true,
      opponent_name: "BC Thuirinois",
      opponent_ffbb_organisme_id: "org-2",
      venue_id: "venue-1",
      venue_raw_label: "Gymnase Sète",
      match_datetime: "2025-09-27T19:00:00.000Z",
      score_home: null,
      score_away: null,
      status: "scheduled",
    });
  });

  it("laisse team_id/competition_id/pool_id/venue_id à null quand le contexte ne les a pas résolus", () => {
    const row = mapNormalizedMatchToRow(buildNormalizedMatch(), { clubId: "club-1", teamId: null, competitionId: null, poolId: null, venueId: null });

    expect(row.team_id).toBeNull();
    expect(row.competition_id).toBeNull();
    expect(row.pool_id).toBeNull();
    expect(row.venue_id).toBeNull();
  });

  it("n'invente jamais un nom de salle : absence de venue -> venue_raw_label null", () => {
    const row = mapNormalizedMatchToRow(buildNormalizedMatch({ venue: null }), CONTEXT);
    expect(row.venue_raw_label).toBeNull();
  });
});

describe("diffTrackedFields", () => {
  it("ne renvoie aucun diff pour un match nouvellement créé (existing = null)", () => {
    const incoming = mapNormalizedMatchToRow(buildNormalizedMatch({ status: "played", scoreHome: 69, scoreAway: 101 }), CONTEXT);
    expect(diffTrackedFields(null, incoming)).toEqual([]);
  });

  it("ne renvoie aucun diff quand rien n'a changé sur les champs suivis", () => {
    const existing = buildExistingRow();
    const incoming = mapNormalizedMatchToRow(buildNormalizedMatch(), CONTEXT);
    expect(diffTrackedFields(existing, incoming)).toEqual([]);
  });

  it("détecte un changement de score (match terminé)", () => {
    const existing = buildExistingRow({ status: "scheduled", score_home: null, score_away: null });
    const incoming = mapNormalizedMatchToRow(buildNormalizedMatch({ status: "played", scoreHome: 69, scoreAway: 101 }), CONTEXT);

    const diffs = diffTrackedFields(existing, incoming);

    expect(diffs).toContainEqual({ field: "status", oldValue: "scheduled", newValue: "played" });
    expect(diffs).toContainEqual({ field: "score_home", oldValue: null, newValue: "69" });
    expect(diffs).toContainEqual({ field: "score_away", oldValue: null, newValue: "101" });
  });

  it("détecte un report de match (changement d'horaire)", () => {
    const existing = buildExistingRow({ match_datetime: "2025-09-27T19:00:00.000Z" });
    const incoming = mapNormalizedMatchToRow(buildNormalizedMatch({ matchDateTime: "2025-10-04T19:00:00.000Z" }), CONTEXT);

    const diffs = diffTrackedFields(existing, incoming);
    expect(diffs).toEqual([{ field: "match_datetime", oldValue: "2025-09-27T19:00:00.000Z", newValue: "2025-10-04T19:00:00.000Z" }]);
  });

  it("ignore les champs non suivis (ex: identifiants internes résolus) même s'ils changent", () => {
    const existing = buildExistingRow({ team_id: "team-1", venue_id: "venue-1" });
    const incoming = mapNormalizedMatchToRow(buildNormalizedMatch(), { ...CONTEXT, teamId: "team-2", venueId: "venue-2" });

    expect(diffTrackedFields(existing, incoming)).toEqual([]);
  });

  it("est idempotent : appliquer deux fois le même snapshot ne produit un diff qu'une fois", () => {
    const incoming = mapNormalizedMatchToRow(buildNormalizedMatch({ status: "played", scoreHome: 69, scoreAway: 101 }), CONTEXT);

    const firstExisting = buildExistingRow({ status: "scheduled", score_home: null, score_away: null });
    const firstDiffs = diffTrackedFields(firstExisting, incoming);
    expect(firstDiffs.length).toBeGreaterThan(0);

    // Une deuxième synchronisation avec exactement les mêmes données FFBB
    // (existing = résultat de la première) ne doit plus rien détecter.
    const secondExisting = buildExistingRow({ status: "played", score_home: 69, score_away: 101 });
    expect(diffTrackedFields(secondExisting, incoming)).toEqual([]);
  });
});

describe("shouldRequestEmarque", () => {
  it("déclenche la demande e-Marque quand un match passe à 'played'", () => {
    expect(shouldRequestEmarque("scheduled", "played")).toBe(true);
  });

  it("ne déclenche rien si le match était déjà 'played'", () => {
    expect(shouldRequestEmarque("played", "played")).toBe(false);
  });

  it("ne déclenche rien pour un match qui reste 'scheduled'", () => {
    expect(shouldRequestEmarque("scheduled", "scheduled")).toBe(false);
  });

  it("ne déclenche rien pour un match nouvellement créé directement en 'played' (existingStatus undefined)", () => {
    // Cas concret : première synchronisation après un match déjà passé (rattrapage).
    // Le pipeline e-Marque doit quand même être sollicité.
    expect(shouldRequestEmarque(undefined, "played")).toBe(true);
  });

  it("ne déclenche rien pour un passage à 'postponed' ou 'cancelled'", () => {
    expect(shouldRequestEmarque("scheduled", "postponed")).toBe(false);
    expect(shouldRequestEmarque("scheduled", "cancelled")).toBe(false);
  });
});
