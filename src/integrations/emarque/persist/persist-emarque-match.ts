import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, EmarqueImportStatus } from "../../../db/types.js";
import { logError, logInfo } from "../../../logger.js";
import type { EMarqueCoach, EMarqueMatchData, EMarqueOfficial, EMarquePlayer, EMarquePlayerStat, EMarqueTableOfficial, TeamSide } from "../types.js";

type Client = SupabaseClient<Database>;

const UNIQUE_VIOLATION = "23505";

export interface PersistEmarqueMatchParams {
  matchId: string;
  clubId: string;
  fileHash: string;
  sourceFileName: string | null;
  storagePath: string | null;
  parserVersion: string;
  data: EMarqueMatchData;
}

export interface PersistEmarqueMatchResult {
  importId: string;
  status: EmarqueImportStatus;
  alreadyImported: boolean;
  participantsLinked: number;
  participantsUnlinked: number;
}

/**
 * Retrouve le `licencie` correspondant EXACTEMENT à un numéro de licence, au
 * sein du club. Ambigu (plusieurs licenciés partageant le même numéro — ne
 * devrait jamais arriver mais on ne suppose rien) ou absent -> pas de lien.
 * On ne crée JAMAIS de licencié à partir d'une extraction (ARCHITECTURE.md §26).
 */
async function findLicencieIdByLicense(supabase: Client, clubId: string, licenseNumber: string | null): Promise<string | null> {
  if (!licenseNumber) return null;

  const { data, error } = await supabase.from("licencies").select("id").eq("club_id", clubId).eq("license_number", licenseNumber);

  if (error) {
    logError("Recherche licencié par numéro de licence échouée", error, { licenseNumber });
    return null;
  }

  if (!data || data.length !== 1) return null;
  return data[0]!.id;
}

/** Détermine le statut final d'import à partir des avertissements qualité : une seule erreur suffit à réclamer une revue humaine (ARCHITECTURE.md §24). */
function statusFromWarnings(data: EMarqueMatchData): "imported" | "needs_review" {
  const hasError = data.quality.warnings.some((w) => w.severity === "error");
  return hasError ? "needs_review" : "imported";
}

/**
 * Auto-provisionne un `licencies` pour un·e joueur·se du CLUB LUI-MÊME
 * (jamais l'équipe adverse — voir `insertParticipants`, qui ne l'appelle
 * que pour `player.teamSide === clubTeamSide`) quand aucun licencié
 * existant ne correspond déjà à son numéro de licence.
 *
 * Sans ce pas, `licencies` restait VIDE en production (rien d'autre dans
 * ce backend n'y insère de ligne — confirmé le 2026-09-25, 0 licencié pour
 * le club pilote malgré des numéros de licence correctement lus) : la
 * demande du club ("associer chaque joueur à sa licence" pour une future
 * fiche joueur, voir `docs/LICENCIES.md`) restait donc structurellement
 * impossible à satisfaire, quelle que soit la qualité de l'OCR.
 *
 * Exige un prénom ET un nom de famille non vides — jamais un `licencies`
 * créé avec une identité devinée ou vide (ARCHITECTURE.md §22) : reste
 * `null` sinon, un futur import (autre match, meilleure lecture OCR pour
 * cette même personne) pourra retenter.
 *
 * `teamId` (celui du match d'origine, `matches.team_id`) est renseigné dès
 * la création si connu — demande du club de sectoriser le roster par
 * équipe (docs/TEAMS.md) : sans ce pas, un·e joueur·se nouvellement
 * provisionné·e resterait sans équipe jusqu'à une affectation manuelle,
 * alors que le match qui l'a fait apparaître connaît déjà son équipe.
 */
async function autoProvisionLicencieId(supabase: Client, clubId: string, player: EMarquePlayer, teamId: string | null): Promise<string | null> {
  if (!player.licenseNumber || !player.firstName?.trim() || !player.lastName?.trim()) return null;

  const { data, error } = await supabase
    .from("licencies")
    .insert({ club_id: clubId, first_name: player.firstName.trim(), last_name: player.lastName.trim(), license_number: player.licenseNumber, team_id: teamId })
    .select("id")
    .single();

  if (!error) return data?.id ?? null;

  if (error.code === UNIQUE_VIOLATION) {
    // Course avec un autre import (même numéro de licence entre-temps déjà
    // créé, ex: deux matchs de la même personne traités en parallèle) :
    // jamais une erreur qui ferait échouer tout l'import, on retrouve
    // simplement le licencié déjà créé par l'autre import.
    return findLicencieIdByLicense(supabase, clubId, player.licenseNumber);
  }

  logError("Auto-provisionnement d'un licencié depuis e-Marque échoué", error, { clubId, licenseNumber: player.licenseNumber });
  return null;
}

async function insertParticipants(
  supabase: Client,
  clubId: string,
  matchId: string,
  importId: string,
  players: EMarquePlayer[],
  /** Le "camp" (home/away) tenu par CE club dans CE match — voir `persistEmarqueMatchData`. `null` si `matches.is_home` n'est pas renseigné : dans ce cas, aucun auto-provisionnement (on ne devine jamais quelle équipe est la nôtre). */
  clubTeamSide: TeamSide | null,
  /** `matches.team_id` du match d'origine — transmis à `autoProvisionLicencieId` pour rattacher le·la nouveau·elle licencié·e à son équipe dès sa création (docs/TEAMS.md). `null` si le match n'a pas d'équipe interne connue. */
  teamId: string | null,
): Promise<{ linked: number; unlinked: number; byKey: Map<string, string> }> {
  const byKey = new Map<string, string>();
  let linked = 0;
  let unlinked = 0;

  for (const player of players) {
    let licencieId = await findLicencieIdByLicense(supabase, clubId, player.licenseNumber);

    if (!licencieId && clubTeamSide && player.teamSide === clubTeamSide) {
      licencieId = await autoProvisionLicencieId(supabase, clubId, player, teamId);
    }

    if (licencieId) linked += 1;
    else unlinked += 1;

    const { data, error } = await supabase
      .from("match_participants")
      .insert({
        club_id: clubId,
        match_id: matchId,
        emarque_import_id: importId,
        team_side: player.teamSide,
        jersey_number: player.jerseyNumber,
        first_name: player.firstName,
        last_name: player.lastName,
        license_number: player.licenseNumber,
        is_captain: player.isCaptain,
        is_starter: player.isStarter,
        licencie_id: licencieId,
        extraction_confidence: player.confidence,
      })
      .select("id")
      .single();

    if (error || !data) {
      throw new Error(`Insertion participant (maillot ${player.jerseyNumber ?? "?"}) échouée : ${error?.message}`);
    }

    byKey.set(`${player.teamSide}:${player.jerseyNumber ?? ""}`, data.id);
  }

  return { linked, unlinked, byKey };
}

async function insertPlayerStats(
  supabase: Client,
  clubId: string,
  matchId: string,
  stats: EMarquePlayerStat[],
  participantIdByKey: Map<string, string>,
): Promise<void> {
  for (const stat of stats) {
    const participantId = participantIdByKey.get(`${stat.teamSide}:${stat.jerseyNumber ?? ""}`);
    // Pas de participant correspondant (joueur listé au résumé mais pas sur
    // la feuille de match, ou maillot illisible d'un côté) : on ignore cette
    // ligne de statistiques plutôt que de deviner un rattachement.
    if (!participantId) continue;

    const { error } = await supabase.from("player_match_stats").insert({
      club_id: clubId,
      match_id: matchId,
      participant_id: participantId,
      seconds_played: stat.secondsPlayed,
      points: stat.points,
      shots_made: stat.shotsMade,
      three_points_made: stat.threePointsMade,
      two_points_interior_made: stat.twoPointsInteriorMade,
      two_points_exterior_made: stat.twoPointsExteriorMade,
      free_throws_made: stat.freeThrowsMade,
      fouls_committed: stat.foulsCommitted,
    });

    if (error) {
      throw new Error(`Insertion statistiques (maillot ${stat.jerseyNumber ?? "?"}) échouée : ${error.message}`);
    }
  }
}

async function insertCoaches(supabase: Client, clubId: string, matchId: string, importId: string, coaches: EMarqueCoach[]): Promise<void> {
  for (const coach of coaches) {
    const licencieId = await findLicencieIdByLicense(supabase, clubId, coach.licenseNumber);

    const { error } = await supabase.from("match_coaches").insert({
      club_id: clubId,
      match_id: matchId,
      emarque_import_id: importId,
      team_side: coach.teamSide,
      role: coach.role,
      first_name: coach.firstName,
      last_name: coach.lastName,
      license_number: coach.licenseNumber,
      licencie_id: licencieId,
    });

    if (error) {
      throw new Error(`Insertion entraîneur échouée : ${error.message}`);
    }
  }
}

async function insertOfficials(supabase: Client, clubId: string, matchId: string, importId: string, officials: EMarqueOfficial[]): Promise<void> {
  for (const official of officials) {
    const licencieId = await findLicencieIdByLicense(supabase, clubId, official.licenseNumber);

    const { error } = await supabase.from("match_officials").insert({
      club_id: clubId,
      match_id: matchId,
      emarque_import_id: importId,
      role: official.role,
      first_name: official.firstName,
      last_name: official.lastName,
      license_number: official.licenseNumber,
      licencie_id: licencieId,
    });

    if (error) {
      throw new Error(`Insertion arbitre échouée : ${error.message}`);
    }
  }
}

async function insertTableOfficials(
  supabase: Client,
  clubId: string,
  matchId: string,
  importId: string,
  tableOfficials: EMarqueTableOfficial[],
): Promise<void> {
  for (const official of tableOfficials) {
    const licencieId = await findLicencieIdByLicense(supabase, clubId, official.licenseNumber);

    const { error } = await supabase.from("match_table_officials").insert({
      club_id: clubId,
      match_id: matchId,
      emarque_import_id: importId,
      role: official.role,
      first_name: official.firstName,
      last_name: official.lastName,
      license_number: official.licenseNumber,
      licencie_id: licencieId,
      extraction_confidence: official.confidence,
    });

    if (error) {
      throw new Error(`Insertion officiel de table échouée : ${error.message}`);
    }
  }
}

/**
 * Écrit le résultat du parser e-Marque en base pour un match donné.
 *
 * Idempotence : `file_hash` est UNIQUE sur `emarque_imports`. Si un import
 * avec le même hash existe déjà, cette fonction ne retraite rien et renvoie
 * l'import existant tel quel (ARCHITECTURE.md §19/§27) — un fichier
 * identique n'est jamais reparsé ni ré-inséré.
 *
 * En cas d'échec en cours d'écriture, l'import est marqué `error` (jamais
 * laissé dans un état intermédiaire silencieux) et l'erreur est relancée
 * pour que l'appelant (job de découverte e-Marque) puisse la journaliser et
 * programmer une nouvelle tentative.
 */
export async function persistEmarqueMatchData(supabase: Client, params: PersistEmarqueMatchParams): Promise<PersistEmarqueMatchResult> {
  const { matchId, clubId, fileHash, sourceFileName, storagePath, parserVersion, data } = params;

  const { data: existingImport, error: existingImportError } = await supabase
    .from("emarque_imports")
    .select("id, status")
    .eq("club_id", clubId)
    .eq("file_hash", fileHash)
    .maybeSingle();

  if (existingImportError) {
    throw new Error(`Recherche d'import e-Marque existant échouée : ${existingImportError.message}`);
  }

  if (existingImport) {
    logInfo("Import e-Marque déjà traité (hash identique), aucune ré-écriture", { importId: existingImport.id, fileHash });
    return { importId: existingImport.id, status: existingImport.status, alreadyImported: true, participantsLinked: 0, participantsUnlinked: 0 };
  }

  const { data: importRow, error: importInsertError } = await supabase
    .from("emarque_imports")
    .insert({
      club_id: clubId,
      match_id: matchId,
      source: "fbi",
      file_hash: fileHash,
      source_file_name: sourceFileName,
      storage_path: storagePath,
      status: "parsing",
      parser_version: parserVersion,
      quality_warnings: data.quality.warnings,
      downloaded_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (importInsertError || !importRow) {
    throw new Error(`Création de l'import e-Marque échouée : ${importInsertError?.message}`);
  }

  const importId = importRow.id;

  // Détermine quel "camp" e-Marque (home/away) est CELUI DU CLUB pour ce
  // match — seul ce camp est éligible à l'auto-provisionnement de licenciés
  // (voir `autoProvisionLicencieId`, jamais l'équipe adverse). `null` si
  // `matches.is_home` n'est pas renseigné : jamais une supposition.
  const { data: matchRow } = await supabase.from("matches").select("is_home, team_id").eq("id", matchId).maybeSingle();
  const clubTeamSide: TeamSide | null = matchRow?.is_home === true ? "home" : matchRow?.is_home === false ? "away" : null;
  const matchTeamId: string | null = matchRow?.team_id ?? null;

  try {
    const { linked, unlinked, byKey } = await insertParticipants(supabase, clubId, matchId, importId, data.players, clubTeamSide, matchTeamId);
    await insertPlayerStats(supabase, clubId, matchId, data.playerStats, byKey);
    await insertCoaches(supabase, clubId, matchId, importId, data.coaches);
    await insertOfficials(supabase, clubId, matchId, importId, data.officials);
    await insertTableOfficials(supabase, clubId, matchId, importId, data.tableOfficials);

    const finalStatus = statusFromWarnings(data);

    const { error: updateImportError } = await supabase
      .from("emarque_imports")
      .update({ status: finalStatus, imported_at: new Date().toISOString() })
      .eq("id", importId);

    if (updateImportError) {
      throw new Error(`Mise à jour du statut d'import échouée : ${updateImportError.message}`);
    }

    const { error: updateMatchError } = await supabase.from("matches").update({ emarque_status: finalStatus }).eq("id", matchId);

    if (updateMatchError) {
      logError("Mise à jour de matches.emarque_status échouée", updateMatchError, { matchId, importId });
    }

    logInfo("Import e-Marque terminé", { importId, matchId, status: finalStatus, participantsLinked: linked, participantsUnlinked: unlinked });

    return { importId, status: finalStatus, alreadyImported: false, participantsLinked: linked, participantsUnlinked: unlinked };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await supabase.from("emarque_imports").update({ status: "error", last_error: message }).eq("id", importId);
    await supabase.from("matches").update({ emarque_status: "error" }).eq("id", matchId);

    logError("Import e-Marque en erreur, écriture partielle possible", error, { importId, matchId });

    throw error;
  }
}
