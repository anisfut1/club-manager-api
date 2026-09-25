import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership } from "../../auth/middleware.js";
import { createServiceSupabaseClient, type DbClient } from "../../db/client.js";
import { badRequest, forbidden, notFound } from "../../api-error.js";
import { isClubAdmin } from "../../tenancy/roles.js";
import {
  UpdateLicencieProfileDtoSchema,
  type LicencieDto,
  type LicencieMatchDto,
  type LicencieProfileDto,
  type LicenciesListDto,
} from "../../contracts/licencies.js";
import { rejectedFieldsFor, resolveLicencieEditPermission } from "./profile-fields.js";

export const licenciesRouter = new Hono<AppEnv>();

licenciesRouter.use("*", requireAuth);
licenciesRouter.use("*", requireClubMembership);

const LICENCIE_COLUMNS = "id, club_id, first_name, last_name, license_number, birth_date, email, phone, photo_url, active";

interface LicencieRow {
  id: string;
  club_id: string;
  first_name: string;
  last_name: string;
  license_number: string | null;
  birth_date: string | null;
  email: string | null;
  phone: string | null;
  photo_url: string | null;
  active: boolean;
}

function mapLicencieRow(row: LicencieRow): LicencieDto {
  return {
    id: row.id,
    clubId: row.club_id,
    firstName: row.first_name,
    lastName: row.last_name,
    licenseNumber: row.license_number,
    birthDate: row.birth_date,
    email: row.email,
    phone: row.phone,
    photoUrl: row.photo_url,
    active: row.active,
  };
}

/**
 * `club_memberships.licencie_id` de L'APPELANT COURANT sur CE club — jamais
 * `profiles.licencie_id` (devenu obsolète depuis le passage multi-tenant, le
 * rattachement est désormais PAR CLUB, voir supabase/migrations/
 * 20260921100020_club_memberships.sql). `null` si l'appelant n'est
 * rattaché à aucun licencié (compte admin/coach sans fiche joueur propre).
 */
async function getOwnLicencieId(supabase: DbClient, clubId: string, userId: string): Promise<string | null> {
  const { data } = await supabase.from("club_memberships").select("licencie_id").eq("club_id", clubId).eq("user_id", userId).eq("status", "active").maybeSingle();
  return data?.licencie_id ?? null;
}

/** GET /v1/clubs/:clubId/licencies — roster du club (tri alphabétique). RLS : tout membre actif du club (voir migration 20260925090000). */
licenciesRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const { data, error } = await supabase.from("licencies").select(LICENCIE_COLUMNS).eq("club_id", club.id).order("last_name").order("first_name");

  if (error) throw new Error(`Lecture des licenciés échouée : ${error.message}`);

  const licencies: LicencieDto[] = (data ?? []).map(mapLicencieRow);
  return c.json({ licencies } satisfies LicenciesListDto);
});

/**
 * GET /v1/clubs/:clubId/licencies/:licencieId — la "fiche joueur" (demande
 * du club) : identité + historique des matchs + statistiques par match.
 *
 * Deux requêtes séparées plutôt qu'un double embed PostgREST
 * (`match_participants` → `matches` PUIS `match_participants` → `player_
 * match_stats`) — même philosophie que `modules/matches/routes.ts#GET
 * /:matchId` : un embed enfant→parent (`match_participants.select("...,
 * matches(...)")`) est un pattern déjà éprouvé dans ce backend, jamais un
 * double embed simultané non testé contre le vrai schéma.
 */
licenciesRouter.get("/:licencieId", async (c) => {
  const { club, roles } = c.get("club");
  const user = c.get("user");
  const supabase = c.get("supabase");
  const licencieId = c.req.param("licencieId");
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");

  const { data: licencieRow } = await supabase.from("licencies").select(LICENCIE_COLUMNS).eq("id", licencieId).eq("club_id", club.id).maybeSingle();
  if (!licencieRow) throw notFound("Licencié introuvable.");

  const ownLicencieId = await getOwnLicencieId(supabase, club.id, user.id);
  const isSelf = ownLicencieId === licencieId;
  const { canEdit } = resolveLicencieEditPermission(isClubAdmin(roles), isSelf);

  const { data: participantRows } = await supabase
    .from("match_participants")
    .select("id, match_id, jersey_number, is_captain, is_starter, matches(numero, match_datetime, is_home, opponent_name, score_home, score_away, status)")
    .eq("club_id", club.id)
    .eq("licencie_id", licencieId);

  const participantIds = (participantRows ?? []).map((row) => row.id);
  const { data: statsRows } = participantIds.length
    ? await supabase
        .from("player_match_stats")
        .select("participant_id, seconds_played, points, three_points_made, two_points_interior_made, two_points_exterior_made, free_throws_made, fouls_committed")
        .in("participant_id", participantIds)
    : { data: [] as never[] };

  const statsByParticipantId = new Map((statsRows ?? []).map((row) => [row.participant_id, row]));

  const matches: LicencieMatchDto[] = (participantRows ?? [])
    .flatMap((row) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const match = (row as any).matches;
      if (!match) return [];

      const stats = statsByParticipantId.get(row.id);

      return [
        {
          matchId: row.match_id,
          numero: match.numero,
          matchDatetime: match.match_datetime,
          isHome: match.is_home,
          opponentName: match.opponent_name,
          scoreHome: match.score_home,
          scoreAway: match.score_away,
          status: match.status,
          jerseyNumber: row.jersey_number,
          isCaptain: row.is_captain,
          isStarter: row.is_starter,
          stats: stats
            ? {
                secondsPlayed: stats.seconds_played,
                points: stats.points,
                threePointsMade: stats.three_points_made,
                twoPointsInteriorMade: stats.two_points_interior_made,
                twoPointsExteriorMade: stats.two_points_exterior_made,
                freeThrowsMade: stats.free_throws_made,
                foulsCommitted: stats.fouls_committed,
              }
            : null,
        },
      ];
    })
    .sort((a, b) => (b.matchDatetime ?? "").localeCompare(a.matchDatetime ?? ""));

  const dto: LicencieProfileDto = {
    licencie: mapLicencieRow(licencieRow),
    canEdit,
    isSelf,
    matches,
  };

  return c.json(dto);
});

/**
 * PATCH /v1/clubs/:clubId/licencies/:licencieId/profile — demande du club
 * ("agrémenter en admin avec photo, infos persos... ou bien le joueur
 * direct s'il a un compte associé à son profil"). Toujours écrit via le
 * rôle service : la RLS actuelle ("licencies_all_club_admin") ne couvre
 * QUE le club_admin, jamais un licencié éditant SA PROPRE fiche — ajouter
 * une policy RLS self-service distincte par CHAMP serait fragile
 * (PostgreSQL ne compare pas nativement OLD/NEW par colonne dans une
 * policy `WITH CHECK`, voir docs/LICENCIES.md) ; la restriction de champs
 * est donc entièrement appliquée ICI, avant toute écriture, jamais
 * silencieusement — un champ hors de la population autorisée pour cet
 * appelant est REJETÉ (400), jamais ignoré.
 */
licenciesRouter.patch("/:licencieId/profile", async (c) => {
  const { club, roles } = c.get("club");
  const user = c.get("user");
  const supabase = c.get("supabase");
  const licencieId = c.req.param("licencieId");
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");

  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateLicencieProfileDtoSchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((issue) => issue.message).join(" "));

  const ownLicencieId = await getOwnLicencieId(supabase, club.id, user.id);
  const isSelf = ownLicencieId === licencieId;
  const { canEdit, allowedFields } = resolveLicencieEditPermission(isClubAdmin(roles), isSelf);

  if (!canEdit) throw forbidden("Vous ne pouvez pas modifier ce profil.");

  const rejectedFields = rejectedFieldsFor(parsed.data, allowedFields);
  if (rejectedFields.length > 0) {
    throw badRequest(`Champ(s) non autorisé(s) pour cet appelant : ${rejectedFields.join(", ")}.`);
  }

  const serviceSupabase = createServiceSupabaseClient();

  const { data: existing } = await serviceSupabase.from("licencies").select(LICENCIE_COLUMNS).eq("id", licencieId).eq("club_id", club.id).maybeSingle();
  if (!existing) throw notFound("Licencié introuvable.");

  const patch: Partial<{
    photo_url: string | null;
    email: string | null;
    phone: string | null;
    first_name: string;
    last_name: string;
    birth_date: string | null;
    license_number: string | null;
    active: boolean;
  }> = {};
  if (parsed.data.photoUrl !== undefined) patch.photo_url = parsed.data.photoUrl;
  if (parsed.data.email !== undefined) patch.email = parsed.data.email;
  if (parsed.data.phone !== undefined) patch.phone = parsed.data.phone;
  if (parsed.data.firstName !== undefined) patch.first_name = parsed.data.firstName;
  if (parsed.data.lastName !== undefined) patch.last_name = parsed.data.lastName;
  if (parsed.data.birthDate !== undefined) patch.birth_date = parsed.data.birthDate;
  if (parsed.data.licenseNumber !== undefined) patch.license_number = parsed.data.licenseNumber;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;

  if (Object.keys(patch).length === 0) return c.json(mapLicencieRow(existing));

  const { data, error } = await serviceSupabase.from("licencies").update(patch).eq("id", licencieId).select(LICENCIE_COLUMNS).single();
  if (error) throw new Error(`Mise à jour du profil du licencié échouée : ${error.message}`);

  return c.json(mapLicencieRow(data));
});
