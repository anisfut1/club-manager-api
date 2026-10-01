import { z } from "./zod.js";

/**
 * Classements FFBB des poules où le club est engagé (retour du club,
 * 2026-10-01 : "et même le classement si on pousse le truc qui est dispo
 * sur FFBB et important quand même"). Valeurs telles que publiées par la
 * FFBB (copiées à chaque synchronisation) — jamais recalculées ici.
 */
export const StandingRowDtoSchema = z
  .object({
    position: z.number().nullable(),
    teamName: z.string(),
    logoUrl: z.string().nullable(),
    points: z.number().nullable(),
    played: z.number().nullable(),
    won: z.number().nullable(),
    lost: z.number().nullable(),
    draws: z.number().nullable(),
    forfeits: z.number().nullable(),
    pointsFor: z.number().nullable(),
    pointsAgainst: z.number().nullable(),
    difference: z.number().nullable(),
    outOfRanking: z.boolean(),
    /** Ligne d'une équipe du club (engagement FFBB du club). */
    isClub: z.boolean(),
  })
  .openapi("StandingRowDto");

export const PoolStandingsDtoSchema = z
  .object({
    poolId: z.string().uuid(),
    poolName: z.string(),
    competitionName: z.string().nullable(),
    categoryLabel: z.string().nullable(),
    /** Équipe du club engagée dans cette poule (même libellé que `MatchListItemDto.teamName`). */
    teamId: z.string().uuid().nullable(),
    teamName: z.string().nullable(),
    updatedAt: z.string().nullable(),
    rows: z.array(StandingRowDtoSchema),
  })
  .openapi("PoolStandingsDto");

export const PoolStandingsListDtoSchema = z.object({ standings: z.array(PoolStandingsDtoSchema) }).openapi("PoolStandingsListDto");

export type StandingRowDto = z.infer<typeof StandingRowDtoSchema>;
export type PoolStandingsDto = z.infer<typeof PoolStandingsDtoSchema>;
