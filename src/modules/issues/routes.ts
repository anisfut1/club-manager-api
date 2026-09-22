import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { badRequest, notFound } from "../../api-error.js";
import type { IssueDto } from "../../contracts/issues.js";
import type { QualityWarningDto } from "../../contracts/emarque.js";

export const issuesRouter = new Hono<AppEnv>();

issuesRouter.use("*", requireAuth);
issuesRouter.use("*", requireClubMembership);

const MESSAGE_BY_STATUS: Record<"error" | "needs_review", { message: string; technicalCode: string; severity: "warning" | "error" }> = {
  error: {
    message: "Une erreur est survenue lors du traitement du document e-Marque de ce match.",
    technicalCode: "EMARQUE_IMPORT_ERROR",
    severity: "error",
  },
  needs_review: {
    message: "Le document e-Marque de ce match nécessite une vérification manuelle.",
    technicalCode: "EMARQUE_NEEDS_REVIEW",
    severity: "warning",
  },
};

/**
 * GET /v1/clubs/:clubId/issues — dérivé de `matches.emarque_status`
 * (error/needs_review), enrichi (gap 6 de la demande) avec les
 * avertissements qualité de l'import e-Marque le plus récent de chaque
 * match. `message`/`technicalCode` sont TOUJOURS des textes prêts à
 * afficher (jamais `emarque_imports.last_error` brut, §9 de la demande).
 */
issuesRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const { data: matches, error } = await supabase
    .from("matches")
    .select("id, numero, opponent_name, match_datetime, emarque_status")
    .eq("club_id", club.id)
    .in("emarque_status", ["error", "needs_review"])
    .order("match_datetime", { ascending: false });

  if (error) throw new Error(`Lecture des anomalies échouée : ${error.message}`);

  const matchIds = (matches ?? []).map((m) => m.id);

  const { data: imports } = matchIds.length
    ? await supabase
        .from("emarque_imports")
        .select("match_id, quality_warnings, created_at")
        .eq("club_id", club.id)
        .in("match_id", matchIds)
        .order("created_at", { ascending: false })
    : { data: [] };

  const latestImportByMatchId = new Map<string, { quality_warnings: unknown; created_at: string }>();
  for (const imp of imports ?? []) {
    if (!latestImportByMatchId.has(imp.match_id)) latestImportByMatchId.set(imp.match_id, imp);
  }

  const issues: IssueDto[] = (matches ?? []).map((m) => {
    const emarqueStatus = m.emarque_status as "error" | "needs_review";
    const meta = MESSAGE_BY_STATUS[emarqueStatus];
    const latestImport = latestImportByMatchId.get(m.id);
    const qualityWarnings = Array.isArray(latestImport?.quality_warnings) ? (latestImport.quality_warnings as QualityWarningDto[]) : [];

    return {
      matchId: m.id,
      numero: m.numero,
      opponentName: m.opponent_name,
      matchDatetime: m.match_datetime,
      integration: "emarque",
      type: emarqueStatus === "error" ? "emarque_import_error" : "emarque_needs_review",
      severity: meta.severity,
      status: "open",
      message: meta.message,
      technicalCode: meta.technicalCode,
      qualityWarnings,
      createdAt: latestImport?.created_at ?? null,
      resolvedAt: null,
    };
  });

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
