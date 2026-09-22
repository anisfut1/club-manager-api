import { Hono } from "hono";
import type { AppEnv } from "@/auth/context";
import { requireAuth, requireClubMembership } from "@/auth/middleware";
import { badRequest } from "@/api-error";
import { sanitizeEmarqueError } from "@/integrations/emarque/sanitize-error";
import { EmarqueImportsQueryDtoSchema, type EmarqueImportDto, type QualityWarningDto } from "@/contracts/emarque";

export const emarqueImportsRouter = new Hono<AppEnv>();

emarqueImportsRouter.use("*", requireAuth);
emarqueImportsRouter.use("*", requireClubMembership);

/**
 * GET /v1/clubs/:clubId/emarque-imports (gap 5 de la demande) — état des
 * imports e-Marque, tenant-scopé. Ouvert à tout membre (même policy RLS
 * `emarque_imports_select_member` que le détail match) : c'est un statut
 * de traitement, jamais une donnée sensible (identifiants, chemin Storage
 * interne — jamais exposés ici, voir `EmarqueImportDtoSchema`).
 */
emarqueImportsRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const query = EmarqueImportsQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) {
    throw badRequest(query.error.issues.map((issue) => issue.message).join(" "));
  }
  const { matchId, status, from, to, limit, offset } = query.data;

  let builder = supabase
    .from("emarque_imports")
    .select("id, match_id, status, source, parser_version, quality_warnings, discovered_at, downloaded_at, imported_at, last_error, attempt_count, next_attempt_at", {
      count: "exact",
    })
    .eq("club_id", club.id);

  if (matchId) builder = builder.eq("match_id", matchId);
  if (status) builder = builder.eq("status", status);
  if (from) builder = builder.gte("discovered_at", from);
  if (to) builder = builder.lte("discovered_at", to);

  const { data, error, count } = await builder.order("discovered_at", { ascending: false }).range(offset, offset + limit - 1);

  if (error) throw new Error(`Lecture des imports e-Marque échouée : ${error.message}`);

  const imports: EmarqueImportDto[] = (data ?? []).map((row) => ({
    id: row.id,
    matchId: row.match_id,
    status: row.status,
    source: row.source,
    parserVersion: row.parser_version,
    discoveredAt: row.discovered_at,
    downloadedAt: row.downloaded_at,
    importedAt: row.imported_at,
    qualityWarnings: Array.isArray(row.quality_warnings) ? (row.quality_warnings as QualityWarningDto[]) : [],
    lastError: sanitizeEmarqueError(row.last_error),
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
  }));

  return c.json({ imports, pagination: { limit, offset, total: count ?? imports.length } });
});
