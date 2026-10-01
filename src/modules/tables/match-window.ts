import { computeMatchWindow as computeSharedMatchWindow, intervalsOverlap, type TimeWindow } from "../../scheduling/match-slot.js";
import { DEFAULT_MATCH_DURATION_MINUTES, DEFAULT_TRAVEL_BUFFER_MINUTES } from "./suggestion-policy.js";

/**
 * Les Tables de marque réutilisent la définition partagée d'un créneau
 * (`src/scheduling/match-slot.ts`, source de vérité unique) ; seul le
 * temps de trajet propre à ce module (`DEFAULT_TRAVEL_BUFFER_MINUTES`) est
 * appliqué ici par défaut.
 */
export { intervalsOverlap, type TimeWindow };

export function computeMatchWindow(
  matchDatetime: Date,
  durationMinutes: number = DEFAULT_MATCH_DURATION_MINUTES,
  travelBufferMinutes: number = DEFAULT_TRAVEL_BUFFER_MINUTES,
): TimeWindow {
  return computeSharedMatchWindow(matchDatetime, durationMinutes, travelBufferMinutes);
}
