import { zonedWallTimeToUtc } from "../../util/timezone.js";
import { matchSlotsOverlap } from "../../scheduling/match-slot.js";

/**
 * Détection de conflit de créneau pour une dérogation demandant un
 * changement de date/heure — demande du club, 2026-09-26 : "il faut aussi
 * avoir des alertes dans dérog en mode match en cours a la date demandée
 * (en sachant qu'un créneau de match est de 2h, donc si jai un match à 15h
 * avec une demande de dérog dun autre match a 16h, il faut dire qu'il y a
 * un match prévu en prenant le créneau du match de 15h)".
 *
 * Fonction PURE (aucune IO) — même esprit que
 * `integrations/fbi/schedule-reconciliation.ts` : la robustesse
 * date/fuseau reste testable indépendamment de Supabase/FBI.
 */

/** Un match du club (jamais celui de la dérogation elle-même) pouvant entrer en conflit. */
export interface OtherMatchSlot {
  id: string;
  numero: string | null;
  opponentName: string | null;
  /** ISO, jamais `null` — un match sans date connue ne peut définir aucun créneau. */
  matchDatetime: string;
  /**
   * Nom de L'ÉQUIPE DU CLUB engagée sur ce match (`teams.name`) — demande du
   * club, 2026-09-27 : "sur le bandeau rouge faut dire aussi c le match de
   * quelle equipe en conflit" (un club a plusieurs équipes, "Rencontre 9608"
   * seul ne dit pas laquelle).
   */
  teamName: string | null;
}

export interface ScheduleConflict {
  matchId: string;
  numero: string | null;
  opponentName: string | null;
  matchDatetime: string;
  teamName: string | null;
}

function parseFrenchDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  return { day: Number(match[1]), month: Number(match[2]), year: Number(match[3]) };
}

function parseFrenchTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * `dateRencontreDemandee`/`heureDemandee` viennent de la page de détail FBI,
 * toujours en heure LOCALE FRANÇAISE (comme `schedule-reconciliation.ts`,
 * jamais le fuseau `club.timezone` — FBI ne connaît que la France) —
 * convertis en instant UTC réel (DST-safe) puis comparés, créneau de 2h
 * contre créneau de 2h, à CHAQUE autre match déjà programmé du club.
 * Renvoie le PREMIER match en conflit trouvé (`null` si aucun, si les
 * champs demandés sont absents/imparsables, ou si l'unique "conflit"
 * serait le match de la dérogation elle-même).
 */
export function findScheduleConflict(
  dateRencontreDemandee: string | null,
  heureDemandee: string | null,
  excludeMatchId: string,
  otherMatches: readonly OtherMatchSlot[],
): ScheduleConflict | null {
  if (!dateRencontreDemandee || !heureDemandee) return null;
  const date = parseFrenchDate(dateRencontreDemandee);
  const time = parseFrenchTime(heureDemandee);
  if (!date || !time) return null;

  const requestedStart = zonedWallTimeToUtc(date.year, date.month, date.day, time.hour, time.minute, 0, "Europe/Paris");

  for (const match of otherMatches) {
    if (match.id === excludeMatchId) continue;
    const matchStart = new Date(match.matchDatetime);
    if (Number.isNaN(matchStart.getTime())) continue;
    // Même définition de créneau (120 min) et même règle de chevauchement que tout le reste de l'API (src/scheduling/match-slot.ts).
    if (matchSlotsOverlap(requestedStart, matchStart)) {
      return { matchId: match.id, numero: match.numero, opponentName: match.opponentName, matchDatetime: match.matchDatetime, teamName: match.teamName };
    }
  }
  return null;
}
