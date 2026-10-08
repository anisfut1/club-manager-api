import { Hono } from "hono";
import type { DbClient } from "../../db/client.js";
import { badRequest } from "../../api-error.js";
import { resolvePublicClub, type PublicClub } from "../public/club-resolver.js";
import { listMatchesForClub, loadMatchDetails } from "../matches/shared.js";
import { loadMatchDocuments } from "../documents/shared.js";
import type { TeamDto } from "../../contracts/clubs.js";
import { loadClubStandings } from "../standings/shared.js";

/**
 * Vue PUBLIQUE en lecture seule des matchs (retour du club, 2026-09-29 :
 * "je veux une vue publique avec toutes les infos en vue directe, sans les
 * boutons etc, en gros sans les fonctions admin, et sans compte, en libre
 * service"). Contrairement au module `public-tables` (auto-affectation),
 * il n'y a ICI aucune identité à prouver — pas de jeton personnel, pas de
 * `?token=` : ce module ne fait QUE relire les mêmes données que verrait
 * un membre du club non-admin authentifié, réutilisant EXACTEMENT le même
 * moteur (`matches/shared.ts`, `documents/shared.ts`) pour ne jamais
 * diverger du comportement authentifié.
 *
 * Deux garde-fous volontaires, jamais contournables depuis ce routeur :
 * - Aucune URL de téléchargement de document original (`loadMatchDocuments`
 *   appelé avec `canDownload: false` en dur, jamais une variable) — déjà
 *   réservé à `club_admin` côté authentifié (§34 de la demande).
 * - Aucune route d'écriture (dérogation créer/répondre, vérifier sur FBI) —
 *   ce routeur n'a QUE des `GET`.
 *
 * Toute lecture Supabase utilise le rôle service (`resolvePublicClub`, RLS
 * bypass) : c'est CE CODE, pas la RLS, qui garantit qu'un visiteur ne voit
 * jamais les données d'un AUTRE club (même raisonnement que
 * `public-tables`, voir docs/MULTI_TENANCY.md). Monté à
 * `/v1/public/clubs/:clubSlug` (voir src/api/v1/index.ts), aux côtés de
 * `publicTablesRouter`.
 */

interface PublicMatchesEnv {
  Variables: {
    supabase: DbClient;
    publicClub: PublicClub;
  };
}

export const publicMatchesRouter = new Hono<PublicMatchesEnv>();

publicMatchesRouter.use("*", resolvePublicClub<PublicMatchesEnv>());

/** GET /v1/public/clubs/:clubSlug/teams — pour le filtre "équipe" de la liste des matchs, mêmes colonnes que la route authentifiée. */
publicMatchesRouter.get("/teams", async (c) => {
  const club = c.get("publicClub");
  const { data, error } = await c.get("supabase").from("teams").select("id, name, category, sexe, numero_equipe, active").eq("club_id", club.id).order("name");

  if (error) throw new Error(`Lecture des équipes échouée : ${error.message}`);

  const teams: TeamDto[] = (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    sexe: row.sexe,
    numeroEquipe: row.numero_equipe,
    active: row.active,
  }));

  return c.json({ teams });
});

/** GET /v1/public/clubs/:clubSlug/matches — mêmes filtres/pagination que `GET /v1/clubs/:clubId/matches` (voir `matches/shared.ts#listMatchesForClub`). */
publicMatchesRouter.get("/matches", async (c) => {
  const club = c.get("publicClub");
  const result = await listMatchesForClub(c.get("supabase"), club, c.req.query());
  // Dérogations jamais exposées sans compte (retour du club, 2026-10-01 : « tout
  // ce qui est dérogation ça doit pas être visible au public, seulement aux
  // admin et admin du club »).
  return c.json({ ...result, matches: result.matches.map((m) => ({ ...m, derogationStatus: null })) });
});

/** GET /v1/public/clubs/:clubSlug/matches/:matchId — fiche complète (composition, stats, officiels, e-Marque), voir `matches/shared.ts#loadMatchDetails`. */
publicMatchesRouter.get("/matches/:matchId", async (c) => {
  const club = c.get("publicClub");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const dto = await loadMatchDetails(c.get("supabase"), club, matchId, { includePhotos: true });
  // Garde-fou de publication (processus e-Marque, 2026-10-06 : "un coup les
  // stats sont fausses") : une lecture "à vérifier" (total des points ≠
  // score officiel, maillot en double...) ou en erreur n'est JAMAIS
  // affichée au public — l'onglet indique simplement qu'elle est en cours
  // de vérification ; l'admin du club la voit, avec la raison.
  const unpublished = dto.emarque.status === "needs_review" || dto.emarque.status === "error";
  return c.json(unpublished ? { ...dto, participants: [], coaches: [], stats: [] } : dto);
});

/**
 * GET /v1/public/clubs/:clubSlug/matches/:matchId/documents — liste des
 * documents e-Marque, `downloadUrl` toujours `null` (aucune URL signée
 * générée pour un visiteur anonyme, `canDownload: false` en dur).
 */
publicMatchesRouter.get("/matches/:matchId/documents", async (c) => {
  const club = c.get("publicClub");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const documents = await loadMatchDocuments(c.get("supabase"), club, matchId, false);
  return c.json({ documents });
});

/**
 * GET /v1/public/clubs/:clubSlug/matches/:matchId/derogation — conservée pour
 * compatibilité des clients existants, mais renvoie TOUJOURS `null` : les
 * dérogations sont réservées aux club_admin / platform_admin (retour du club,
 * 2026-10-01), jamais lues ni exposées pour un visiteur anonyme.
 */
/**
 * GET /v1/public/clubs/:clubSlug/standings — classements FFBB des poules
 * où le club est engagé (retour du club, 2026-10-01 : onglet « Résultats »
 * de l'espace public). Données publiques FFBB, lecture seule.
 */
publicMatchesRouter.get("/standings", async (c) => {
  const standings = await loadClubStandings(c.get("supabase"), c.get("publicClub").id);
  return c.json({ standings });
});

publicMatchesRouter.get("/matches/:matchId/derogation", (c) => c.json({ derogation: null }));
