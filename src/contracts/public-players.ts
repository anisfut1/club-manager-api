import { z } from "./zod.js";
import { TableAssignmentRoleSchema } from "./tables.js";

/**
 * Fiche joueur PUBLIQUE (retour du club, 2026-10-08 : « un accès public à
 * la fiche joueur : nom, prénom, photo, derniers matchs, équipes, nombre de
 * tables effectuées et autres infos publiques »). Uniquement ce que
 * l'espace public montre déjà ailleurs (feuilles de match, tables de
 * marque) : jamais de date de naissance, e-mail, téléphone, numéro de
 * licence, ni les accès de l'espace public (admin/coach/coordinateur).
 */
export const PublicPlayerMatchDtoSchema = z
  .object({
    matchId: z.string().uuid(),
    matchDatetime: z.string().nullable(),
    teamName: z.string().nullable(),
    opponentName: z.string().nullable(),
    isHome: z.boolean(),
    scoreHome: z.number().int().nullable(),
    scoreAway: z.number().int().nullable(),
    /** Résultat de SON équipe, `null` sans score officiel (jamais deviné). */
    result: z.enum(["WIN", "LOSS", "DRAW"]).nullable(),
    jerseyNumber: z.string().nullable(),
    isCaptain: z.boolean(),
    isStarter: z.boolean(),
    /** Statistiques e-Marque, `null` si non lues pour ce match. */
    points: z.number().int().nullable(),
    threePointsMade: z.number().int().nullable(),
    freeThrowsMade: z.number().int().nullable(),
    secondsPlayed: z.number().int().nullable(),
  })
  .openapi("PublicPlayerMatchDto");

export type PublicPlayerMatchDto = z.infer<typeof PublicPlayerMatchDtoSchema>;

export const PublicPlayerProfileDtoSchema = z
  .object({
    player: z.object({
      id: z.string().uuid(),
      firstName: z.string(),
      lastName: z.string(),
      photoUrl: z.string().nullable(),
      categoryLabel: z.string().nullable(),
      sexe: z.enum(["M", "F"]).nullable(),
    }),
    /** Équipes où il/elle joue (équipe de la fiche + équipes des matchs disputés cette saison) et équipes coachées. */
    teams: z.array(z.object({ id: z.string().uuid(), name: z.string(), relation: z.enum(["PLAYER", "COACH"]) })),
    /** Saison en cours, matchs publiés uniquement (feuille e-Marque lue et vérifiée). */
    season: z.object({
      matchesPlayed: z.number().int(),
      /** Matchs dont les statistiques ont été lues — base des moyennes. */
      matchesWithStats: z.number().int(),
      totalPoints: z.number().int(),
      pointsPerMatch: z.number().nullable(),
      bestPoints: z.number().int().nullable(),
      bestPointsMatchId: z.string().uuid().nullable(),
      threePointsMade: z.number().int(),
      freeThrowsMade: z.number().int(),
      secondsPlayed: z.number().int(),
      wins: z.number().int(),
      losses: z.number().int(),
    }),
    /** Matchs disputés cette saison, le plus récent d'abord (au plus 10). */
    recentMatches: z.array(PublicPlayerMatchDtoSchema),
    /** Tables de marque, saison en cours. */
    tables: z.object({
      done: z.number().int(),
      upcoming: z.number().int(),
      byRole: z.array(z.object({ role: TableAssignmentRoleSchema, count: z.number().int() })),
    }),
    /** Prochain match de son équipe (celle de la fiche), `null` sinon. */
    nextMatch: z
      .object({ matchId: z.string().uuid(), matchDatetime: z.string().nullable(), teamName: z.string().nullable(), opponentName: z.string().nullable(), isHome: z.boolean() })
      .nullable(),
  })
  .openapi("PublicPlayerProfileDto");

export type PublicPlayerProfileDto = z.infer<typeof PublicPlayerProfileDtoSchema>;
