import { z } from "zod";

/**
 * Dernière barrière de validation avant écriture en base : structure de
 * EMarqueMatchData (voir ../types.ts). N'invente jamais de valeur — un champ
 * manquant reste `null` côté TypeScript ; ce schéma vérifie seulement la
 * FORME, jamais le contenu métier (ça, c'est le rôle de quality/).
 */

const teamSideSchema = z.enum(["home", "away"]);

const qualityWarningCodeSchema = z.enum([
  "MATCH_NUMBER_MISMATCH",
  "SCORE_MISMATCH",
  "LOW_EXTRACTION_CONFIDENCE",
  "PLAYER_LICENSE_MISSING",
  "OTM_LICENSE_MISSING",
  "MINUTES_TOTAL_INCONSISTENT",
  "SHOT_CHART_PARSE_FAILED",
  "DOCUMENT_MISSING",
]);

const playerSchema = z.object({
  teamSide: teamSideSchema,
  jerseyNumber: z.string().nullable(),
  lastName: z.string().nullable(),
  firstName: z.string().nullable(),
  licenseNumber: z.string().nullable(),
  isCaptain: z.boolean(),
  isStarter: z.boolean().nullable(),
  confidence: z.number().nullable(),
});

const coachSchema = z.object({
  teamSide: teamSideSchema,
  role: z.enum(["principal", "adjoint"]),
  lastName: z.string().nullable(),
  firstName: z.string().nullable(),
  licenseNumber: z.string().nullable(),
});

const officialSchema = z.object({
  role: z.enum(["referee_1", "referee_2", "referee_3"]),
  lastName: z.string().nullable(),
  firstName: z.string().nullable(),
  licenseNumber: z.string().nullable(),
});

const tableOfficialSchema = z.object({
  role: z.enum(["scorer", "assistant_scorer", "timekeeper", "shot_clock_operator", "commissioner", "other"]),
  lastName: z.string().nullable(),
  firstName: z.string().nullable(),
  licenseNumber: z.string().nullable(),
  confidence: z.number().nullable(),
});

const playerStatSchema = z.object({
  teamSide: teamSideSchema,
  jerseyNumber: z.string().nullable(),
  lastName: z.string().nullable(),
  firstName: z.string().nullable(),
  secondsPlayed: z.number().nullable(),
  points: z.number().nullable(),
  shotsMade: z.number().nullable(),
  threePointsMade: z.number().nullable(),
  twoPointsInteriorMade: z.number().nullable(),
  twoPointsExteriorMade: z.number().nullable(),
  freeThrowsMade: z.number().nullable(),
  foulsCommitted: z.number().nullable(),
});

export const emarqueMatchDataSchema = z.object({
  match: z.object({
    rencontreNumero: z.string().nullable(),
    competitionLabel: z.string().nullable(),
    pouleLabel: z.string().nullable(),
    date: z.string().nullable(),
    heure: z.string().nullable(),
    lieu: z.string().nullable(),
    homeTeamName: z.string().nullable(),
    awayTeamName: z.string().nullable(),
    homeClubCode: z.string().nullable(),
    awayClubCode: z.string().nullable(),
    scoreHome: z.number().nullable(),
    scoreAway: z.number().nullable(),
    scoreByPeriod: z.array(z.object({ period: z.number(), home: z.number().nullable(), away: z.number().nullable() })),
  }),
  players: z.array(playerSchema),
  coaches: z.array(coachSchema),
  officials: z.array(officialSchema),
  tableOfficials: z.array(tableOfficialSchema),
  playerStats: z.array(playerStatSchema),
  shotData: z.object({ experimental: z.literal(true), documentPresent: z.boolean() }),
  quality: z.object({
    warnings: z.array(
      z.object({
        code: qualityWarningCodeSchema,
        message: z.string(),
        severity: z.enum(["info", "warning", "error"]),
      }),
    ),
    overallConfidence: z.number().nullable(),
  }),
});

export type ValidatedEMarqueMatchData = z.infer<typeof emarqueMatchDataSchema>;
