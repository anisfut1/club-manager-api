import { z } from "./zod";
import { ClubRoleSchema } from "./common";

export const ClubDtoSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    shortName: z.string().nullable(),
    logoUrl: z.string().nullable(),
    accentColor: z.string().nullable(),
    timezone: z.string(),
    status: z.enum(["active", "suspended"]),
    roles: z.array(ClubRoleSchema),
  })
  .openapi("ClubDto");

export type ClubDto = z.infer<typeof ClubDtoSchema>;

export const TeamDtoSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    category: z.string().nullable(),
    active: z.boolean(),
  })
  .openapi("TeamDto");

export type TeamDto = z.infer<typeof TeamDtoSchema>;
