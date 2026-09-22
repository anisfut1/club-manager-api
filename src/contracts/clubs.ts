import { z } from "./zod.js";
import { ClubRoleSchema } from "./common.js";
import { isValidTimeZone } from "../util/timezone.js";

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
    /**
     * Code club FFBB public (ex: "OCC0034008") — nommé explicitement
     * `ffbbClubCode` (jamais `ffbbClubId`, gap 2 de la demande) pour ne
     * jamais le confondre avec l'UUID interne du club (`id`) ni avec un
     * éventuel identifiant Directus. Modification via
     * `PATCH /v1/clubs/:clubId/integrations/ffbb`, jamais ce DTO.
     */
    ffbbClubCode: z.string(),
  })
  .openapi("ClubDto");

export type ClubDto = z.infer<typeof ClubDtoSchema>;

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/**
 * PATCH /v1/clubs/:clubId (gap 1 de la demande) — UNIQUEMENT le branding
 * léger, exactement les colonnes que la RLS autorise déjà un club_admin à
 * écrire (`grant update (name, short_name, logo_url, accent_color,
 * timezone) on public.clubs`, voir supabase/migrations/
 * 20260921100090_rls_multitenant_rewrite.sql) — jamais `slug`, `status`,
 * `ffbbClubCode`/`ffbb_club_id`, ni aucune donnée d'intégration FBI : ce
 * DTO ne peut structurellement pas les accepter.
 */
export const UpdateClubDtoSchema = z
  .object({
    name: z.string().trim().min(1, "Le nom du club ne peut pas être vide.").optional(),
    shortName: z.string().trim().min(1).nullable().optional(),
    timezone: z
      .string()
      .refine(isValidTimeZone, { message: "Fuseau horaire invalide (attendu un identifiant IANA, ex: Europe/Paris)." })
      .optional(),
    logoUrl: z.string().url("logoUrl doit être une URL valide.").nullable().optional(),
    accentColor: z
      .string()
      .regex(HEX_COLOR_PATTERN, "accentColor doit être une couleur hexadécimale à 6 chiffres (ex: #1A2B3C).")
      .nullable()
      .optional(),
  })
  .openapi("UpdateClubDto");

export type UpdateClubDto = z.infer<typeof UpdateClubDtoSchema>;

export const TeamDtoSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    category: z.string().nullable(),
    active: z.boolean(),
  })
  .openapi("TeamDto");

export type TeamDto = z.infer<typeof TeamDtoSchema>;
