import { Hono } from "hono";
import type { AppEnv } from "@/auth/context";
import { requireAuth, requireClubMembership, requireClubRole } from "@/auth/middleware";
import { badRequest, notFound } from "@/api-error";
import type { IssueDto } from "@/contracts/issues";

export const issuesRouter = new Hono<AppEnv>();

issuesRouter.use("*", requireAuth);
issuesRouter.use("*", requireClubMembership);

/** GET /v1/clubs/:clubId/issues — dérivé de matches.emarque_status (error/needs_review), aucune table dédiée. */
issuesRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const { data, error } = await c
    .get("supabase")
    .from("matches")
    .select("id, numero, opponent_name, match_datetime, emarque_status")
    .eq("club_id", club.id)
    .in("emarque_status", ["error", "needs_review"])
    .order("match_datetime", { ascending: false });

  if (error) throw new Error(`Lecture des anomalies échouée : ${error.message}`);

  const issues: IssueDto[] = (data ?? []).map((m) => ({
    matchId: m.id,
    numero: m.numero,
    opponentName: m.opponent_name,
    matchDatetime: m.match_datetime,
    emarqueStatus: m.emarque_status as "error" | "needs_review",
  }));

  return c.json({ issues });
});

/**
 * POST /v1/clubs/:clubId/issues/:matchId/resolve — un club_admin confirme
 * avoir vérifié manuellement les données malgré l'avertissement qualité.
 * Ne modifie AUCUNE donnée extraite, uniquement le statut de revue.
 */
issuesRouter.post("/:matchId/resolve", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const { data, error } = await c
    .get("supabase")
    .from("matches")
    .update({ emarque_status: "imported" })
    .eq("id", matchId)
    .eq("club_id", club.id)
    .select("id");

  if (error) throw new Error(`Résolution de l'anomalie échouée : ${error.message}`);
  if (!data || data.length === 0) throw notFound("Match introuvable.");

  return c.json({ resolved: true });
});
