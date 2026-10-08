import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { badRequest, conflict, notFound } from "../../api-error.js";
import { createServiceSupabaseClient, type DbClient } from "../../db/client.js";
import type { ClubRole } from "../../db/types.js";
import { InviteMemberDtoSchema, SetMemberRolesDtoSchema } from "../../contracts/members.js";
import { provisionClubAccount } from "../../auth/account-invites.js";

/**
 * Gestion légère des membres et rôles d'un club (`club_admin`) — retour du
 * club, 2026-10-01 : les demandes de dérogation exigent de désigner les
 * coachs de chaque équipe et le coordinateur. Réutilise `club_memberships`
 * / `membership_roles` (aucun RBAC parallèle). Écritures via le client
 * service APRÈS vérification `club_admin` (la RLS `membership_roles_*`
 * réserve aussi ces écritures au club_admin).
 */

export const membersRouter = new Hono<AppEnv>();
membersRouter.use("*", requireAuth);
membersRouter.use("*", requireClubMembership);
membersRouter.use("*", requireClubRole("club_admin"));

interface Grant {
  role: ClubRole;
  scopeTeamId: string | null;
}

async function assertTeamsBelongToClub(db: DbClient, clubId: string, grants: readonly Grant[]): Promise<void> {
  const teamIds = [...new Set(grants.map((g) => g.scopeTeamId).filter((id): id is string => id !== null))];
  if (teamIds.length === 0) return;
  const { data } = await db.from("teams").select("id").eq("club_id", clubId).in("id", teamIds);
  if ((data ?? []).length !== teamIds.length) throw badRequest("Une des équipes choisies n'appartient pas à ce club.", "UNKNOWN_TEAM");
}

function dedupe(grants: readonly Grant[]): Grant[] {
  const seen = new Set<string>();
  return grants.filter((g) => {
    const key = `${g.role}:${g.scopeTeamId ?? "*"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function replaceRoles(db: DbClient, membershipId: string, grants: readonly Grant[]): Promise<void> {
  const { error: deleteError } = await db.from("membership_roles").delete().eq("membership_id", membershipId);
  if (deleteError) throw new Error(`Mise à jour des rôles échouée : ${deleteError.message}`);
  if (grants.length === 0) return;
  const { error } = await db.from("membership_roles").insert(grants.map((g) => ({ membership_id: membershipId, role: g.role, scope_team_id: g.scopeTeamId })));
  if (error) throw new Error(`Mise à jour des rôles échouée : ${error.message}`);
}

export async function listMembers(db: DbClient, clubId: string, currentUserId: string) {
  const { data: memberships, error } = await db.from("club_memberships").select("id, user_id, status, licencie_id").eq("club_id", clubId);
  if (error) throw new Error(`Lecture des membres échouée : ${error.message}`);
  const rows = memberships ?? [];
  const ids = rows.map((m) => m.id);
  const userIds = rows.map((m) => m.user_id);
  const licencieIds = rows.map((m) => m.licencie_id).filter((id): id is string => Boolean(id));
  const [{ data: roles }, { data: profiles }, { data: licencies }] = await Promise.all([
    ids.length ? db.from("membership_roles").select("membership_id, role, scope_team_id").in("membership_id", ids) : Promise.resolve({ data: [] as { membership_id: string; role: ClubRole; scope_team_id: string | null }[] }),
    userIds.length ? db.from("profiles").select("user_id, display_name").in("user_id", userIds) : Promise.resolve({ data: [] as { user_id: string; display_name: string | null }[] }),
    licencieIds.length ? db.from("licencies").select("id, first_name, last_name").in("id", licencieIds) : Promise.resolve({ data: [] as { id: string; first_name: string; last_name: string }[] }),
  ]);

  const emails = new Map<string, string | null>();
  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const { data } = await db.auth.admin.getUserById(userId);
        emails.set(userId, data.user?.email ?? null);
      } catch {
        emails.set(userId, null);
      }
    }),
  );

  const profileByUser = new Map((profiles ?? []).map((p) => [p.user_id, p.display_name]));
  const licencieById = new Map((licencies ?? []).map((l) => [l.id, l]));
  return rows
    .map((m) => {
      const licencie = m.licencie_id ? licencieById.get(m.licencie_id) : undefined;
      return {
        membershipId: m.id,
        userId: m.user_id,
        email: emails.get(m.user_id) ?? null,
        displayName: profileByUser.get(m.user_id) ?? null,
        status: m.status as "active" | "suspended",
        licencie: licencie ? { id: licencie.id, firstName: licencie.first_name, lastName: licencie.last_name } : null,
        roles: (roles ?? []).filter((r) => r.membership_id === m.id).map((r) => ({ role: r.role, scopeTeamId: r.scope_team_id ?? null })),
        isMe: m.user_id === currentUserId,
      };
    })
    .sort((a, b) => (a.displayName ?? a.email ?? "").localeCompare(b.displayName ?? b.email ?? "", "fr"));
}

/** GET /v1/clubs/:clubId/members */
membersRouter.get("/", async (c) => {
  const { club } = c.get("club");
  return c.json({ members: await listMembers(createServiceSupabaseClient(), club.id, c.get("user").id) });
});

/** PUT /v1/clubs/:clubId/members/:membershipId/roles — remplace les rôles d'un membre. */
membersRouter.put("/:membershipId/roles", async (c) => {
  const body = SetMemberRolesDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const { club, membershipId: myMembershipId } = c.get("club");
  const db = createServiceSupabaseClient();
  const membershipId = c.req.param("membershipId");

  const { data: membership } = await db.from("club_memberships").select("id, club_id").eq("id", membershipId).eq("club_id", club.id).maybeSingle();
  if (!membership) throw notFound("Membre introuvable.");

  const grants = dedupe(body.data.roles);
  if (membershipId === myMembershipId && !grants.some((g) => g.role === "club_admin")) {
    throw conflict("Tu ne peux pas retirer ton propre rôle d'administrateur (demande à un autre administrateur).", "CANNOT_REMOVE_OWN_ADMIN");
  }
  await assertTeamsBelongToClub(db, club.id, grants);
  await replaceRoles(db, membershipId, grants);

  return c.json({ members: await listMembers(db, club.id, c.get("user").id) });
});

/** POST /v1/clubs/:clubId/members — invite (ou rattache) un compte par email avec ses rôles. */
membersRouter.post("/", async (c) => {
  const body = InviteMemberDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const { club } = c.get("club");
  const db = createServiceSupabaseClient();
  const grants = dedupe(body.data.roles);
  await assertTeamsBelongToClub(db, club.id, grants);

  const email = body.data.email.toLowerCase();
  // Compte + email Ball Manager (invitation ou « nouvel accès »), jamais l'email brut de Supabase Auth.
  const account = await provisionClubAccount(db, {
    email,
    club: { slug: club.slug, name: club.name, logoUrl: club.logoUrl ?? null, accentColor: club.accentColor ?? null },
    roles: grants.map((g) => g.role),
  });

  const { data: membership, error } = await db.from("club_memberships").upsert({ club_id: club.id, user_id: account.userId, status: "active" }, { onConflict: "club_id,user_id" }).select("id").single();
  if (error || !membership) throw new Error(`Création du membre échouée : ${error?.message}`);
  await replaceRoles(db, membership.id, grants);
  try {
    await account.sendEmail();
  } catch {
    throw badRequest("Membre ajouté, mais l'email n'a pas pu partir. Réessaie dans quelques minutes pour le renvoyer.", "EMAIL_SEND_FAILED");
  }

  return c.json({ members: await listMembers(db, club.id, c.get("user").id) }, 201);
});
