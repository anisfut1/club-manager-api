import { z } from "./zod.js";
import { ClubMemberDtoSchema } from "./members.js";

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

/** Membres d'un club vus par le platform_admin (retour du club, 2026-10-08 : « dans l'espace clubs, voir les admins et qui je mets admin »). */
export const PlatformClubMembersDtoSchema = z
  .object({
    club: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string() }),
    members: z.array(ClubMemberDtoSchema),
  })
  .openapi("PlatformClubMembersDto");

export const GrantClubAdminDtoSchema = z.object({ email: z.string().trim().email("Adresse email invalide.") }).strict().openapi("GrantClubAdminDto");
