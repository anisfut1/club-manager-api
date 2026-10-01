import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { badRequest, notFound } from "../../api-error.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { UpdateClubVenueDtoSchema } from "../../contracts/club-venues.js";

/**
 * Gymnases du club (`club_venues`, planning des demandes de dérogation).
 * Lecture : tout membre. Modification (nom affiché, actif, ordre) :
 * `club_admin`. Les gymnases sont créés à partir des salles FFBB des matchs
 * à domicile (migration + synchronisation) — jamais un nom deviné.
 */
export const clubVenuesRouter = new Hono<AppEnv>();
clubVenuesRouter.use("*", requireAuth);
clubVenuesRouter.use("*", requireClubMembership);

const COLUMNS = "id, name, address, active, sort_order";

clubVenuesRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const { data, error } = await createServiceSupabaseClient().from("club_venues").select(COLUMNS).eq("club_id", club.id).order("sort_order").order("name");
  if (error) throw new Error(`Lecture des gymnases échouée : ${error.message}`);
  return c.json({ venues: (data ?? []).map((v) => ({ id: v.id, name: v.name, address: v.address, active: v.active, sortOrder: v.sort_order })) });
});

clubVenuesRouter.patch("/:venueId", requireClubRole("club_admin"), async (c) => {
  const body = UpdateClubVenueDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const { club } = c.get("club");
  const patch: { name?: string; active?: boolean; sort_order?: number; updated_at: string } = { updated_at: new Date().toISOString() };
  if (body.data.name !== undefined) patch.name = body.data.name;
  if (body.data.active !== undefined) patch.active = body.data.active;
  if (body.data.sortOrder !== undefined) patch.sort_order = body.data.sortOrder;

  const { data, error } = await createServiceSupabaseClient().from("club_venues").update(patch).eq("id", c.req.param("venueId")).eq("club_id", club.id).select(COLUMNS).maybeSingle();
  if (error) throw new Error(`Mise à jour du gymnase échouée : ${error.message}`);
  if (!data) throw notFound("Gymnase introuvable.");
  return c.json({ venue: { id: data.id, name: data.name, address: data.address, active: data.active, sortOrder: data.sort_order } });
});
