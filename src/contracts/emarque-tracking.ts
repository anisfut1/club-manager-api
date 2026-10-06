import { z } from "zod";

/**
 * Suivi des statistiques e-Marque (retour du club, 2026-10-06 : "je veux un
 * process clair... avec un process prévu et pas au hasard") — un état
 * lisible par match joué, jamais un message technique brut.
 */
export const EmarqueTrackingStateSchema = z.enum(["waiting", "processing", "published", "needs_review", "error", "not_available"]);

export const EmarqueTrackingMatchDtoSchema = z.object({
  matchId: z.string(),
  numero: z.string().nullable(),
  matchDatetime: z.string().nullable(),
  teamName: z.string().nullable(),
  opponentName: z.string().nullable(),
  isHome: z.boolean().nullable(),
  scoreHome: z.number().nullable(),
  scoreAway: z.number().nullable(),
  state: EmarqueTrackingStateSchema,
  /** Prochain essai automatique prévu (calendrier fixe), `null` si aucun. */
  nextCheckAt: z.string().nullable(),
  /** Dernier essai automatique effectué, `null` si aucun. */
  lastCheckAt: z.string().nullable(),
  /** Résultat du dernier essai, en clair (jamais le message technique brut). */
  lastCheckResult: z.string().nullable(),
  importedAt: z.string().nullable(),
  /** Raisons pour lesquelles les statistiques ne sont pas publiées (état "needs_review"). */
  problems: z.array(z.string()),
  clubPlayersLinked: z.number().int(),
  clubPlayersTotal: z.number().int(),
});

export const EmarqueTrackingDtoSchema = z.object({
  matches: z.array(EmarqueTrackingMatchDtoSchema),
});

export const EmarqueTrackingRelaunchDtoSchema = z.object({
  matchId: z.string(),
  nextCheckAt: z.string(),
});

export type EmarqueTrackingState = z.infer<typeof EmarqueTrackingStateSchema>;
export type EmarqueTrackingMatchDto = z.infer<typeof EmarqueTrackingMatchDtoSchema>;
export type EmarqueTrackingDto = z.infer<typeof EmarqueTrackingDtoSchema>;
export type EmarqueTrackingRelaunchDto = z.infer<typeof EmarqueTrackingRelaunchDtoSchema>;
