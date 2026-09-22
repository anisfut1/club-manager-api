import { z } from "./zod";
import { QualityWarningDtoSchema } from "./emarque";

/**
 * Une "issue" est dérivée de `matches.emarque_status` (error/needs_review)
 * — pas de table dédiée, voir docs/EMARQUE.md. `message` est TOUJOURS un
 * texte prêt à afficher (jamais une erreur interne brute, §9/§29 de la
 * demande) ; `technicalCode` est l'identifiant machine stable pour un
 * traitement programmatique côté frontend (ex: styliser différemment un
 * `EMARQUE_IMPORT_ERROR` d'un `EMARQUE_NEEDS_REVIEW`).
 */
export const IssueDtoSchema = z
  .object({
    matchId: z.string().uuid(),
    numero: z.string().nullable(),
    opponentName: z.string().nullable(),
    matchDatetime: z.string().nullable(),
    integration: z.literal("emarque"),
    type: z.enum(["emarque_import_error", "emarque_needs_review"]),
    severity: z.enum(["warning", "error"]),
    /** Toujours "open" pour l'instant : cette liste n'expose que les anomalies non résolues (voir POST .../resolve). Champ conservé pour absorber sans rupture une future liste incluant les anomalies résolues. */
    status: z.literal("open"),
    message: z.string(),
    technicalCode: z.string(),
    qualityWarnings: z.array(QualityWarningDtoSchema),
    createdAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
  })
  .openapi("IssueDto");

export type IssueDto = z.infer<typeof IssueDtoSchema>;
