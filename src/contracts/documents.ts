import { z } from "./zod.js";

export const MatchDocumentDtoSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(["emarque_zip", "match_sheet", "summary", "shot_chart", "other"]),
    filename: z.string().nullable(),
    mimeType: z.string().nullable(),
    status: z.enum(["downloaded", "parsing", "imported", "error"]),
    discoveredAt: z.string(),
    downloadedAt: z.string().nullable(),
    /** Présent uniquement pour un club_admin (§34 de la demande) ET si le fichier n'a pas encore été purgé (`purged: false`) : URL signée courte durée, jamais publique/permanente. */
    downloadUrl: z.string().nullable(),
    /**
     * `true` une fois le fichier original supprimé de Storage après parsing
     * (retour du club, 2026-09-29 : "je veux juste l'interpréter... pas la
     * stocker", voir docs/EMARQUE.md) — les stats déjà extraites restent
     * intactes en base, seul le fichier original a disparu. `downloadUrl`
     * vaut alors toujours `null`, quel que soit le rôle de l'appelant.
     */
    purged: z.boolean(),
  })
  .openapi("MatchDocumentDto");

export type MatchDocumentDto = z.infer<typeof MatchDocumentDtoSchema>;
