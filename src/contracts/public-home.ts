import { z } from "./zod.js";
import { MatchListItemDtoSchema } from "./matches.js";
import { TableAssignmentRoleSchema } from "./tables.js";

/**
 * Accueil PERSONNEL de l'espace public (lien personnel) — retour du club,
 * 2026-10-01 : « un onglet accueil pour les coachs : son agenda avec les
 * matchs de ses équipes et où il doit coacher. Pareil pour le joueur : en
 * fonction de sa licence, on sait son équipe et par défaut on lui met un
 * accueil sur son équipe et autres infos ».
 */
export const HomeRelationSchema = z.enum(["PLAYER", "COACH"]).openapi("HomeRelation");

export const PublicHomeDtoSchema = z
  .object({
    licencie: z.object({ id: z.string().uuid(), firstName: z.string(), lastName: z.string() }),
    roles: z.object({ coach: z.boolean(), coordinator: z.boolean(), admin: z.boolean() }),
    teams: z.array(z.object({ id: z.string().uuid(), name: z.string(), relation: HomeRelationSchema })),
    /** Prochains matchs de ses équipes (jouées ET coachées), du plus proche au plus lointain. */
    upcoming: z.array(z.object({ match: MatchListItemDtoSchema, relations: z.array(HomeRelationSchema) })),
    /** Derniers résultats de ses équipes. */
    recentResults: z.array(z.object({ match: MatchListItemDtoSchema, relations: z.array(HomeRelationSchema) })),
    /** Ses prochaines tables de marque. */
    tableDuties: z.array(
      z.object({
        matchId: z.string().uuid(),
        role: TableAssignmentRoleSchema,
        matchDatetime: z.string().nullable(),
        teamName: z.string().nullable(),
        opponentName: z.string().nullable(),
        venueLabel: z.string().nullable(),
      }),
    ),
  })
  .openapi("PublicHomeDto");

export type PublicHomeDto = z.infer<typeof PublicHomeDtoSchema>;
