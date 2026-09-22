import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requirePlatformAdmin } from "../../auth/middleware.js";
import { createServiceSupabaseClient, type DbClient } from "../../db/client.js";
import { badRequest } from "../../api-error.js";
import { computeClubCapabilities } from "../../tenancy/club-capabilities.js";
import { logError } from "../../logger.js";
import type { PlatformClubDto } from "../../contracts/platform.js";

export const platformRouter = new Hono<AppEnv>();

platformRouter.use("*", requireAuth);
platformRouter.use("*", requirePlatformAdmin);

function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** GET /v1/platform/clubs — indicateurs simples FFBB/FBI/e-Marque par club, réservé platform_admin (§42 de la demande). */
platformRouter.get("/clubs", async (c) => {
  const supabase = createServiceSupabaseClient();

  const [{ data: clubs }, { data: fbiStatuses }] = await Promise.all([
    supabase.from("clubs").select("id, slug, name, ffbb_club_id, status, ffbb_enabled").order("created_at", { ascending: false }),
    supabase.from("fbi_integration_status").select("club_id, configured, last_login_success"),
  ]);

  const fbiByClub = new Map((fbiStatuses ?? []).map((s) => [s.club_id, s]));

  const result: PlatformClubDto[] = (clubs ?? []).map((club) => {
    const fbiStatus = fbiByClub.get(club.id);
    const capabilities = computeClubCapabilities({
      ffbbEnabled: club.ffbb_enabled,
      fbiConfigured: fbiStatus?.configured ?? false,
      fbiConnected: fbiStatus?.last_login_success ?? false,
    });

    return {
      id: club.id,
      slug: club.slug,
      name: club.name,
      ffbbClubId: club.ffbb_club_id,
      status: club.status,
      ...capabilities,
    };
  });

  return c.json({ clubs: result });
});

/**
 * POST /v1/platform/clubs — onboarding d'un nouveau club sans opération SQL
 * manuelle (§42/§43 de la demande). Invite le premier club_admin via
 * `auth.admin.inviteUserByEmail` (jamais depuis le frontend avec service
 * role — c'est précisément pour ça que cette route existe).
 */
platformRouter.post("/clubs", async (c) => {
  const body = await c.req.json<{ name?: string; ffbbClubId?: string; slug?: string; timezone?: string; adminEmail?: string }>().catch(() => ({}) as { name?: string; ffbbClubId?: string; slug?: string; timezone?: string; adminEmail?: string });

  const name = (body.name ?? "").trim();
  const ffbbClubId = (body.ffbbClubId ?? "").trim();
  const timezone = (body.timezone ?? "Europe/Paris").trim() || "Europe/Paris";
  const adminEmail = (body.adminEmail ?? "").trim();

  if (!name || !ffbbClubId) throw badRequest("Le nom et le code FFBB sont requis.");

  const slug = slugify(body.slug || name);
  if (!slug) throw badRequest("Impossible de générer un slug à partir de ce nom.");

  const supabase = createServiceSupabaseClient();

  const { data: existingSlug } = await supabase.from("clubs").select("id").eq("slug", slug).maybeSingle();
  if (existingSlug) throw badRequest(`Le slug "${slug}" est déjà utilisé par un autre club.`);

  const { data: club, error: clubError } = await supabase.from("clubs").insert({ name, slug, ffbb_club_id: ffbbClubId, timezone }).select("id, slug").single();

  if (clubError || !club) {
    logError("Création de club échouée", clubError, { slug });
    throw badRequest("Création du club impossible (code FFBB déjà utilisé ?).");
  }

  let adminInviteError: string | null = null;
  if (adminEmail) {
    try {
      await inviteFirstClubAdmin(supabase, club.id, adminEmail);
    } catch (error) {
      logError("Invitation du premier admin de club échouée", error, { clubId: club.id, adminEmail });
      adminInviteError = "Club créé, mais l'invitation de l'admin a échoué (à refaire manuellement).";
    }
  }

  return c.json({ clubId: club.id, slug: club.slug, adminInviteError }, 201);
});

async function inviteFirstClubAdmin(supabase: DbClient, clubId: string, email: string): Promise<void> {
  const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) throw new Error(`Recherche de l'utilisateur échouée : ${listError.message}`);

  let userId = existingUsers.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id;

  if (!userId) {
    const { data: invited, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email);
    if (inviteError || !invited.user) {
      throw new Error(`Invitation échouée : ${inviteError?.message ?? "aucun utilisateur retourné"}`);
    }
    userId = invited.user.id;
  }

  const { data: membership, error: membershipError } = await supabase
    .from("club_memberships")
    .upsert({ club_id: clubId, user_id: userId }, { onConflict: "club_id,user_id" })
    .select("id")
    .single();

  if (membershipError || !membership) {
    throw new Error(`Création du membership échouée : ${membershipError?.message}`);
  }

  const { error: roleError } = await supabase
    .from("membership_roles")
    .upsert({ membership_id: membership.id, role: "club_admin" }, { onConflict: "membership_id,role,scope_key" });

  if (roleError) {
    throw new Error(`Attribution du rôle club_admin échouée : ${roleError.message}`);
  }
}
