import { z } from "./zod";

export const PlatformClubDtoSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    ffbbClubId: z.string(),
    status: z.enum(["active", "suspended"]),
    ffbb: z.boolean(),
    fbi: z.boolean(),
    emarque: z.boolean(),
  })
  .openapi("PlatformClubDto");

export type PlatformClubDto = z.infer<typeof PlatformClubDtoSchema>;

export const CreateClubDtoSchema = z
  .object({
    name: z.string().min(1),
    ffbbClubId: z.string().min(1),
    slug: z.string().min(1).optional(),
    timezone: z.string().optional(),
    adminEmail: z.string().email().optional(),
  })
  .openapi("CreateClubDto");
