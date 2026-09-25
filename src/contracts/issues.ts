import { z } from "./zod.js";
import { QualityWarningDtoSchema } from "./emarque.js";

/**
 * Une "issue" est dérivée soit de `matches.emarque_status`
 * (error/needs_review, voir docs/EMARQUE.md), soit d'une ligne ouverte de
 * `fbi_schedule_discrepancies` (rapprochement calendrier FFBB/FBI, voir
 * docs/FBI.md — uniquement pour les clubs ayant FBI configuré). `message`
 * est TOUJOURS un texte prêt à afficher (jamais une erreur interne brute,
 * §9/§29 de la demande) ; `technicalCode` est l'identifiant machine stable
 * pour un traitement programmatique côté frontend (ex: styliser
 * différemment un `EMARQUE_IMPORT_ERROR` d'un `EMARQUE_NEEDS_REVIEW`).
 *
 * `matchId` est `null` pour un `fbi_schedule_missing_in_ffbb` (une
 * rencontre vue sur FBI mais SANS ligne `matches` correspondante — rien à
 * lier).
 */
export const IssueDtoSchema = z
  .object({
    matchId: z.string().uuid().nullable(),
    numero: z.string().nullable(),
    opponentName: z.string().nullable(),
    matchDatetime: z.string().nullable(),
    integration: z.enum(["emarque", "fbi_schedule"]),
    type: z.enum(["emarque_import_error", "emarque_needs_review", "fbi_schedule_mismatch", "fbi_schedule_missing_in_ffbb", "fbi_schedule_missing_in_fbi"]),
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
