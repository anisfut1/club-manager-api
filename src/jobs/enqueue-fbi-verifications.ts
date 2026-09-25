import type { DbClient } from "../db/client.js";
import { logError } from "../logger.js";

const UNIQUE_VIOLATION = "23505";

export interface EnqueueFbiVerificationJobsResult {
  reconcileScheduleCreated: boolean;
  reconcileScheduleAlreadyQueued: boolean;
  checkAllDerogationsCreated: boolean;
  checkAllDerogationsAlreadyQueued: boolean;
  skippedNotConfigured: boolean;
}

/**
 * Empile UN job `reconcile_schedule` ET UN job `check_all_derogations` par
 * club FBI configuré, chaque jour (cron) — demande du club : "faut aussi
 * intégrer toutes ces maj dans le cron daily qui va récup les infos en
 * automatique, sans cliquer h24 sur des boutons manuels". Avant cet ajout,
 * ces deux vérifications n'étaient déclenchées QUE par les boutons manuels
 * de la page Intégrations → FBI (`ReconcileFbiScheduleButton`,
 * `CheckAllDerogationsButton`) : jamais reprises par le cron existant
 * (`/internal/cron/fbi-jobs` ne fait que CONSOMMER les jobs déjà en file,
 * il n'en crée aucun tout seul).
 *
 * Gate sur `fbi_integration_status.configured` uniquement (jamais
 * `auto_import_emarque`, propre à la récupération e-Marque — voir
 * `enqueueEmarqueDiscoveryJobsForClub` — sans rapport avec le calendrier ou
 * les dérogations). Idempotent : la contrainte unique de `fbi_jobs` (un
 * seul job actif de ce type par club) absorbe un appel répété le lendemain
 * sans dupliquer si la veille n'a pas encore été traitée.
 */
export async function enqueueFbiVerificationJobsForClub(supabase: DbClient, clubId: string): Promise<EnqueueFbiVerificationJobsResult> {
  const result: EnqueueFbiVerificationJobsResult = {
    reconcileScheduleCreated: false,
    reconcileScheduleAlreadyQueued: false,
    checkAllDerogationsCreated: false,
    checkAllDerogationsAlreadyQueued: false,
    skippedNotConfigured: false,
  };

  const { data: fbiStatus, error: fbiStatusError } = await supabase.from("fbi_integration_status").select("configured").eq("club_id", clubId).maybeSingle();

  if (fbiStatusError) {
    throw new Error(`Lecture du statut FBI échouée : ${fbiStatusError.message}`);
  }

  if (!fbiStatus?.configured) {
    result.skippedNotConfigured = true;
    return result;
  }

  const { error: reconcileError } = await supabase.from("fbi_jobs").insert({ club_id: clubId, type: "reconcile_schedule" });
  if (!reconcileError) {
    result.reconcileScheduleCreated = true;
  } else if (reconcileError.code === UNIQUE_VIOLATION) {
    result.reconcileScheduleAlreadyQueued = true;
  } else {
    logError("Création du job de rapprochement calendrier échouée (cron)", reconcileError, { clubId });
  }

  const { error: derogationsError } = await supabase.from("fbi_jobs").insert({ club_id: clubId, type: "check_all_derogations" });
  if (!derogationsError) {
    result.checkAllDerogationsCreated = true;
  } else if (derogationsError.code === UNIQUE_VIOLATION) {
    result.checkAllDerogationsAlreadyQueued = true;
  } else {
    logError("Création du job de vérification globale des dérogations échouée (cron)", derogationsError, { clubId });
  }

  return result;
}

export interface EnqueueFbiVerificationJobsAllClubsResult {
  clubsProcessed: number;
  perClub: Record<string, EnqueueFbiVerificationJobsResult>;
}

/** Parcourt tous les clubs actifs et empile leurs jobs — même logique d'isolation par club que `enqueueEmarqueDiscoveryJobsForAllClubs`. */
export async function enqueueFbiVerificationJobsForAllClubs(supabase: DbClient): Promise<EnqueueFbiVerificationJobsAllClubsResult> {
  const { data: activeClubs, error: clubsError } = await supabase.from("clubs").select("id").eq("status", "active");

  if (clubsError) {
    throw new Error(`Recherche des clubs actifs échouée : ${clubsError.message}`);
  }

  const result: EnqueueFbiVerificationJobsAllClubsResult = { clubsProcessed: 0, perClub: {} };

  for (const club of activeClubs ?? []) {
    try {
      result.perClub[club.id] = await enqueueFbiVerificationJobsForClub(supabase, club.id);
      result.clubsProcessed += 1;
    } catch (error) {
      logError("Empilement des jobs de vérification FBI en erreur pour un club", error, { clubId: club.id });
    }
  }

  return result;
}
