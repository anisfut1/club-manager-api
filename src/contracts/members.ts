import { z } from "./zod.js";
import { ClubRoleSchema } from "./common.js";

/**
 * Membres d'un club et leurs rôles (`club_memberships` + `membership_roles`,
 * RBAC existant — jamais un second système). Nécessaire aux demandes de
 * dérogation : désigner les coachs (portée équipe) et le coordinateur
 * (`correspondant_club`, libellé « Coordinateur »). `club_admin` uniquement.
 */
export const RoleGrantDtoSchema = z
  .object({
    role: ClubRoleSchema,
    /** Portée équipe (coach) ; `null` = toutes les équipes du club. */
    scopeTeamId: z.string().uuid().nullable(),
  })
  .openapi("RoleGrantDto");

export const ClubMemberDtoSchema = z
  .object({
    membershipId: z.string().uuid(),
    userId: z.string().uuid(),
    email: z.string().nullable(),
    displayName: z.string().nullable(),
    status: z.enum(["active", "suspended"]),
    licencie: z.object({ id: z.string().uuid(), firstName: z.string(), lastName: z.string() }).nullable(),
    roles: z.array(RoleGrantDtoSchema),
    isMe: z.boolean(),
  })
  .openapi("ClubMemberDto");

export const ClubMemberListDtoSchema = z.object({ members: z.array(ClubMemberDtoSchema) }).openapi("ClubMemberListDto");

export const SetMemberRolesDtoSchema = z.object({ roles: z.array(RoleGrantDtoSchema).max(30) }).strict().openapi("SetMemberRolesDto");

export const InviteMemberDtoSchema = z
  .object({
    email: z.string().trim().email("Adresse email invalide."),
    roles: z.array(RoleGrantDtoSchema).min(1, "Choisis au moins un rôle.").max(30),
  })
  .strict()
  .openapi("InviteMemberDto");
