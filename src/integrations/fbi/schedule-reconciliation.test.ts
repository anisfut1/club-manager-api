import { describe, expect, it } from "vitest";
import { reconcileFbiSchedule, type OurMatchForReconciliation } from "./schedule-reconciliation.js";
import type { FbiScheduleRow } from "./types.js";

function fbiRow(overrides: Partial<FbiScheduleRow> = {}): FbiScheduleRow {
  return {
    division: "BU13MN23",
    numero: "3",
    equipe1: "SPORT CLUB DE SETE BASKET - 1",
    equipe2: "FRONTIGNAN LA PEYRADE BASKET",
    dateRencontre: "26/09/2026",
    heure: "13:30",
    salle: "GYMNASE MAURICE C...",
    em: null,
    score1: null,
    forfait1: null,
    raw: {},
    ...overrides,
  };
}

function ourMatch(overrides: Partial<OurMatchForReconciliation> = {}): OurMatchForReconciliation {
  return {
    id: "match-1",
    competitionCode: "BU13MN23",
    numero: "3",
    // 2026-09-26T13:30 heure de Paris (CEST, UTC+2) -> 11:30 UTC.
    matchDatetime: "2026-09-26T11:30:00.000Z",
    status: "scheduled",
    ...overrides,
  };
}

describe("reconcileFbiSchedule", () => {
  it("ne renvoie aucune anomalie quand FBI et FFBB concordent (division/numéro/date/heure)", () => {
    expect(reconcileFbiSchedule([fbiRow()], [ourMatch()])).toEqual([]);
  });

  it("détecte un match présent sur FBI mais absent de notre calendrier FFBB", () => {
    const discrepancies = reconcileFbiSchedule([fbiRow()], []);

    expect(discrepancies).toEqual([
      {
        matchId: null,
        divisionCode: "BU13MN23",
        numero: "3",
        kind: "missing_in_ffbb",
        fieldName: null,
        ffbbValue: null,
        fbiValue: "SPORT CLUB DE SETE BASKET - 1 – FRONTIGNAN LA PEYRADE BASKET",
        fbiOpponentName: "SPORT CLUB DE SETE BASKET - 1 – FRONTIGNAN LA PEYRADE BASKET",
      },
    ]);
  });

  it("ignore une rencontre 'Exempt' (bye) — jamais un faux missing_in_ffbb", () => {
    const discrepancies = reconcileFbiSchedule([fbiRow({ equipe2: "Exempt" })], []);
    expect(discrepancies).toEqual([]);
  });

  it("détecte un match de notre calendrier FFBB absent du listing FBI", () => {
    const discrepancies = reconcileFbiSchedule([], [ourMatch()]);

    expect(discrepancies).toEqual([
      {
        matchId: "match-1",
        divisionCode: "BU13MN23",
        numero: "3",
        kind: "missing_in_fbi",
        fieldName: null,
        ffbbValue: null,
        fbiValue: null,
        fbiOpponentName: null,
      },
    ]);
  });

  it("n'alerte jamais sur un match ANNULÉ absent de FBI (absence attendue)", () => {
    const discrepancies = reconcileFbiSchedule([], [ourMatch({ status: "cancelled" })]);
    expect(discrepancies).toEqual([]);
  });

  it("détecte un écart de date/heure entre FBI et FFBB (le cas d'usage central : 'les modifs en avance')", () => {
    const discrepancies = reconcileFbiSchedule(
      [fbiRow({ dateRencontre: "27/09/2026", heure: "15:00" })],
      [ourMatch()],
    );

    expect(discrepancies).toEqual([
      {
        matchId: "match-1",
        divisionCode: "BU13MN23",
        numero: "3",
        kind: "mismatch",
        fieldName: "match_datetime",
        ffbbValue: "26/09/2026 13:30",
        fbiValue: "27/09/2026 15:00",
        fbiOpponentName: "SPORT CLUB DE SETE BASKET - 1 – FRONTIGNAN LA PEYRADE BASKET",
      },
    ]);
  });

  it("tolère le format d'heure 'HHhMM' de FBI en plus de 'HH:MM'", () => {
    expect(reconcileFbiSchedule([fbiRow({ heure: "13h30" })], [ourMatch()])).toEqual([]);
  });

  it("ne compare jamais deux rencontres de divisions différentes portant le même numéro", () => {
    const discrepancies = reconcileFbiSchedule(
      [fbiRow({ division: "BU15MN1", numero: "3", dateRencontre: "01/01/2027", heure: "10:00" })],
      [ourMatch({ competitionCode: "BU13MN23", numero: "3" })],
    );

    // Deux rencontres disjointes (clé division+numéro différente) : une
    // manquante de chaque côté, jamais un rapprochement croisé erroné.
    expect(discrepancies).toEqual([
      expect.objectContaining({ kind: "missing_in_ffbb", divisionCode: "BU15MN1" }),
      expect.objectContaining({ kind: "missing_in_fbi", divisionCode: "BU13MN23" }),
    ]);
  });

  it("ignore les rencontres sans clé de rapprochement exploitable (division ou numéro manquant)", () => {
    expect(reconcileFbiSchedule([fbiRow({ division: null })], [ourMatch({ competitionCode: null })])).toEqual([]);
  });
});
