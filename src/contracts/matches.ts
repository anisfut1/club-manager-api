import { z } from "./zod";

export const MatchListItemDtoSchema = z
  .object({
    id: z.string().uuid(),
    numero: z.string().nullable(),
    journee: z.string().nullable(),
    matchDatetime: z.string().nullable(),
    isHome: z.boolean().nullable(),
    teamName: z.string().nullable(),
    opponentName: z.string().nullable(),
    venueLabel: z.string().nullable(),
    scoreHome: z.number().nullable(),
    scoreAway: z.number().nullable(),
    status: z.enum(["scheduled", "played", "postponed", "cancelled", "forfeit"]),
    emarqueStatus: z.string(),
  })
  .openapi("MatchListItemDto");

export type MatchListItemDto = z.infer<typeof MatchListItemDtoSchema>;

export const PlayerMatchStatsDtoSchema = z
  .object({
    participantId: z.string().uuid(),
    teamSide: z.enum(["home", "away"]),
    jerseyNumber: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    secondsPlayed: z.number().nullable(),
    points: z.number().nullable(),
    threePointsMade: z.number().nullable(),
    twoPointsInteriorMade: z.number().nullable(),
    twoPointsExteriorMade: z.number().nullable(),
    freeThrowsMade: z.number().nullable(),
    foulsCommitted: z.number().nullable(),
  })
  .openapi("PlayerMatchStatsDto");

export type PlayerMatchStatsDto = z.infer<typeof PlayerMatchStatsDtoSchema>;

export const MatchParticipantDtoSchema = z
  .object({
    id: z.string().uuid(),
    teamSide: z.enum(["home", "away"]),
    jerseyNumber: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    isCaptain: z.boolean(),
    isStarter: z.boolean().nullable(),
    licencieId: z.string().uuid().nullable(),
  })
  .openapi("MatchParticipantDto");

export const MatchCoachDtoSchema = z
  .object({
    teamSide: z.enum(["home", "away"]),
    role: z.enum(["principal", "adjoint"]),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    licencieId: z.string().uuid().nullable(),
  })
  .openapi("MatchCoachDto");

export const MatchOfficialDtoSchema = z
  .object({
    role: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    licencieId: z.string().uuid().nullable(),
  })
  .openapi("MatchOfficialDto");

export const EmarqueSummaryDtoSchema = z
  .object({
    status: z.string(),
    source: z.string().nullable(),
    lastRetrievedAt: z.string().nullable(),
    qualityWarningCount: z.number().nullable(),
  })
  .openapi("EmarqueSummaryDto");

export const MatchDetailsDtoSchema = z
  .object({
    id: z.string().uuid(),
    numero: z.string().nullable(),
    journee: z.string().nullable(),
    matchDatetime: z.string().nullable(),
    isHome: z.boolean().nullable(),
    teamName: z.string().nullable(),
    opponentName: z.string().nullable(),
    venueLabel: z.string().nullable(),
    scoreHome: z.number().nullable(),
    scoreAway: z.number().nullable(),
    status: z.enum(["scheduled", "played", "postponed", "cancelled", "forfeit"]),
    emarque: EmarqueSummaryDtoSchema,
    participants: z.array(MatchParticipantDtoSchema),
    coaches: z.array(MatchCoachDtoSchema),
    officials: z.array(MatchOfficialDtoSchema),
    tableOfficials: z.array(MatchOfficialDtoSchema),
    stats: z.array(PlayerMatchStatsDtoSchema),
  })
  .openapi("MatchDetailsDto");

export type MatchDetailsDto = z.infer<typeof MatchDetailsDtoSchema>;
