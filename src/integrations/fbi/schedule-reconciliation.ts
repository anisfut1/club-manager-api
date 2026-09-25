import type { FbiScheduleDiscrepancyKind, MatchStatus } from "../../db/types.js";
import type { FbiScheduleRow } from "./types.js";

/**
 * Rapprochement calendrier FFBB/FBI (demande du club, voir docs/FBI.md) :
 * "FBI est l'info réelle. si ya une info sur fbi pour la même rencontre
 * différente de ffbb, c'est une anomalie. si un match est sur fbi, et pas
 * sur ffbb, c'est à alerter aussi." FFBB reste la SEULE source écrite dans
 * `matches` (§ le club a explicitement écarté un remplacement, certains
 * clubs n'ont que FFBB) — cette fonction ne fait JAMAIS d'écriture, elle
 * produit une liste d'anomalies à corriger manuellement côté FFBB.
 *
 * Portée v1 volontairement limitée à ce qui peut être comparé de façon
 * FIABLE sans avoir pu observer le format réel d'un match déjà joué sur
 * FBI (voir "Ce qui n'est pas fait" dans docs/FBI.md) :
 * - présence (missing_in_ffbb / missing_in_fbi) — la demande explicite du
 *   club, jamais ambiguë ;
 * - date/heure (mismatch) — c'est précisément la valeur ajoutée citée par
 *   le club ("les modifs en avance") : FBI montre un changement de date/
 *   heure AVANT que la resynchro FFBB (qui tourne périodiquement) ne le
 *   reflète.
 * Score/forfait/salle ne sont PAS comparés ici : le format réel d'un
 * "Score 1"/"Forfait 1" FBI pour un match joué n'a jamais été observé
 * (les captures fournies ne montrent que des rencontres à venir, colonnes
 * vides), et la colonne Forfait est une case à cocher (jamais un texte —
 * `selectors.resultsTableGenericRows` ne lit que du texte de cellule,
 * donc toujours vide pour cette colonne pour l'instant).
 */

export interface OurMatchForReconciliation {
  id: string;
  competitionCode: string | null;
  numero: string | null;
  matchDatetime: string | null;
  status: MatchStatus;
}

export interface ScheduleDiscrepancyInput {
  matchId: string | null;
  divisionCode: string | null;
  numero: string | null;
  kind: FbiScheduleDiscrepancyKind;
  fieldName: string | null;
  ffbbValue: string | null;
  fbiValue: string | null;
  fbiOpponentName: string | null;
}

/** Clé de rapprochement FFBB/FBI : `competitions.code` + `matches.numero` = "Division" + "N°" FBI (voir docs/FBI.md). */
function reconciliationKey(division: string | null, numero: string | null): string | null {
  if (!division || !numero) return null;
  return `${division.trim().toUpperCase()}::${numero.trim().toUpperCase()}`;
}

/** Une rencontre "Exempt" (bye/tour sans adversaire — visible sur la capture fournie par le club, ex: "BU11FN23 n°5") n'a jamais de ligne `matches` correspondante côté FFBB : ce n'est pas une anomalie. */
function isByeRow(row: FbiScheduleRow): boolean {
  const isExempt = (v: string | null) => v?.trim().toLowerCase() === "exempt";
  return isExempt(row.equipe1) || isExempt(row.equipe2);
}

function fbiOpponentLabel(row: FbiScheduleRow): string | null {
  const parts = [row.equipe1, row.equipe2].filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(" – ") : null;
}

/** "11:00" ou "11h00" -> "11:00". `null` si le format n'est pas reconnu (jamais une comparaison hasardeuse). */
function normalizeFbiHeure(heure: string | null): string | null {
  if (!heure) return null;
  const match = /^(\d{1,2})[:h](\d{2})/.exec(heure.trim());
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/** Date/heure de notre match, dans le même format que les colonnes FBI ("26/09/2026" / "11:00"), en fuseau Europe/Paris — jamais une comparaison UTC brute contre un affichage FBI qui est forcément en heure locale. */
function ourDateTimeParts(matchDatetime: string | null): { date: string; time: string } | null {
  if (!matchDatetime) return null;
  const parsed = new Date(matchDatetime);
  if (Number.isNaN(parsed.getTime())) return null;

  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(parsed);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  return { date: `${get("day")}/${get("month")}/${get("year")}`, time: `${get("hour")}:${get("minute")}` };
}

/**
 * Fonction PURE (aucune IO) : compare le listing FBI d'un club (les DEUX
 * passes "non joué" coché/décoché, voir `BrowserFbiClient.fetchScheduleRows`)
 * à ses rencontres FFBB déjà synchronisées, et produit la liste des
 * anomalies détectées. `ourMatches` doit couvrir TOUTES les rencontres du
 * club pour cette saison (pas seulement une page) — une rencontre absente
 * de `ourMatches` mais présente côté FFBB produirait un faux
 * `missing_in_ffbb`.
 */
export function reconcileFbiSchedule(fbiRows: FbiScheduleRow[], ourMatches: OurMatchForReconciliation[]): ScheduleDiscrepancyInput[] {
  const discrepancies: ScheduleDiscrepancyInput[] = [];

  const fbiByKey = new Map<string, FbiScheduleRow>();
  for (const row of fbiRows) {
    if (isByeRow(row)) continue;
    const key = reconciliationKey(row.division, row.numero);
    if (key) fbiByKey.set(key, row);
  }

  const ourByKey = new Map<string, OurMatchForReconciliation>();
  for (const match of ourMatches) {
    const key = reconciliationKey(match.competitionCode, match.numero);
    if (key) ourByKey.set(key, match);
  }

  for (const [key, fbiRow] of fbiByKey) {
    const ourMatch = ourByKey.get(key);

    if (!ourMatch) {
      discrepancies.push({
        matchId: null,
        divisionCode: fbiRow.division,
        numero: fbiRow.numero,
        kind: "missing_in_ffbb",
        fieldName: null,
        ffbbValue: null,
        fbiValue: fbiOpponentLabel(fbiRow),
        fbiOpponentName: fbiOpponentLabel(fbiRow),
      });
      continue;
    }

    const fbiDate = fbiRow.dateRencontre;
    const fbiTime = normalizeFbiHeure(fbiRow.heure);
    const ourDateTime = ourDateTimeParts(ourMatch.matchDatetime);

    if (fbiDate && fbiTime && ourDateTime && (fbiDate !== ourDateTime.date || fbiTime !== ourDateTime.time)) {
      discrepancies.push({
        matchId: ourMatch.id,
        divisionCode: fbiRow.division,
        numero: fbiRow.numero,
        kind: "mismatch",
        fieldName: "match_datetime",
        ffbbValue: `${ourDateTime.date} ${ourDateTime.time}`,
        fbiValue: `${fbiDate} ${fbiTime}`,
        fbiOpponentName: fbiOpponentLabel(fbiRow),
      });
    }
  }

  for (const [key, ourMatch] of ourByKey) {
    if (fbiByKey.has(key)) continue;
    // Une rencontre ANNULÉE côté FFBB n'a normalement jamais existé côté
    // FBI non plus — son absence est attendue, jamais une anomalie.
    if (ourMatch.status === "cancelled") continue;

    discrepancies.push({
      matchId: ourMatch.id,
      divisionCode: ourMatch.competitionCode,
      numero: ourMatch.numero,
      kind: "missing_in_fbi",
      fieldName: null,
      ffbbValue: null,
      fbiValue: null,
      fbiOpponentName: null,
    });
  }

  return discrepancies;
}
