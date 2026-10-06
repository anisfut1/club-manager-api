import type { DbClient } from "../db/client.js";
import { logError, logInfo } from "../logger.js";
import { currentSeasonStart } from "../season.js";
import { emarqueCheckWindowStart, nextEmarqueCheckAt } from "./backoff.js";

const UNIQUE_VIOLATION = "23505";

export interface EnqueueEmarqueJobsResult {
  candidatesExamined: number;
  jobsCreated: number;
  alreadyQueued: number;
  skippedNotConfigured: boolean;
}

/**
 * Empile un job `discover_emarque` PAR MATCH CANDIDAT de ce club, au lieu
 * de faire le travail FBI en ligne — un job `discover_emarque` est ensuite
 * consommé par `/internal/cron/fbi-jobs` (voir process-discover-emarque.ts),
 * qui seul pilote Playwright.
 *
 * FBI EST FACULTATIF : un club sans FBI configuré, ou avec
 * `auto_import_emarque` désactivé, n'obtient AUCUN job — ce n'est jamais
 * une erreur, juste `skippedNotConfigured: true`. Un club dont FBI est
 * configuré mais actuellement EN ERREUR obtient quand même ses jobs (ils
 * échoueront et seront replanifiés) : le calendrier FFBB de ce club
 * continue de fonctionner indépendamment.
 */
export async function enqueueEmarqueDiscoveryJobsForClub(supabase: DbClient, clubId: string): Promise<EnqueueEmarqueJobsResult> {
  const result: EnqueueEmarqueJobsResult = {
    candidatesExamined: 0,
    jobsCreated: 0,
    alreadyQueued: 0,
    skippedNotConfigured: false,
  };

  const { data: fbiStatus, error: fbiStatusError } = await supabase
    .from("fbi_integration_status")
    .select("configured, auto_import_emarque")
    .eq("club_id", clubId)
    .maybeSingle();

  if (fbiStatusError) {
    throw new Error(`Lecture du statut FBI échouée : ${fbiStatusError.message}`);
  }

  if (!fbiStatus?.configured || !fbiStatus.auto_import_emarque) {
    result.skippedNotConfigured = true;
    logInfo("Découverte e-Marque ignorée (FBI non configuré ou récupération automatique désactivée)", { clubId });
    return result;
  }

  const { data: candidates, error: candidatesError } = await supabase
    .from("matches")
    .select("id, numero, match_datetime, emarque_status")
    .eq("club_id", clubId)
    .eq("status", "played")
    // "error" inclus (processus déterministe, 2026-10-06) : une lecture en
    // échec est retentée au créneau suivant tant que la fenêtre de 7 jours
    // court, jamais laissée bloquée.
    .in("emarque_status", ["pending", "waiting_for_emarque", "error"])
    // Saison en cours uniquement (retour du club, 2026-10-02) : 28 matchs de la saison
    // précédente (avril-mai), jamais disponibles sur FBI, saturaient la file d'un job / 15 min.
    .gte("match_datetime", currentSeasonStart().toISOString());

  if (candidatesError) {
    throw new Error(`Recherche des matchs candidats à la découverte e-Marque échouée : ${candidatesError.message}`);
  }

  const queueable = (candidates ?? []).filter((match) => Boolean(match.numero));
  result.candidatesExamined = queueable.length;

  const { data: activeJobs, error: activeJobsError } = await supabase
    .from("fbi_jobs")
    .select("match_id")
    .eq("club_id", clubId)
    .eq("type", "discover_emarque")
    .in("status", ["pending", "claimed", "running"]);
  if (activeJobsError) throw new Error(`Lecture des jobs e-Marque en cours échouée : ${activeJobsError.message}`);
  const alreadyQueuedMatchIds = new Set((activeJobs ?? []).map((job) => job.match_id));

  const now = new Date();
  for (const match of queueable) {
    if (alreadyQueuedMatchIds.has(match.id)) {
      result.alreadyQueued += 1;
      continue;
    }

    // Calendrier fixe (`nextEmarqueCheckAt`) : premier essai dès la fin du
    // match ; une lecture en erreur attend le créneau suivant ; fenêtre de
    // 7 jours écoulée -> "pas de feuille e-Marque" (jamais pour une erreur
    // de lecture, qui reste visible comme telle).
    const windowStart = emarqueCheckWindowStart(match.match_datetime, null) ?? now;
    const nextSlot = nextEmarqueCheckAt(windowStart, now);
    if (!nextSlot) {
      if (match.emarque_status !== "error") {
        await supabase.from("matches").update({ emarque_status: "not_available" }).eq("id", match.id);
      }
      continue;
    }
    const scheduledAt = match.emarque_status === "error" ? nextSlot : now < windowStart ? windowStart : now;

    const { error: insertError } = await supabase.from("fbi_jobs").insert({
      club_id: clubId,
      match_id: match.id,
      type: "discover_emarque",
      scheduled_at: scheduledAt.toISOString(),
    });

    if (!insertError) {
      result.jobsCreated += 1;
      continue;
    }

    if (insertError.code === UNIQUE_VIOLATION) {
      result.alreadyQueued += 1;
      continue;
    }

    logError("Création d'un job de découverte e-Marque échouée", insertError, { clubId, matchId: match.id });
  }

  logInfo("Empilement des jobs de découverte e-Marque terminé", { clubId, ...result });
  return result;
}

export interface EnqueueEmarqueJobsAllClubsResult {
  clubsProcessed: number;
  perClub: Record<string, EnqueueEmarqueJobsResult>;
}

/** Parcourt tous les clubs actifs et empile leurs jobs — pas de verrou nécessaire, insérer des lignes fbi_jobs est court et idempotent (contrainte unique). */
export async function enqueueEmarqueDiscoveryJobsForAllClubs(supabase: DbClient): Promise<EnqueueEmarqueJobsAllClubsResult> {
  const { data: activeClubs, error: clubsError } = await supabase.from("clubs").select("id").eq("status", "active");

  if (clubsError) {
    throw new Error(`Recherche des clubs actifs échouée : ${clubsError.message}`);
  }

  const result: EnqueueEmarqueJobsAllClubsResult = { clubsProcessed: 0, perClub: {} };

  for (const club of activeClubs ?? []) {
    try {
      result.perClub[club.id] = await enqueueEmarqueDiscoveryJobsForClub(supabase, club.id);
      result.clubsProcessed += 1;
    } catch (error) {
      logError("Empilement des jobs de découverte e-Marque en erreur pour un club", error, { clubId: club.id });
    }
  }

  return result;
}
