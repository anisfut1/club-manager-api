import { z } from "./zod.js";

export const PurgeEmarqueDocumentsResultDtoSchema = z
  .object({
    documentsExamined: z.number(),
    documentsPurged: z.number(),
    errors: z.number(),
  })
  .openapi("PurgeEmarqueDocumentsResultDto");

export type PurgeEmarqueDocumentsResultDto = z.infer<typeof PurgeEmarqueDocumentsResultDtoSchema>;

export const DeleteOldSeasonsDtoSchema = z
  .object({
    clubId: z.string().uuid(),
  })
  .openapi("DeleteOldSeasonsDto");

export type DeleteOldSeasonsDto = z.infer<typeof DeleteOldSeasonsDtoSchema>;

export const DeleteOldSeasonsResultDtoSchema = z
  .object({
    matchesDeleted: z.number(),
    seasonStart: z.string(),
  })
  .openapi("DeleteOldSeasonsResultDto");

export type DeleteOldSeasonsResultDto = z.infer<typeof DeleteOldSeasonsResultDtoSchema>;

export const RetryFailedEmarqueImportsResultDtoSchema = z
  .object({
    matchesExamined: z.number(),
    matchesRetried: z.number(),
    matchesSkippedNoFile: z.number(),
  })
  .openapi("RetryFailedEmarqueImportsResultDto");

export type RetryFailedEmarqueImportsResultDto = z.infer<typeof RetryFailedEmarqueImportsResultDtoSchema>;
