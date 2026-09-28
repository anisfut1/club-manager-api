import { describe, expect, it } from "vitest";
import { computeMatchWindow } from "./match-window.js";
import { computeTableSuggestions, type LicencieCandidateInput, type TableSuggestionEngineInput, type TeamMatchOccurrence, type ExistingAssignmentOccurrence } from "./table-suggestion-service.js";

const CLAVEL = "GYMNASE MAURICE CLAVEL — 22 rue Maurice Clavel";
const LIDO = "COMPLEXE SPORTIF DU LIDO — 213 RUE DU DAUPHINE";

function candidate(id: string, firstName: string, lastName: string, teamId: string, teamName: string): LicencieCandidateInput {
  return { licencieId: id, firstName, lastName, teamIds: [teamId], teamNames: new Map([[teamId, teamName]]) };
}

function occurrence(matchId: string, teamId: string, isHome: boolean, startIso: string, opponentName = "Adversaire", venueRawLabel: string | null = CLAVEL): TeamMatchOccurrence {
  return { matchId, teamId, isHome, window: computeMatchWindow(new Date(startIso)), venueRawLabel, opponentName };
}

function assignment(matchId: string, role: ExistingAssignmentOccurrence["role"], licencieId: string, startIso: string): ExistingAssignmentOccurrence {
  return { matchId, role, licencieId, window: computeMatchWindow(new Date(startIso)) };
}

function baseInput(overrides: Partial<TableSuggestionEngineInput> = {}): TableSuggestionEngineInput {
  return {
    targetMatchId: "match-target",
    targetRole: "SCORER",
    targetWindow: computeMatchWindow(new Date("2026-10-03T15:00:00Z")),
    targetVenueRawLabel: CLAVEL,
    clubTimezone: "UTC",
    candidates: [],
    teamMatches: [],
    existingTableAssignments: [],
    seasonAssignmentCountByLicencieId: new Map(),
    todayAssignmentCountByLicencieId: new Map(),
    ...overrides,
  };
}

describe("computeTableSuggestions", () => {
  /**
   * §50 — cas central de la demande : U13M domicile 15:00-17:00, U13F
   * extérieur 16:00-18:00 (chevauchement). Tous les licenciés U13F doivent
   * être UNAVAILABLE, reasonCode MATCH_CONFLICT.
   */
  it("un match extérieur qui chevauche rend tous les licenciés de cette équipe UNAVAILABLE (MATCH_CONFLICT)", () => {
    const sarah = candidate("sarah", "Sarah", "Martin", "team-u13f", "U13F");
    const result = computeTableSuggestions(
      baseInput({
        candidates: [sarah],
        teamMatches: [occurrence("match-u13f-away", "team-u13f", false, "2026-10-03T16:00:00Z", "OUEST MONTPELLIER")],
      }),
    );

    expect(result.recommended).toEqual([]);
    expect(result.available).toEqual([]);
    expect(result.unavailable).toEqual([
      expect.objectContaining({ licencieId: "sarah", eligibility: "UNAVAILABLE", reasonCode: "MATCH_CONFLICT", reason: "Match extérieur avec U13F à 16:00", conflictingMatchId: "match-u13f-away" }),
    ]);
  });

  /**
   * §9 — l'équipe qui joue LE match cible est indisponible SANS règle
   * hardcodée "if candidate.team == match.team" : ça découle du calcul de
   * calendrier (le match cible est inclus dans teamMatches pour cette équipe).
   */
  it("les joueurs de l'équipe qui joue le match cible sont indisponibles (déduit du calendrier, jamais hardcodé)", () => {
    const thomas = candidate("thomas", "Thomas", "Martin", "team-u13m", "U13M");
    const result = computeTableSuggestions(
      baseInput({
        targetMatchId: "match-target",
        candidates: [thomas],
        teamMatches: [occurrence("match-target", "team-u13m", true, "2026-10-03T15:00:00Z", "MEZE LOUPIAN")],
      }),
    );

    expect(result.unavailable).toEqual([expect.objectContaining({ licencieId: "thomas", reasonCode: "MATCH_CONFLICT", conflictingMatchId: "match-target" })]);
  });

  /**
   * §51 — back-to-back APRÈS : U13M 15h-17h @ Clavel, U18M 17h-19h @
   * Clavel. Les U18M disponibles doivent être ADJACENT_NEXT_HOME, classés
   * devant un candidat générique.
   */
  it("une équipe qui joue à domicile juste APRÈS est ADJACENT_NEXT_HOME, classée devant un candidat générique", () => {
    const lucas = candidate("lucas", "Lucas", "Bernard", "team-u18m", "U18M");
    const enzo = candidate("enzo", "Enzo", "Petit", "team-seniors2", "Seniors 2");
    const result = computeTableSuggestions(
      baseInput({
        candidates: [lucas, enzo],
        teamMatches: [occurrence("match-u18m-home", "team-u18m", true, "2026-10-03T17:00:00Z", "Adversaire", CLAVEL)],
      }),
    );

    expect(result.recommended.map((c) => c.licencieId)).toEqual(["lucas"]);
    expect(result.recommended[0].priorityTier).toBe("ADJACENT_NEXT_HOME");
    expect(result.recommended[0].reasons).toEqual(expect.arrayContaining([{ code: "NEXT_HOME_MATCH", label: "Joue juste après à 17:00" }, { code: "SAME_VENUE", label: "Même gymnase" }]));
    expect(result.available.map((c) => c.licencieId)).toEqual(["enzo"]);
    expect(result.available[0].priorityTier).toBe("AVAILABLE_OTHER");
  });

  /**
   * §52 — back-to-back AVANT : U15M 13h-15h, table cible 15h-17h. Les U15M
   * disponibles doivent être ADJACENT_PREVIOUS_HOME, mieux classés qu'un
   * candidat générique.
   */
  it("une équipe qui vient de jouer à domicile JUSTE AVANT est ADJACENT_PREVIOUS_HOME", () => {
    const mia = candidate("mia", "Mia", "Roux", "team-u15m", "U15M");
    const result = computeTableSuggestions(baseInput({ candidates: [mia], teamMatches: [occurrence("match-u15m-home", "team-u15m", true, "2026-10-03T13:00:00Z")] }));

    expect(result.recommended[0]).toMatchObject({ licencieId: "mia", priorityTier: "ADJACENT_PREVIOUS_HOME" });
    expect(result.recommended[0].reasons[0]).toEqual({ code: "PREVIOUS_HOME_MATCH", label: "Vient de jouer à 13:00" });
  });

  /** §53 — à conditions équivalentes, NEXT_HOME passe avant PREVIOUS_HOME. */
  it("NEXT_HOME_MATCH est classé avant PREVIOUS_HOME_MATCH à conditions équivalentes", () => {
    const next = candidate("next-player", "Noa", "Simon", "team-u18m", "U18M");
    const previous = candidate("previous-player", "Zoé", "Andre", "team-u15m", "U15M");
    const result = computeTableSuggestions(
      baseInput({
        candidates: [previous, next], // ordre d'entrée volontairement inversé : le tri doit re-classer
        teamMatches: [occurrence("match-next", "team-u18m", true, "2026-10-03T17:00:00Z"), occurrence("match-previous", "team-u15m", true, "2026-10-03T13:00:00Z")],
      }),
    );

    expect(result.recommended.map((c) => c.licencieId)).toEqual(["next-player", "previous-player"]);
  });

  /** §54 — boundary : table 15h-17h, match candidat 17h-19h => AUCUN conflit (et sert de base au tier adjacent). */
  it("un match qui commence exactement à la fin de la table (boundary) n'est jamais un conflit", () => {
    const player = candidate("player", "Alix", "Faure", "team-u18m", "U18M");
    const result = computeTableSuggestions(baseInput({ candidates: [player], teamMatches: [occurrence("match-boundary", "team-u18m", true, "2026-10-03T17:00:00Z")] }));

    expect(result.unavailable).toEqual([]);
  });

  /** §55 — overlap : table 15h-17h, match candidat 16h-18h => conflit. */
  it("un match qui chevauche réellement (16h-18h vs table 15h-17h) est un conflit", () => {
    const player = candidate("player", "Alix", "Faure", "team-u18m", "U18M");
    const result = computeTableSuggestions(baseInput({ candidates: [player], teamMatches: [occurrence("match-overlap", "team-u18m", true, "2026-10-03T16:00:00Z")] }));

    expect(result.unavailable).toEqual([expect.objectContaining({ licencieId: "player", reasonCode: "MATCH_CONFLICT" })]);
  });

  /** §56 — un licencié déjà affecté à une AUTRE table qui chevauche est UNAVAILABLE. */
  it("un licencié déjà affecté à une autre table sur un créneau qui chevauche est UNAVAILABLE (TABLE_ASSIGNMENT_CONFLICT)", () => {
    const player = candidate("player", "Alix", "Faure", "team-other", "Autre équipe");
    const result = computeTableSuggestions(
      baseInput({
        candidates: [player],
        existingTableAssignments: [assignment("match-other", "SCORER", "player", "2026-10-03T16:00:00Z")],
      }),
    );

    expect(result.unavailable).toEqual([expect.objectContaining({ licencieId: "player", reasonCode: "TABLE_ASSIGNMENT_CONFLICT", conflictingMatchId: "match-other" })]);
  });

  it("une affectation de table qui ne chevauche pas (boundary) ne crée aucun conflit", () => {
    const player = candidate("player", "Alix", "Faure", "team-other", "Autre équipe");
    const result = computeTableSuggestions(
      baseInput({ candidates: [player], existingTableAssignments: [assignment("match-other", "SCORER", "player", "2026-10-03T17:00:00Z")] }),
    );
    expect(result.unavailable).toEqual([]);
  });

  /** §11/§28 — un licencié déjà affecté à un AUTRE rôle sur LE MÊME match cible est UNAVAILABLE (pas de double poste). */
  it("un licencié déjà affecté à un autre rôle sur le match cible est UNAVAILABLE (ALREADY_ASSIGNED_ON_MATCH)", () => {
    const player = candidate("player", "Alix", "Faure", "team-other", "Autre équipe");
    const result = computeTableSuggestions(
      baseInput({
        targetMatchId: "match-target",
        targetRole: "SCORER",
        candidates: [player],
        existingTableAssignments: [assignment("match-target", "TIMEKEEPER", "player", "2026-10-03T15:00:00Z")],
      }),
    );

    expect(result.unavailable).toEqual([expect.objectContaining({ licencieId: "player", reasonCode: "ALREADY_ASSIGNED_ON_MATCH", conflictingMatchId: "match-target" })]);
  });

  /** §77 — le titulaire ACTUEL du rôle demandé n'est jamais un conflit : il doit réapparaître, marqué isCurrentHolder. */
  it("le titulaire actuel du rôle demandé n'est PAS en conflit avec lui-même — isCurrentHolder à true", () => {
    const player = candidate("player", "Alix", "Faure", "team-other", "Autre équipe");
    const result = computeTableSuggestions(
      baseInput({
        targetMatchId: "match-target",
        targetRole: "SCORER",
        candidates: [player],
        existingTableAssignments: [assignment("match-target", "SCORER", "player", "2026-10-03T15:00:00Z")],
      }),
    );

    expect(result.unavailable).toEqual([]);
    const all = [...result.recommended, ...result.available];
    expect(all).toEqual([expect.objectContaining({ licencieId: "player", isCurrentHolder: true })]);
  });

  /** §14 — même gymnase = bonus fort ; gymnase différent = bonus plus faible mais candidat toujours recommandé (jamais bloqué). */
  it("un match adjacent au MÊME gymnase est classé devant un match adjacent à un AUTRE gymnase", () => {
    const sameVenuePlayer = candidate("same-venue", "Théo", "Blanc", "team-a", "Team A");
    const otherVenuePlayer = candidate("other-venue", "Léo", "Noir", "team-b", "Team B");
    const result = computeTableSuggestions(
      baseInput({
        candidates: [otherVenuePlayer, sameVenuePlayer],
        teamMatches: [occurrence("match-a", "team-a", true, "2026-10-03T17:00:00Z", "X", CLAVEL), occurrence("match-b", "team-b", true, "2026-10-03T17:00:00Z", "Y", LIDO)],
      }),
    );

    expect(result.recommended.map((c) => c.licencieId)).toEqual(["same-venue", "other-venue"]);
    expect(result.recommended[1].eligibility).toBe("RECOMMENDED"); // jamais bloqué, juste moins bien classé
  });

  /**
   * §60 — équité : deux candidats du MÊME tier, A a 8 tables cette saison,
   * B en a 1 : B doit être classé AVANT A.
   */
  it("l'équité départage deux candidats du même tier : moins de tables cette saison passe devant (§60)", () => {
    const a = candidate("a", "Aline", "Dupont", "team-x", "Team X");
    const b = candidate("b", "Boris", "Dupont", "team-x", "Team X");
    const result = computeTableSuggestions(
      baseInput({
        candidates: [a, b],
        seasonAssignmentCountByLicencieId: new Map([
          ["a", 8],
          ["b", 1],
        ]),
      }),
    );

    expect(result.available.map((c) => c.licencieId)).toEqual(["b", "a"]);
  });

  /**
   * §21 — la priorité métier (tier adjacent) passe TOUJOURS avant
   * l'équité : un joueur avec 0 table mais sans aucune proximité ne double
   * jamais un joueur ADJACENT_NEXT_HOME, même très sollicité.
   */
  it("la proximité d'un match à domicile prime toujours sur l'équité, même face à 0 table", () => {
    const veryBusy = candidate("busy", "Nina", "Very", "team-u18m", "U18M"); // ADJACENT_NEXT_HOME, déjà 10 tables
    const neverAsked = candidate("fresh", "Zoé", "Never", "team-seniors2", "Seniors 2"); // AVAILABLE_OTHER, 0 table
    const result = computeTableSuggestions(
      baseInput({
        candidates: [neverAsked, veryBusy],
        teamMatches: [occurrence("match-u18m", "team-u18m", true, "2026-10-03T17:00:00Z")],
        seasonAssignmentCountByLicencieId: new Map([["busy", 10]]),
      }),
    );

    expect(result.recommended.map((c) => c.licencieId)).toEqual(["busy"]);
    expect(result.available.map((c) => c.licencieId)).toEqual(["fresh"]);
  });

  /** §8 — un licencié rattaché à PLUSIEURS équipes (architecture prête, même si le modèle actuel n'en a qu'une) : un seul match en conflit sur N'IMPORTE LAQUELLE de ses équipes suffit à le rendre indisponible. */
  it("un licencié rattaché à plusieurs équipes est indisponible si N'IMPORTE LAQUELLE de ses équipes a un conflit (§8)", () => {
    const multiTeam: LicencieCandidateInput = {
      licencieId: "multi",
      firstName: "Sam",
      lastName: "Poly",
      teamIds: ["team-a", "team-b"],
      teamNames: new Map([
        ["team-a", "Team A"],
        ["team-b", "Team B"],
      ]),
    };
    const result = computeTableSuggestions(
      baseInput({ candidates: [multiTeam], teamMatches: [occurrence("match-b-away", "team-b", false, "2026-10-03T16:00:00Z", "Adversaire B")] }),
    );

    expect(result.unavailable).toEqual([expect.objectContaining({ licencieId: "multi", reasonCode: "MATCH_CONFLICT", conflictingMatchId: "match-b-away" })]);
  });

  /** §24 — déterminisme : deux candidats à égalité totale (même tier, même équité, même jour) sont départagés par nom puis id, toujours dans le même ordre. */
  it("tie-break déterministe (nom puis prénom puis id) quand tout le reste est égal", () => {
    const zed = candidate("id-z", "Aaa", "Zed", "team-x", "Team X");
    const abc = candidate("id-a", "Aaa", "Abc", "team-x", "Team X");
    const result1 = computeTableSuggestions(baseInput({ candidates: [zed, abc] }));
    const result2 = computeTableSuggestions(baseInput({ candidates: [abc, zed] }));

    expect(result1.available.map((c) => c.licencieId)).toEqual(["id-a", "id-z"]);
    expect(result2.available.map((c) => c.licencieId)).toEqual(["id-a", "id-z"]);
  });

  it("formate les heures dans le fuseau du club (Europe/Paris), jamais en UTC brut", () => {
    // 2026-10-03 est en heure d'été (CEST, UTC+2) : 15:00 UTC == 17:00 Paris.
    const player = candidate("player", "Alix", "Faure", "team-u18m", "U18M");
    const result = computeTableSuggestions(
      baseInput({
        clubTimezone: "Europe/Paris",
        targetWindow: computeMatchWindow(new Date("2026-10-03T13:00:00Z")), // 15:00 Paris
        candidates: [player],
        teamMatches: [occurrence("match-u18m", "team-u18m", true, "2026-10-03T15:00:00Z")], // 17:00 Paris
      }),
    );

    expect(result.recommended[0].reasons[0].label).toBe("Joue juste après à 17:00");
  });

  it("un candidat sans aucun conflit ni proximité est POTENTIALLY_AVAILABLE, jamais présenté comme confirmé (§16)", () => {
    const enzo = candidate("enzo", "Enzo", "Petit", "team-seniors2", "Seniors 2");
    const result = computeTableSuggestions(baseInput({ candidates: [enzo] }));

    expect(result.available).toEqual([expect.objectContaining({ licencieId: "enzo", eligibility: "POTENTIALLY_AVAILABLE", priorityTier: "AVAILABLE_OTHER" })]);
  });
});
