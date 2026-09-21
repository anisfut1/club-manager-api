import { Hono } from "hono";
import type { AppEnv } from "@/auth/context";
import { requireAuth, requireClubMembership } from "@/auth/middleware";
import { getClubCapabilities } from "@/tenancy/club-capabilities";
import type { ClubRole } from "@/tenancy/roles";
import type { ClubDto, TeamDto } from "@/contracts/clubs";

export const clubsRouter = new Hono<AppEnv>();

clubsRouter.use("*", requireAuth);

/** GET /v1/clubs — clubs dont l'utilisateur est membre actif (RLS, jamais un filtre applicatif). */
clubsRouter.get("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");

  const { data: memberships, error } = await supabase
    .from("club_memberships")
    .select("club_id, id, clubs(id, slug, name, short_name, logo_url, accent_color, timezone, status)")
    .eq("user_id", user.id)
    .eq("status", "active");

  if (error) throw new Error(`Lecture des clubs échouée : ${error.message}`);

  const membershipIds = (memberships ?? []).map((m) => m.id);
  const { data: roleRows } = membershipIds.length
    ? await supabase.from("membership_roles").select("membership_id, role").in("membership_id", membershipIds)
    : { data: [] };

  const rolesByMembership = new Map<string, ClubRole[]>();
  for (const row of roleRows ?? []) {
    const list = rolesByMembership.get(row.membership_id) ?? [];
    list.push(row.role);
    rolesByMembership.set(row.membership_id, list);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clubs: ClubDto[] = (memberships ?? []).flatMap((m: any) => {
    const club = m.clubs;
    if (!club) return [];
    return [
      {
        id: club.id,
        slug: club.slug,
        name: club.name,
        shortName: club.short_name,
        logoUrl: club.logo_url,
        accentColor: club.accent_color,
        timezone: club.timezone,
        status: club.status,
        roles: rolesByMembership.get(m.id) ?? [],
      },
    ];
  });

  return c.json({ clubs });
});

/** GET /v1/clubs/:clubId — détail d'UN club (membership déjà vérifié par le middleware). */
clubsRouter.get("/:clubId", requireClubMembership, async (c) => {
  const { club, roles } = c.get("club");
  const dto: ClubDto = {
    id: club.id,
    slug: club.slug,
    name: club.name,
    shortName: club.shortName,
    logoUrl: club.logoUrl,
    accentColor: club.accentColor,
    timezone: club.timezone,
    status: club.status,
    roles,
  };
  return c.json(dto);
});

/** GET /v1/clubs/:clubId/capabilities — voir docs/FBI.md "FBI est facultatif". */
clubsRouter.get("/:clubId/capabilities", requireClubMembership, async (c) => {
  const { club } = c.get("club");
  const capabilities = await getClubCapabilities(c.get("supabase"), club.id);
  return c.json(capabilities);
});

/** GET /v1/clubs/:clubId/teams */
clubsRouter.get("/:clubId/teams", requireClubMembership, async (c) => {
  const { club } = c.get("club");
  const { data, error } = await c
    .get("supabase")
    .from("teams")
    .select("id, name, category, active")
    .eq("club_id", club.id)
    .order("name");

  if (error) throw new Error(`Lecture des équipes échouée : ${error.message}`);

  const teams: TeamDto[] = (data ?? []).map((t) => ({ id: t.id, name: t.name, category: t.category, active: t.active }));
  return c.json({ teams });
});
