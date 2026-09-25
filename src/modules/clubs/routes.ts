import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { getClubCapabilities } from "../../tenancy/club-capabilities.js";
import type { ClubRole } from "../../tenancy/roles.js";
import { UpdateClubDtoSchema, CreateTeamDtoSchema, UpdateTeamDtoSchema, type ClubDto, type TeamDto } from "../../contracts/clubs.js";
import { badRequest, notFound } from "../../api-error.js";

export const clubsRouter = new Hono<AppEnv>();

clubsRouter.use("*", requireAuth);

/** GET /v1/clubs — clubs dont l'utilisateur est membre actif (RLS, jamais un filtre applicatif). */
clubsRouter.get("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");

  const { data: memberships, error } = await supabase
    .from("club_memberships")
    .select("club_id, id, clubs(id, slug, name, short_name, logo_url, accent_color, timezone, status, ffbb_club_id)")
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
        ffbbClubCode: club.ffbb_club_id,
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
    ffbbClubCode: club.ffbbClubId,
    roles,
  };
  return c.json(dto);
});

/**
 * PATCH /v1/clubs/:clubId (gap 1 de la demande) — branding léger
 * uniquement (name/shortName/timezone/logoUrl/accentColor). Utilise LE
 * CLIENT "au nom de l'utilisateur" (`c.get("supabase")`), jamais la
 * service role : c'est le privilège de colonne PostgreSQL restreint sur
 * `clubs` (voir supabase/migrations/20260921100090_rls_multitenant_rewrite.sql,
 * `grant update (name, short_name, logo_url, accent_color, timezone) on
 * public.clubs to authenticated`) qui garantit structurellement qu'aucun
 * autre champ (slug, status, ffbb_club_id, ffbb_enabled...) ne peut être
 * modifié par cette route, même en cas de bug dans ce handler.
 *
 * Réservé à `club_admin` — pas de bypass `platform_admin` sans membership
 * ici (cohérent avec TOUTES les autres routes `/v1/clubs/:clubId/*`, voir
 * docs/MIGRATION.md "Frontend API gaps resolved" pour la justification).
 */
clubsRouter.patch("/:clubId", requireClubMembership, requireClubRole("club_admin"), async (c) => {
  const { club, roles } = c.get("club");
  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateClubDtoSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((issue) => issue.message).join(" "));
  }

  const patch: Partial<{
    name: string;
    short_name: string | null;
    timezone: string;
    logo_url: string | null;
    accent_color: string | null;
  }> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.shortName !== undefined) patch.short_name = parsed.data.shortName;
  if (parsed.data.timezone !== undefined) patch.timezone = parsed.data.timezone;
  if (parsed.data.logoUrl !== undefined) patch.logo_url = parsed.data.logoUrl;
  if (parsed.data.accentColor !== undefined) patch.accent_color = parsed.data.accentColor;

  let dto: ClubDto = {
    id: club.id,
    slug: club.slug,
    name: club.name,
    shortName: club.shortName,
    logoUrl: club.logoUrl,
    accentColor: club.accentColor,
    timezone: club.timezone,
    status: club.status,
    ffbbClubCode: club.ffbbClubId,
    roles,
  };

  if (Object.keys(patch).length > 0) {
    const { data, error } = await c
      .get("supabase")
      .from("clubs")
      .update(patch)
      .eq("id", club.id)
      .select("id, slug, name, short_name, logo_url, accent_color, timezone, status, ffbb_club_id")
      .single();

    if (error) throw new Error(`Mise à jour du club échouée : ${error.message}`);

    dto = {
      id: data.id,
      slug: data.slug,
      name: data.name,
      shortName: data.short_name,
      logoUrl: data.logo_url,
      accentColor: data.accent_color,
      timezone: data.timezone,
      status: data.status,
      ffbbClubCode: data.ffbb_club_id,
      roles,
    };
  }

  return c.json(dto);
});

/** GET /v1/clubs/:clubId/capabilities — voir docs/FBI.md "FBI est facultatif". */
clubsRouter.get("/:clubId/capabilities", requireClubMembership, async (c) => {
  const { club } = c.get("club");
  const capabilities = await getClubCapabilities(c.get("supabase"), club.id);
  return c.json(capabilities);
});

const TEAM_COLUMNS = "id, name, category, sexe, numero_equipe, active";

function mapTeamRow(row: { id: string; name: string; category: string | null; sexe: "M" | "F" | null; numero_equipe: string | null; active: boolean }): TeamDto {
  return { id: row.id, name: row.name, category: row.category, sexe: row.sexe, numeroEquipe: row.numero_equipe, active: row.active };
}

/** GET /v1/clubs/:clubId/teams — TOUTES les équipes, y compris celles sans aucun match (créées manuellement en attendant un engagement FFBB, voir docs/TEAMS.md). */
clubsRouter.get("/:clubId/teams", requireClubMembership, async (c) => {
  const { club } = c.get("club");
  const { data, error } = await c.get("supabase").from("teams").select(TEAM_COLUMNS).eq("club_id", club.id).order("name");

  if (error) throw new Error(`Lecture des équipes échouée : ${error.message}`);

  const teams: TeamDto[] = (data ?? []).map(mapTeamRow);
  return c.json({ teams });
});

/**
 * POST /v1/clubs/:clubId/teams (club_admin) — demande du club : enregistrer
 * une équipe AVANT tout engagement FFBB confirmé (brassage), voir
 * docs/TEAMS.md. Utilise le client "au nom de l'utilisateur" : la RLS
 * (`teams_all_club_admin`, supabase/migrations/20260921100090_rls_
 * multitenant_rewrite.sql) garantit déjà que seul un club_admin de CE club
 * peut écrire ici, ce handler n'est qu'une validation de forme.
 */
clubsRouter.post("/:clubId/teams", requireClubMembership, requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateTeamDtoSchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((issue) => issue.message).join(" "));

  const { data, error } = await c
    .get("supabase")
    .from("teams")
    .insert({
      club_id: club.id,
      name: parsed.data.name,
      category: parsed.data.category ?? null,
      sexe: parsed.data.sexe ?? null,
      numero_equipe: parsed.data.numeroEquipe ?? null,
    })
    .select(TEAM_COLUMNS)
    .single();

  if (error || !data) throw new Error(`Création de l'équipe échouée : ${error?.message}`);

  return c.json(mapTeamRow(data), 201);
});

/**
 * PATCH /v1/clubs/:clubId/teams/:teamId (club_admin) — renommer/reclasser/
 * activer-désactiver. Changer `category`/`sexe`/`numeroEquipe` ici modifie
 * ce que `resolveTeamForEngagement` (integrations/ffbb/sync.ts) utilisera
 * pour retrouver cette équipe au prochain engagement FFBB confirmé.
 */
clubsRouter.patch("/:clubId/teams/:teamId", requireClubMembership, requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const teamId = c.req.param("teamId");
  if (!teamId) throw badRequest("Paramètre de route :teamId manquant.");

  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateTeamDtoSchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((issue) => issue.message).join(" "));

  const patch: Partial<{ name: string; category: string | null; sexe: "M" | "F" | null; numero_equipe: string | null; active: boolean }> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.category !== undefined) patch.category = parsed.data.category;
  if (parsed.data.sexe !== undefined) patch.sexe = parsed.data.sexe;
  if (parsed.data.numeroEquipe !== undefined) patch.numero_equipe = parsed.data.numeroEquipe;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;

  const { data: existing } = await c.get("supabase").from("teams").select(TEAM_COLUMNS).eq("id", teamId).eq("club_id", club.id).maybeSingle();
  if (!existing) throw notFound("Équipe introuvable.");

  if (Object.keys(patch).length === 0) return c.json(mapTeamRow(existing));

  const { data, error } = await c.get("supabase").from("teams").update(patch).eq("id", teamId).select(TEAM_COLUMNS).single();
  if (error || !data) throw new Error(`Mise à jour de l'équipe échouée : ${error?.message}`);

  return c.json(mapTeamRow(data));
});
