import { z } from "./zod.js";

export const ClubVenueAdminDtoSchema = z
  .object({ id: z.string().uuid(), name: z.string(), address: z.string().nullable(), active: z.boolean(), sortOrder: z.number().int() })
  .openapi("ClubVenueAdminDto");

export const ClubVenueListDtoSchema = z.object({ venues: z.array(ClubVenueAdminDtoSchema) }).openapi("ClubVenueListDto");

export const UpdateClubVenueDtoSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .openapi("UpdateClubVenueDto");
