import { z } from "./zod";

export const MatchDocumentDtoSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(["emarque_zip", "match_sheet", "summary", "shot_chart", "other"]),
    filename: z.string().nullable(),
    status: z.enum(["downloaded", "parsing", "imported", "error"]),
    downloadedAt: z.string().nullable(),
    /** Présent uniquement pour un club_admin (§34 de la demande) : URL signée courte durée, jamais publique/permanente. */
    downloadUrl: z.string().nullable(),
  })
  .openapi("MatchDocumentDto");

export type MatchDocumentDto = z.infer<typeof MatchDocumentDtoSchema>;
