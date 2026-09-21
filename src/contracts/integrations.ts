import { z } from "./zod";

export const IntegrationStatusDtoSchema = z
  .object({
    ffbb: z.object({
      enabled: z.boolean(),
      lastSyncAt: z.string().nullable(),
      lastSyncStatus: z.string().nullable(),
    }),
    fbi: z.object({
      configured: z.boolean(),
      connected: z.boolean(),
      lastLoginAt: z.string().nullable(),
      autoImportEmarque: z.boolean(),
      lastError: z.string().nullable(),
    }),
  })
  .openapi("IntegrationStatusDto");

export type IntegrationStatusDto = z.infer<typeof IntegrationStatusDtoSchema>;

export const SaveFbiCredentialsDtoSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1).optional(),
  })
  .openapi("SaveFbiCredentialsDto");

export const SyncRunDtoSchema = z
  .object({
    id: z.string().uuid(),
    provider: z.enum(["ffbb", "fbi"]),
    status: z.enum(["running", "success", "partial", "error"]),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    errorLog: z.string().nullable(),
  })
  .openapi("SyncRunDto");

export type SyncRunDto = z.infer<typeof SyncRunDtoSchema>;
