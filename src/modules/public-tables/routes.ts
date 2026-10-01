import { Hono } from "hono";
import type { DbClient } from "../../db/client.js";
import { badRequest, conflict, forbidden, notFound, serviceUnavailable, tooManyRequests, unauthorized } from "../../api-error.js";
import {
  PublicAssignRoleQueryDtoSchema,
  PublicTableAssignmentsQueryDtoSchema,
  PublicTokenQueryDtoSchema,
  RequestPersonalLinkDtoSchema,
} from "../../contracts/public-tables.js";
import { assignTableRole, loadHomeMatchOrThrow, loadTableAssignmentsList, removeTableRole } from "../tables/shared.js";
import { generatePublicToken, hashPublicToken } from "./token.js";
import { encryptPublicToken } from "./personal-link.js";
import { resolvePublicClub, type PublicClub } from "../public/club-resolver.js";
import { getEnv } from "../../config/env.js";
import { isEmailConfigured, sendEmail } from "../../email/resend.js";
import { buildPersonalLinkEmail, maskEmail } from "../../email/personal-link-email.js";
import { loadClubDerogations } from "../derogations/list.js";
import { loadLicencieActor } from "../derogation-requests/service.js";
import { canCreateAny, canManageRequests } from "../derogation-requests/policy.js";

/** Délai minimal entre deux envois de lien pour un même licencié — limite le spam et la rotation abusive du jeton par un tiers. */
export const PERSONAL_LINK_COOLDOWN_MS = 60_000;

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
export async function licencieFromToken(supabase: DbClient, clubId: string, token: string): Promise<{ id: string; first_name: string; last_name: string; team_id: string | null }> {
  const tokenHash = hashPublicToken(token);
  const { data: claim } = await supabase.from("licencie_public_tokens").select("licencie_id").eq("club_id", clubId).eq("token_hash", tokenHash).is("revoked_at", null).maybeSingle();
  if (!claim) throw unauthorized("Lien personnel invalide ou révoqué — demande à un·e responsable du club de réinitialiser ton profil.");

  const { data: licencie } = await supabase.from("licencies").select("id, first_name, last_name, team_id").eq("id", claim.licencie_id).eq("club_id", clubId).maybeSingle();
  if (!licencie) throw unauthorized("Lien personnel invalide.");
  return licencie;
}

async function resolvePublicLicencie(c: { get: (k: "supabase" | "publicClub") => DbClient | PublicClub; set: (k: "publicLicencie", v: PublicLicencie) => void }, token: string): Promise<void> {
  const supabase = c.get("supabase") as DbClient;
  const club = c.get("publicClub") as PublicClub;

  const licencie = await licencieFromToken(supabase, club.id, token);

  c.set("publicLicencie", { id: licencie.id, firstName: licencie.first_name, lastName: licencie.last_name, teamId: licencie.team_id });
}

/** GET /v1/public/clubs/:clubSlug — infos club minimales, jamais de données membres/rôles/FFBB ici. */
publicTablesRouter.get("/", (c) => {
  const club = c.get("publicClub");
  return c.json({ slug: club.slug, name: club.name, logoUrl: club.logoUrl, accentColor: club.accentColor, timezone: club.timezone });
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
 * Base du lien envoyé par email : l'origine de la requête si elle fait
 * partie des origines autorisées (le visiteur revient sur le frontend
 * qu'il utilise déjà), sinon PUBLIC_APP_URL, sinon la première origine
 * https de FRONTEND_ORIGINS. Jamais une origine arbitraire fournie par un
 * tiers — sinon un attaquant pourrait faire envoyer un lien piégé.
 */
export function resolvePublicAppBaseUrl(requestOrigin: string | undefined): string {
  const env = getEnv();
  const allowed = env.FRONTEND_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  if (env.PUBLIC_APP_URL) return env.PUBLIC_APP_URL.replace(/\/+$/, "");
  return allowed.find((o) => o.startsWith("https://")) ?? allowed[0] ?? "";
}

/**
 * POST /v1/public/clubs/:clubSlug/licencies/:licencieId/request-link —
 * retour du club, 2026-10-01 : "il va chercher son nom, il va mettre son
 * mail et on va mettre un système d'envoi de mail... un bouton qui renvoie
 * vers son lien avec token". Le jeton n'est JAMAIS renvoyé dans la réponse :
 * seul le propriétaire de la boîte mail peut l'obtenir.
 *
 * Adresse de destination :
 *  - une adresse est déjà connue (`licencies.email`, ou celle d'un lien
 *    actif) → l'email part TOUJOURS là, l'adresse saisie est ignorée
 *    (c'est aussi le "lien perdu ?") ;
 *  - aucune adresse connue et nom encore libre → l'adresse saisie est
 *    exigée, puis enregistrée sur la fiche du licencié après envoi réussi ;
 *  - aucune adresse connue mais nom déjà choisi (ancien flux, lien affiché
 *    à l'écran) → refus : seul un·e responsable peut réinitialiser, sinon
 *    n'importe qui pourrait détourner ce profil avec sa propre adresse.
 *
 * Chaque envoi émet un NOUVEAU jeton et révoque l'ancien (l'index unique
 * partiel n'autorise qu'un lien actif par licencié) ; en cas d'échec
 * d'envoi, l'ancien lien est restauré.
 */
publicTablesRouter.post("/licencies/:licencieId/request-link", async (c) => {
  const supabase = c.get("supabase");
  const club = c.get("publicClub");
  const licencieId = c.req.param("licencieId");
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");

  const body = RequestPersonalLinkDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));

  const { data: licencie } = await supabase.from("licencies").select("id, first_name, last_name, email").eq("id", licencieId).eq("club_id", club.id).eq("active", true).maybeSingle();
  if (!licencie) throw notFound("Licencié introuvable pour ce club.");

  const { data: activeTokens } = await supabase.from("licencie_public_tokens").select("id, email, created_at").eq("club_id", club.id).eq("licencie_id", licencie.id).is("revoked_at", null);
  const activeToken = (activeTokens ?? [])[0] ?? null;

  const knownEmail = licencie.email?.trim() || activeToken?.email?.trim() || null;
  if (!knownEmail && activeToken) {
    throw conflict("Ce nom a déjà été choisi sans adresse email. Demande à un·e responsable du club de réinitialiser ce profil.", "ALREADY_CLAIMED");
  }
  const targetEmail = knownEmail ?? body.data.email ?? null;
  if (!targetEmail) throw badRequest("Indique ton adresse email pour recevoir ton lien personnel.", "EMAIL_REQUIRED");

  if (activeToken && Date.now() - new Date(activeToken.created_at).getTime() < PERSONAL_LINK_COOLDOWN_MS) {
    throw tooManyRequests(`Un lien vient d'être envoyé à ${maskEmail(targetEmail)}. Vérifie ta boîte mail (et les spams) avant de redemander.`, "LINK_RECENTLY_SENT");
  }

  // Avant toute écriture : sans clé Resend, ne jamais révoquer un lien existant pour rien.
  if (!isEmailConfigured()) throw serviceUnavailable("L'envoi d'email n'est pas encore configuré pour ce club. Contacte un·e responsable.", "EMAIL_NOT_CONFIGURED");

  const revokedAt = new Date().toISOString();
  if (activeToken) await supabase.from("licencie_public_tokens").update({ revoked_at: revokedAt }).eq("id", activeToken.id).is("revoked_at", null);

  const token = generatePublicToken();
  const tokenHash = hashPublicToken(token);
  const { error } = await supabase.from("licencie_public_tokens").insert({ club_id: club.id, licencie_id: licencie.id, token_hash: tokenHash, token_ciphertext: encryptPublicToken(token, club.id, licencie.id), email: targetEmail });
  if (error) {
    // Deux demandes simultanées pour le même nom : la seconde perd la course (index unique partiel), l'autre lien est le bon.
    if (error.code === "23505") throw tooManyRequests("Une demande de lien est déjà en cours pour ce nom. Réessaie dans une minute.", "LINK_RECENTLY_SENT");
    if (activeToken) await supabase.from("licencie_public_tokens").update({ revoked_at: null }).eq("id", activeToken.id);
    throw new Error(`Création du lien personnel échouée : ${error.message}`);
  }

  const returnTo = body.data.returnTo ?? "tables";
  const link = `${resolvePublicAppBaseUrl(c.req.header("origin"))}/public/${encodeURIComponent(club.slug)}/${returnTo}?token=${encodeURIComponent(token)}`;
  const message = buildPersonalLinkEmail({ clubName: club.name, clubLogoUrl: club.logoUrl, accentColor: club.accentColor, firstName: licencie.first_name, link });

  try {
    await sendEmail({ to: targetEmail, fromName: club.name, ...message });
  } catch (sendError) {
    await supabase.from("licencie_public_tokens").update({ revoked_at: new Date().toISOString() }).eq("token_hash", tokenHash).is("revoked_at", null);
    if (activeToken) await supabase.from("licencie_public_tokens").update({ revoked_at: null }).eq("id", activeToken.id);
    throw sendError;
  }

  // "faudra aussi du coup stocker le mail du licencié" — seulement une première adresse, jamais l'écrasement d'une adresse existante.
  if (!licencie.email) await supabase.from("licencies").update({ email: targetEmail }).eq("id", licencie.id).eq("club_id", club.id);

  return c.json({ sent: true as const, maskedEmail: maskEmail(targetEmail) });
});

/**
 * Le licencié du jeton est-il admin de ce club pour l'espace public ? Soit
 * un club_admin lui a donné le profil admin depuis /joueurs
 * (`licencies.public_admin`), soit il est rattaché à un compte `club_admin`
 * ACTIF de ce club (club_memberships.licencie_id + membership_roles). Retour du club,
 * 2026-10-01 : les dérogations ne s'ouvrent publiquement qu'aux admins du
 * club — le jeton seul ne suffit jamais.
 */
export async function isLicencieClubAdmin(supabase: DbClient, clubId: string, licencieId: string): Promise<boolean> {
  // Drapeau posé par un club_admin depuis /joueurs (licencié sans compte, retour du club 2026-10-01).
  const { data: licencie } = await supabase.from("licencies").select("public_admin").eq("id", licencieId).eq("club_id", clubId).maybeSingle();
  if (licencie?.public_admin === true) return true;

  const { data: memberships } = await supabase.from("club_memberships").select("id").eq("club_id", clubId).eq("licencie_id", licencieId).eq("status", "active");
  const membershipIds = (memberships ?? []).map((m) => m.id);
  if (membershipIds.length === 0) return false;
  const { data: roles } = await supabase.from("membership_roles").select("membership_id").in("membership_id", membershipIds).eq("role", "club_admin");
  return (roles ?? []).length > 0;
}

/** GET /v1/public/clubs/:clubSlug/me?token= — vérifie/résout l'identité (pour un lien déjà en poche, ex: au chargement de la page). */
publicTablesRouter.get("/me", async (c) => {
  const query = PublicTokenQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));

  await resolvePublicLicencie(c, query.data.token);
  const licencie = c.get("publicLicencie");
  const supabase = c.get("supabase");
  const clubId = c.get("publicClub").id;
  const [isClubAdmin, actor] = await Promise.all([isLicencieClubAdmin(supabase, clubId, licencie.id), loadLicencieActor(supabase, clubId, licencie.id)]);
  // Demandes de dérogation internes : rôles posés depuis /joueurs (coach, coordinateur) ou compte rattaché.
  const derogationRequests = { canCreate: canCreateAny(actor), canManage: canManageRequests(actor) };
  return c.json({ licencie: { id: licencie.id, firstName: licencie.firstName, lastName: licencie.lastName }, isClubAdmin, derogationRequests });
});

/**
 * GET /v1/public/clubs/:clubSlug/derogations?token= — lecture SEULE des
 * dérogations depuis l'espace public (retour du club, 2026-10-01 : "s'il
 * clique sur dérogation, ça va lui demander de se co si token pas
 * reconnu"), réservée aux licenciés rattachés à un compte club_admin
 * actif : 401 sans jeton valide, 403 avec un jeton valide non admin.
 * Aucune action (répondre, vérifier sur FBI) n'est exposée ici.
 */
publicTablesRouter.get("/derogations", async (c) => {
  const query = PublicTokenQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));

  await resolvePublicLicencie(c, query.data.token);
  const supabase = c.get("supabase");
  const club = c.get("publicClub");
  const me = c.get("publicLicencie");

  if (!(await isLicencieClubAdmin(supabase, club.id, me.id))) throw forbidden("Accès réservé aux administrateurs du club.", "CLUB_ADMIN_REQUIRED");

  const derogations = await loadClubDerogations(supabase, club.id);
  return c.json({ derogations });
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
