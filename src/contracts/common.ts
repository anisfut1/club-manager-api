import { z } from "./zod.js";

/**
 * DTO partagés (§38 de la demande : jamais un `select('*')` exposé
 * directement — toujours une forme explicite, versionnable indépendamment
 * du schéma DB).
 */
export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      /** Détails structurés optionnels (ex. `DEROGATION_SLOT_CONFLICT` : créneaux en conflit). */
      details: z.unknown().optional(),
    }),
  })
  .openapi("ErrorEnvelope");

export const ClubCapabilitiesSchema = z
  .object({
    ffbb: z.boolean(),
    fbi: z.boolean(),
    emarque: z.boolean(),
  })
  .openapi("ClubCapabilities");

export const ClubRoleSchema = z.enum(["club_admin", "correspondant_club", "responsable_tables", "coach", "joueur", "parent"]).openapi("ClubRole");
