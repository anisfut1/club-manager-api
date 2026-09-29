import { Hono } from "hono";
import type { DbClient } from "../../db/client.js";
import { badRequest, conflict, notFound, unauthorized } from "../../api-error.js";
import {
  ClaimLicencieDtoSchema,
  PublicAssignRoleQueryDtoSchema,
  PublicTableAssignmentsQueryDtoSchema,
  PublicTokenQueryDtoSchema,
} from "../../contracts/public-tables.js";
import { assignTableRole, loadHomeMatchOrThrow, loadTableAssignmentsList, removeTableRole } from "../tables/shared.js";
import { generatePublicToken, hashPublicToken } from "./token.js";
import { resolvePublicClub, type PublicClub } from "../public/club-resolver.js";

/**
 * Flux PUBLIC sans compte des Tables de marque (retour du club,
 * 2026-09-29) : "je vais envoyer le lien à tout le monde et ils se
 * positionneront... une fois positionné, ils ne doivent plus pouvoir être
 * modifiés par qqn d'autre, mais peuvent se supprimer eux-mêmes si le
 * token est tjr actif, sinon faut faire une demande admin (car l'accès se
 * fera sans création de compte)".
 *
 * AUCUNE route de ce module ne passe par `requireAuth`/Supabase Auth — il
 * n'y a pas de compte. Toute lecture/écriture Supabase utilise le rôle
 * service (`createServiceSupabaseClient`, RLS bypass) : c'est CE CODE, pas
 * la RLS, qui garantit qu'un visiteur n'accède/n'écrit jamais rien hors de
 * son propre club et de sa propre identité (même raisonnement que
 * `fbi_credentials`, voir docs/MULTI_TENANCY.md). Monté à
 * `/v1/public/clubs/:clubSlug` (voir src/api/v1/index.ts).
 */

interface PublicLicencie {
  id: string;
  firstName: string;
  lastName: string;
  teamId: string | null;
}

interface PublicEnv {
  Variables: {
    supabase: DbClient;
    publicClub: PublicClub;
    publicLicencie: PublicLicencie;
  };
}

export const publicTablesRouter = new Hono<PublicEnv>();

/** Toute route de ce routeur commence par résoudre le club via son slug — jamais son UUID (le slug seul est distribué dans le lien, §"un seul lien envoyé à tout le monde"). Voir `../public/club-resolver.ts`, partagé avec les autres modules publics. */
publicTablesRouter.use("*", resolvePublicClub<PublicEnv>());

/**
 * Résout l'identité depuis `?token=` — la SEULE preuve d'identité de ce
 * flux (retour du club : "si le token est tjr actif"). 401 si absent,
 * inconnu, ou révoqué par un admin — jamais une distinction plus fine
 * (§"sinon faut faire une demande admin", jamais un message qui aiderait à
 * deviner un jeton valide).
 */
async function resolvePublicLicencie(c: { get: (k: "supabase" | "publicClub") => DbClient | PublicClub; set: (k: "publicLicencie", v: PublicLicencie) => void }, token: string): Promise<void> {
  const supabase = c.get("supabase") as DbClient;
  const club = c.get("publicClub") as PublicClub;

  const tokenHash = hashPublicToken(token);
  const { data: claim } = await supabase.from("licencie_public_tokens").select("licencie_id").eq("club_id", club.id).eq("token_hash", tokenHash).is("revoked_at", null).maybeSingle();
  if (!claim) throw unauthorized("Lien personnel invalide ou révoqué — demande à un·e responsable du club de réinitialiser ton profil.");

  const { data: licencie } = await supabase.from("licencies").select("id, first_name, last_name, team_id").eq("id", claim.licencie_id).eq("club_id", club.id).maybeSingle();
  if (!licencie) throw unauthorized("Lien personnel invalide.");

  c.set("publicLicencie", { id: licencie.id, firstName: licencie.first_name, lastName: licencie.last_name, teamId: licencie.team_id });
}

/** GET /v1/public/clubs/:clubSlug — infos club minimales, jamais de données membres/rôles/FFBB ici. */
publicTablesRouter.get("/", (c) => {
  const club = c.get("publicClub");
  return c.json({ slug: club.slug, name: club.name, logoUrl: club.logoUrl, timezone: club.timezone });
});

/** GET /v1/public/clubs/:clubSlug/licencies — roster pour choisir son nom. `claimed` seulement (jamais qui/quand, aucune PII d'un tiers). */
publicTablesRouter.get("/licencies", async (c) => {
  const supabase = c.get("supabase");
  const club = c.get("publicClub");

  const [{ data: licencies }, { data: claims }] = await Promise.all([
    supabase.from("licencies").select("id, first_name, last_name").eq("club_id", club.id).eq("active", true).order("last_name").order("first_name"),
    supabase.from("licencie_public_tokens").select("licencie_id").eq("club_id", club.id).is("revoked_at", null),
  ]);

  const claimedIds = new Set((claims ?? []).map((row) => row.licencie_id));

  return c.json({
    licencies: (licencies ?? []).map((l) => ({ id: l.id, firstName: l.first_name, lastName: l.last_name, claimed: claimedIds.has(l.id) })),
  });
});

/**
 * POST /v1/public/clubs/:clubSlug/licencies/:licencieId/claim — choix du
 * nom (§"il choisit son nom dans la liste... une fois qu'un nom est
 * choisi, il peut plus être choisi"). Atomique via l'index unique PARTIEL
 * de la migration : jamais un SELECT-puis-INSERT applicatif, seule la
 * contrainte DB garantit qu'une double revendication simultanée du même
 * nom échoue proprement (§ même raisonnement que fbi_jobs, claim atomique).
 */
publicTablesRouter.post("/licencies/:licencieId/claim", async (c) => {
  const supabase = c.get("supabase");
  const club = c.get("publicClub");
  const licencieId = c.req.param("licencieId");
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");

  const body = ClaimLicencieDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));

  const { data: licencie } = await supabase.from("licencies").select("id, first_name, last_name").eq("id", licencieId).eq("club_id", club.id).eq("active", true).maybeSingle();
  if (!licencie) throw notFound("Licencié introuvable pour ce club.");

  const token = generatePublicToken();
  const { error } = await supabase.from("licencie_public_tokens").insert({ club_id: club.id, licencie_id: licencie.id, token_hash: hashPublicToken(token), email: body.data.email ?? null });

  if (error) {
    if (error.code === "23505") throw conflict("Ce nom a déjà été choisi par quelqu'un d'autre. Si c'est une erreur, demande à un·e responsable du club de réinitialiser ce profil.", "ALREADY_CLAIMED");
    throw new Error(`Revendication du profil échouée : ${error.message}`);
  }

  return c.json({ token, licencie: { id: licencie.id, firstName: licencie.first_name, lastName: licencie.last_name } });
});

/** GET /v1/public/clubs/:clubSlug/me?token= — vérifie/résout l'identité (pour un lien déjà en poche, ex: au chargement de la page). */
publicTablesRouter.get("/me", async (c) => {
  const query = PublicTokenQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));

  await resolvePublicLicencie(c, query.data.token);
  const licencie = c.get("publicLicencie");
  return c.json({ licencie: { id: licencie.id, firstName: licencie.firstName, lastName: licencie.lastName } });
});

/** GET /v1/public/clubs/:clubSlug/table-assignments?token=&from=&to= — même contenu que la vue admin, `me` en plus. */
publicTablesRouter.get("/table-assignments", async (c) => {
  const query = PublicTableAssignmentsQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));

  await resolvePublicLicencie(c, query.data.token);
  const supabase = c.get("supabase");
  const club = c.get("publicClub");
  const me = c.get("publicLicencie");

  const matches = await loadTableAssignmentsList({ supabase, clubId: club.id, clubTimezone: club.timezone, from: query.data.from, to: query.data.to });

  return c.json({ me: { id: me.id, firstName: me.firstName, lastName: me.lastName }, matches });
});

/**
 * PUT .../matches/:matchId/table-assignments/:role?token= — auto-
 * affectation (§"la personne qui va se mettre sur un match"). Le
 * `licencieId` vient TOUJOURS du jeton, jamais du corps de la requête —
 * personne ne peut s'affecter au nom de quelqu'un d'autre. Ne remplace
 * JAMAIS un·e titulaire différent·e (`blockIfHeldBySomeoneElse`, voir
 * shared.ts) : c'est tout le sens de la demande.
 */
publicTablesRouter.put("/matches/:matchId/table-assignments/:role", async (c) => {
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const query = PublicAssignRoleQueryDtoSchema.safeParse({ ...c.req.query(), role: c.req.param("role") });
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));

  await resolvePublicLicencie(c, query.data.token);
  const supabase = c.get("supabase");
  const club = c.get("publicClub");
  const me = c.get("publicLicencie");

  const match = await loadHomeMatchOrThrow(supabase, club.id, matchId);

  const assignment = await assignTableRole({
    readSupabase: supabase,
    clubId: club.id,
    clubTimezone: club.timezone,
    matchId: match.id,
    matchVenueRawLabel: match.venue_raw_label,
    matchDatetime: match.match_datetime,
    role: query.data.role,
    licencie: me,
    createdByUserId: null,
    blockIfHeldBySomeoneElse: true,
  });

  return c.json({ assignment });
});

/**
 * DELETE .../matches/:matchId/table-assignments/:role?token= — retrait de
 * SA PROPRE affectation uniquement (§"peuvent se supprimer eux-mêmes si le
 * token est tjr actif"). `removeTableRole` avec `onlyIfLicencieId` refuse
 * (403) si le poste appartient à quelqu'un d'autre — jamais une suppression
 * d'un tiers par ce flux, quelle que soit la raison.
 */
publicTablesRouter.delete("/matches/:matchId/table-assignments/:role", async (c) => {
  const matchId = c.req.param("matchId");
  const role = c.req.param("role");
  if (!matchId || !role) throw badRequest("Paramètres de route manquants.");

  const query = PublicTokenQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));

  await resolvePublicLicencie(c, query.data.token);
  const club = c.get("publicClub");
  const me = c.get("publicLicencie");

  const parsedRole = PublicAssignRoleQueryDtoSchema.shape.role.safeParse(role);
  if (!parsedRole.success) throw badRequest(`Rôle inconnu : ${role}.`);

  await removeTableRole(club.id, matchId, parsedRole.data, { onlyIfLicencieId: me.id });

  return c.json({ removed: true as const });
});
