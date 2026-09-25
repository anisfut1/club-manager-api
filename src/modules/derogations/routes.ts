import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership } from "../../auth/middleware.js";
import type { DerogationListItemDto } from "../../contracts/derogations.js";

export const derogationsRouter = new Hono<AppEnv>();

derogationsRouter.use("*", requireAuth);
derogationsRouter.use("*", requireClubMembership);

/**
 * GET /v1/clubs/:clubId/derogations — TOUTES les dérogations connues du
 * club (dernier état par match), enrichies du numéro/adversaire/date du
 * match FFBB correspondant — pour la page "Vérifier toutes les
 * dérogations" (demande du club, voir docs/FBI.md : "je veux un bouton
 * global qui check toutes les demandes, pas match par match"). Silencieux
 * (liste vide) pour un club sans FBI configuré, ou n'ayant jamais lancé de
 * vérification — jamais une erreur.
 */
derogationsRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const { data: checks, error } = await supabase
    .from("fbi_derogation_checks")
    .select("match_id, numero, etat, date_depot, date_derogation, date_rencontre, heure, domicile, visiteur, checked_at")
    .eq("club_id", club.id)
    .order("checked_at", { ascending: false });

  if (error) throw new Error(`Lecture des dérogations échouée : ${error.message}`);

  const matchIds = (checks ?? []).map((row) => row.match_id);
  const { data: matches } = matchIds.length
    ? await supabase.from("matches").select("id, numero, opponent_name, match_datetime").in("id", matchIds)
    : { data: [] };
  const matchById = new Map((matches ?? []).map((m) => [m.id, m]));

  const derogations: DerogationListItemDto[] = (checks ?? []).map((row) => {
    const match = matchById.get(row.match_id);
    return {
      matchId: row.match_id,
      numero: row.numero,
      opponentName: match?.opponent_name ?? null,
      matchDatetime: match?.match_datetime ?? null,
      etat: row.etat,
      dateDepot: row.date_depot,
      dateDerogation: row.date_derogation,
      dateRencontre: row.date_rencontre,
      heure: row.heure,
      domicile: row.domicile,
      visiteur: row.visiteur,
      checkedAt: row.checked_at,
    };
  });

  return c.json({ derogations });
});
