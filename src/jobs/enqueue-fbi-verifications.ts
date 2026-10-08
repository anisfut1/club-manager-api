import type { DbClient } from "../db/client.js";
import { logError } from "../logger.js";

const UNIQUE_VIOLATION = "23505";

/**
 * Fenêtre "déjà lancé aujourd'hui" (voir `hasRecentJob` ci-dessous), en
 * millisecondes — un peu sous 24h pour que la cadence dérive naturellement
 * plus tôt dans la journée plutôt que de risquer de sauter un jour si le
 * cron GitHub Actions a le moindre retard/jitter.
 */
const ALREADY_RAN_TODAY_WINDOW_MS = 20 * 60 * 60 * 1000;

export interface EnqueueFbiVerificationJobsResult {
  reconcileScheduleCreated: boolean;
  reconcileScheduleAlreadyQueued: boolean;
  checkAllDerogationsCreated: boolean;
  checkAllDerogationsAlreadyQueued: boolean;
  importLicencesCreated: boolean;
  importLicencesAlreadyQueued: boolean;
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
 * les dérogations).
 *
 * Idempotent "une fois par jour" via `hasRecentJob` (fenêtre glissante,
 * `created_at`, TOUS statuts confondus) — PAS juste via la contrainte
 * unique de `fbi_jobs` (un seul job ACTIF de ce type par club). Constaté en
 * production le 2026-09-30 : depuis le passage du cron Vercel (1x/jour) au
 * relai GitHub Actions (toutes les 15 minutes, voir fbi-frequent-sync.yml), un job
 * `reconcile_schedule`/`check_all_derogations` qui RÉUSSIT libère
 * IMMÉDIATEMENT la contrainte unique (elle ne couvre que pending/claimed/
 * running) — le cycle suivant, 15 minutes plus tard, en recrée un neuf.
 * Résultat sur une seule journée : 39 `check_all_derogations` + 23
 * `reconcile_schedule` exécutés (au lieu d'1 chacun), qui doivent CHACUN se
 * reconnecter à FBI — ces connexions à répétition monopolisaient la file
 * `fbi_jobs` (traitée à 1 job/cycle, voir `JOB_BATCH_SIZE`) et empêchaient
 * des `discover_emarque` bien plus anciens d'être ne serait-ce que
 * réclamés une seule fois en 11h, malgré un ordre de priorité correct.
 */
export async function enqueueFbiVerificationJobsForClub(supabase: DbClient, clubId: string): Promise<EnqueueFbiVerificationJobsResult> {
  const result: EnqueueFbiVerificationJobsResult = {
    reconcileScheduleCreated: false,
    reconcileScheduleAlreadyQueued: false,
    checkAllDerogationsCreated: false,
    checkAllDerogationsAlreadyQueued: false,
    importLicencesCreated: false,
    importLicencesAlreadyQueued: false,
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

  if (await hasRecentJob(supabase, clubId, "reconcile_schedule")) {
    result.reconcileScheduleAlreadyQueued = true;
  } else {
    const { error: reconcileError } = await supabase.from("fbi_jobs").insert({ club_id: clubId, type: "reconcile_schedule" });
    if (!reconcileError) {
      result.reconcileScheduleCreated = true;
    } else if (reconcileError.code === UNIQUE_VIOLATION) {
      result.reconcileScheduleAlreadyQueued = true;
    } else {
      logError("Création du job de rapprochement calendrier échouée (cron)", reconcileError, { clubId });
    }
  }

  if (await hasRecentJob(supabase, clubId, "check_all_derogations")) {
    result.checkAllDerogationsAlreadyQueued = true;
  } else {
    const { error: derogationsError } = await supabase.from("fbi_jobs").insert({ club_id: clubId, type: "check_all_derogations" });
    if (!derogationsError) {
      result.checkAllDerogationsCreated = true;
    } else if (derogationsError.code === UNIQUE_VIOLATION) {
      result.checkAllDerogationsAlreadyQueued = true;
    } else {
      logError("Création du job de vérification globale des dérogations échouée (cron)", derogationsError, { clubId });
    }
  }

  // Licences validées (retour du club, 2026-10-08 : « importe automatiquement les licenciés ») : une fois par jour aussi.
  if (await hasRecentJob(supabase, clubId, "import_licences")) {
    result.importLicencesAlreadyQueued = true;
  } else {
    const { error: licencesError } = await supabase.from("fbi_jobs").insert({ club_id: clubId, type: "import_licences" });
    if (!licencesError) {
      result.importLicencesCreated = true;
    } else if (licencesError.code === UNIQUE_VIOLATION) {
      result.importLicencesAlreadyQueued = true;
    } else {
      logError("Création du job d'import des licences échouée (cron)", licencesError, { clubId });
    }
  }

  return result;
}

/** Un job de ce type a-t-il déjà été créé pour ce club dans la fenêtre "aujourd'hui" (tous statuts confondus) ? */
async function hasRecentJob(supabase: DbClient, clubId: string, type: "reconcile_schedule" | "check_all_derogations" | "import_licences"): Promise<boolean> {
  const since = new Date(Date.now() - ALREADY_RAN_TODAY_WINDOW_MS).toISOString();
  const { data, error } = await supabase.from("fbi_jobs").select("id").eq("club_id", clubId).eq("type", type).gte("created_at", since).limit(1);

  if (error) {
    logError("Vérification du job récent échouée (cron) — on suppose aucun job récent par sécurité", error, { clubId, type });
    return false;
  }

  return (data?.length ?? 0) > 0;
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
