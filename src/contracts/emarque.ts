import { z } from "./zod";

export const QualityWarningDtoSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    severity: z.enum(["info", "warning", "error"]),
  })
  .openapi("QualityWarningDto");

export type QualityWarningDto = z.infer<typeof QualityWarningDtoSchema>;

/**
 * Erreur "assainie" (gap 5 de la demande, §29 : "lastError sanitized") —
 * jamais le message brut stocké en base (`emarque_imports.last_error`,
 * `match_documents.last_error`), qui peut contenir un détail d'exception
 * interne (message Postgres/Storage brut, jamais garanti sûr à afficher).
 * Seule la PRÉSENCE d'une erreur et une classification générique sont
 * exposées ici — voir `integrations/emarque/sanitize-error.ts`.
 */
export const SanitizedErrorDtoSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .openapi("SanitizedErrorDto");

export type SanitizedErrorDto = z.infer<typeof SanitizedErrorDtoSchema>;

export const EmarqueImportDtoSchema = z
  .object({
    id: z.string().uuid(),
    matchId: z.string().uuid(),
    status: z.enum(["discovered", "downloading", "downloaded", "parsing", "imported", "error", "needs_review"]),
    source: z.literal("fbi"),
    parserVersion: z.string().nullable(),
    discoveredAt: z.string(),
    downloadedAt: z.string().nullable(),
    importedAt: z.string().nullable(),
    qualityWarnings: z.array(QualityWarningDtoSchema),
    lastError: SanitizedErrorDtoSchema.nullable(),
    attemptCount: z.number(),
    nextAttemptAt: z.string().nullable(),
  })
  .openapi("EmarqueImportDto");

export type EmarqueImportDto = z.infer<typeof EmarqueImportDtoSchema>;

export const EmarqueImportsQueryDtoSchema = z.object({
  matchId: z.string().uuid().optional(),
  status: z.enum(["discovered", "downloading", "downloaded", "parsing", "imported", "error", "needs_review"]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type EmarqueImportsQueryDto = z.infer<typeof EmarqueImportsQueryDtoSchema>;
