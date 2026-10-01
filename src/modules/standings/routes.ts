import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership } from "../../auth/middleware.js";
import { loadClubStandings } from "./shared.js";

export const standingsRouter = new Hono<AppEnv>();

standingsRouter.use("*", requireAuth);
standingsRouter.use("*", requireClubMembership);

/**
 * GET /v1/clubs/:clubId/standings — classements FFBB des poules où le club
 * est engagé, pour l'espace club (retour du club, 2026-10-01 : "ici aussi
 * quand même dans le menu me faut le classement, c'est pas only public").
 * Tout membre du club : client scopé utilisateur, la RLS
 * (ffbb_team_engagements_select_member, pools/competitions en lecture
 * authentifiée) s'applique en plus du filtre par club.
 */
standingsRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const standings = await loadClubStandings(c.get("supabase"), club.id);
  return c.json({ standings });
});
