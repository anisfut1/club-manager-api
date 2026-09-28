import { DEFAULT_MATCH_DURATION_MINUTES, DEFAULT_TRAVEL_BUFFER_MINUTES } from "./suggestion-policy.js";

export interface TimeWindow {
  start: Date;
  end: Date;
}

/**
 * Fenêtre horaire d'un match (§5/§6 de la demande) : `matchDatetime` →
 * `matchDatetime + durationMinutes`. `travelBufferMinutes` ÉTEND la fenêtre
 * des DEUX côtés avant le test de chevauchement (§15 : point d'extension
 * futur, à 0 en V1 — voir `DEFAULT_TRAVEL_BUFFER_MINUTES`). Fonction PURE
 * (§35), aucune dépendance à `Date.now()`.
 */
export function computeMatchWindow(
  matchDatetime: Date,
  durationMinutes: number = DEFAULT_MATCH_DURATION_MINUTES,
  travelBufferMinutes: number = DEFAULT_TRAVEL_BUFFER_MINUTES,
): TimeWindow {
  const bufferMs = travelBufferMinutes * 60_000;
  const start = new Date(matchDatetime.getTime() - bufferMs);
  const end = new Date(matchDatetime.getTime() + durationMinutes * 60_000 + bufferMs);
  return { start, end };
}

/**
 * Règle de chevauchement centrale (§6 de la demande) : `aStart < bEnd ET
 * bStart < aEnd`. Volontairement STRICT (pas `<=`) : deux créneaux qui se
 * touchent exactement (15:00→17:00 et 17:00→19:00) NE se chevauchent PAS —
 * une équipe qui joue à 17h peut faire la table du match de 15h (§6/§54).
 */
export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}
