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
    salle: "GYMNASE MAURICE CLAVEL",
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
    // Contient le nom de salle FBI par défaut (`fbiRow().salle`) — voir
    // `venuesLikelyMatch` : jamais une égalité stricte contre le format
    // combiné "Nom — Adresse" de `matches.venue_raw_label`.
    venueRawLabel: "GYMNASE MAURICE CLAVEL — 12 rue du Stade, 34200 Sète",
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
        correction: null,
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
        correction: null,
      },
    ]);
  });

  it("n'alerte jamais sur un match ANNULÉ absent de FBI (absence attendue)", () => {
    const discrepancies = reconcileFbiSchedule([], [ourMatch({ status: "cancelled" })]);
    expect(discrepancies).toEqual([]);
  });

  it("détecte un écart de date/heure entre FBI et FFBB (le cas d'usage central : 'les modifs en avance') et calcule la correction FBI à appliquer", () => {
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
        // 27/09/2026 15:00 heure de Paris (CEST, UTC+2) -> 13:00 UTC.
        correction: { matchDatetime: "2026-09-27T13:00:00.000Z" },
      },
    ]);
  });

  it("tolère le format d'heure 'HHhMM' de FBI en plus de 'HH:MM'", () => {
    expect(reconcileFbiSchedule([fbiRow({ heure: "13h30" })], [ourMatch()])).toEqual([]);
  });

  describe("salle (demande du club, 2026-09-27 : 'FBI doit emporter sur FFBB car les vraies infos proviennent de FBI')", () => {
    it("ne signale rien quand la salle FBI apparaît dans notre libellé combiné 'Nom — Adresse' (jamais une égalité stricte)", () => {
      expect(reconcileFbiSchedule([fbiRow({ salle: "GYMNASE MAURICE CLAVEL" })], [ourMatch()])).toEqual([]);
    });

    it("tolère la casse et les accents (jamais un faux positif de formatage)", () => {
      expect(
        reconcileFbiSchedule(
          [fbiRow({ salle: "gymnase maurice clavel" })],
          [ourMatch({ venueRawLabel: "Gymnase Maurice Clavel — 12 rue du Stade" })],
        ),
      ).toEqual([]);
    });

    it("détecte un vrai changement de salle et calcule la correction FBI à appliquer", () => {
      const discrepancies = reconcileFbiSchedule([fbiRow({ salle: "GYMNASE PIERRE DE COUBERTIN" })], [ourMatch()]);

      expect(discrepancies).toEqual([
        {
          matchId: "match-1",
          divisionCode: "BU13MN23",
          numero: "3",
          kind: "mismatch",
          fieldName: "venue_raw_label",
          ffbbValue: "GYMNASE MAURICE CLAVEL — 12 rue du Stade, 34200 Sète",
          fbiValue: "GYMNASE PIERRE DE COUBERTIN",
          fbiOpponentName: "SPORT CLUB DE SETE BASKET - 1 – FRONTIGNAN LA PEYRADE BASKET",
          correction: { venueRawLabel: "GYMNASE PIERRE DE COUBERTIN" },
        },
      ]);
    });

    it("ne signale jamais rien quand l'un des deux côtés n'a pas de salle connue (FBI seul n'enrichit pas un vide)", () => {
      expect(reconcileFbiSchedule([fbiRow({ salle: null })], [ourMatch()])).toEqual([]);
      expect(reconcileFbiSchedule([fbiRow({ salle: "GYMNASE PIERRE DE COUBERTIN" })], [ourMatch({ venueRawLabel: null })])).toEqual([]);
    });

    /**
     * Régression du bug constaté en production le 2026-09-28 : FBI tronque
     * les noms de salle trop longs dans son tableau ("GYMNASE MAURICE
     * C..."), et le texte de cellule scrapé utilise des espaces INSÉCABLES
     * (`&nbsp;`, U+00A0) entre les mots — corrompant ~20 rencontres du club
     * pilote (`venue_raw_label` écrasé par ce texte tronqué et inutilisable
     * avant ce correctif).
     */
    describe("salle FBI tronquée ('GYMNASE MAURICE C...') — bug production 2026-09-28", () => {
      it("ne signale rien quand le préfixe tronqué correspond au début de notre libellé complet", () => {
        expect(reconcileFbiSchedule([fbiRow({ salle: "GYMNASE MAURICE C..." })], [ourMatch()])).toEqual([]);
      });

      it("normalise les espaces insécables (\\u00A0) du texte scrapé FBI avant comparaison", () => {
        const nbsp = String.fromCharCode(160);
        expect(reconcileFbiSchedule([fbiRow({ salle: `GYMNASE${nbsp}MAURICE${nbsp}C...` })], [ourMatch()])).toEqual([]);
      });

      it("signale l'anomalie MAIS n'écrit JAMAIS le texte tronqué comme correction, même quand aucun de nos libellés ne correspond (préfixe ambigu ou vraiment différent)", () => {
        const discrepancies = reconcileFbiSchedule([fbiRow({ salle: "HALLE DES SPORTS..." })], [ourMatch()]);

        expect(discrepancies).toEqual([
          expect.objectContaining({
            kind: "mismatch",
            fieldName: "venue_raw_label",
            fbiValue: "HALLE DES SPORTS...",
            correction: null,
          }),
        ]);
      });
    });
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
