import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { getFbiCredentials } from "../integrations/fbi/credentials-store.js";
import { BrowserFbiClient, type BrowserFbiSession } from "../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../integrations/fbi/browser-launcher.js";
import { classifyFbiLoginStatus, FbiError } from "../integrations/fbi/errors.js";
import { nextErrorBackoffSeconds } from "./backoff.js";
import { getEnv } from "../config/env.js";
import { logError, logInfo } from "../logger.js";

async function rescheduleJob(supabase: DbClient, job: FbiJobRow, delaySeconds: number, lastError: string | null): Promise<void> {
  await supabase
    .from("fbi_jobs")
    .update({ status: "pending", scheduled_at: new Date(Date.now() + delaySeconds * 1000).toISOString(), last_error: lastError })
    .eq("id", job.id);
}

async function failJob(supabase: DbClient, job: FbiJobRow, message: string): Promise<void> {
  await supabase.from("fbi_jobs").update({ status: "failed", finished_at: new Date().toISOString(), last_error: message }).eq("id", job.id);
}

async function recordLoginOutcome(supabase: DbClient, clubId: string, success: boolean, message: string | null): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("fbi_integration_status").upsert(
    { club_id: clubId, configured: true, last_login_at: now, last_login_success: success, last_job_at: now, last_job_status: success ? "success" : "error", last_error: success ? null : message, updated_at: now },
    { onConflict: "club_id" },
  );
}

/**
 * Traite un job `check_all_derogations` : login FBI (UNE SEULE fois pour
 * tout le club — "je veux un bouton global qui check toutes les demandes,
 * pas match par match", demande du club, 2026-09-25), récupère TOUTES les
 * dérogations FBI en une recherche non filtrée
 * (`BrowserFbiClient.fetchAllDerogations`), les rapproche des rencontres du
 * club déjà synchronisées FFBB par numéro (`competitions`/`matches.numero`
 * ne suffit pas ici, la clé FBI est le numéro SEUL — voir docs/FBI.md),
 * écrit/supprime les lignes `fbi_derogation_checks` correspondantes.
 * LECTURE SEULE, jamais d'écriture sur FBI (voir docs/FBI.md).
 */
export async function processCheckAllDerogationsJob(supabase: DbClient, job: FbiJobRow): Promise<boolean> {
  const credentials = await getFbiCredentials(supabase, job.club_id);
  if (!credentials) {
    await failJob(supabase, job, "Aucun identifiant FBI enregistré pour ce club.");
    return false;
  }

  const browser = await launchServerlessBrowser();
  const client = new BrowserFbiClient({ baseUrl: getEnv().FBI_BASE_URL, browser });
  let session: BrowserFbiSession;

  try {
    session = await client.login(credentials);
    await recordLoginOutcome(supabase, job.club_id, true, null);
  } catch (error) {
    const status = classifyFbiLoginStatus(error);
    const message = error instanceof FbiError ? error.message : "Connexion FBI impossible.";
    await recordLoginOutcome(supabase, job.club_id, false, message);

    if (status === "INVALID_CREDENTIALS" || status === "AUTH_FLOW_CHANGED") {
      await failJob(supabase, job, message);
    } else if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, `Connexion FBI en échec après ${job.attempt_count} tentatives : ${message}`);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    logError("Job check_all_derogations : connexion FBI échouée", error, { clubId: job.club_id, jobId: job.id, loginStatus: status });
    await browser.close();
    return false;
  }

  try {
    const derogations = await client.fetchAllDerogations(session);

    const { data: matches, error: matchesError } = await supabase.from("matches").select("id, numero").eq("club_id", job.club_id);
    if (matchesError) throw new Error(`Lecture des rencontres du club échouée : ${matchesError.message}`);

    const matchIdByNumero = new Map((matches ?? []).filter((m) => m.numero).map((m) => [m.numero as string, m.id]));

    const now = new Date().toISOString();
    let matched = 0;
    let unmatched = 0;

    for (const derogation of derogations) {
      const matchId = derogation.numero ? matchIdByNumero.get(derogation.numero) : undefined;
      if (!matchId) {
        // Dérogation FBI sans rencontre FFBB correspondante trouvée (pas
        // encore synchronisée, ou numéro non reconnu) — ignorée : cette
        // table est scopée par match_id (contrainte NOT NULL), jamais de
        // ligne orpheline créée.
        unmatched += 1;
        continue;
      }

      const { error: upsertError } = await supabase.from("fbi_derogation_checks").upsert(
        {
          club_id: job.club_id,
          match_id: matchId,
          numero: derogation.numero,
          etat: derogation.etat,
          date_depot: derogation.dateDepot,
          date_derogation: derogation.dateDerogation,
          date_rencontre: derogation.dateRencontre,
          heure: derogation.heure,
          domicile: derogation.domicile,
          visiteur: derogation.visiteur,
          checked_at: now,
          updated_at: now,
        },
        { onConflict: "club_id,match_id" },
      );
      if (upsertError) throw new Error(`Écriture du résultat de dérogation échouée : ${upsertError.message}`);
      matched += 1;
    }

    const result = { derogationsFound: derogations.length, matched, unmatched };
    await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: now, result }).eq("id", job.id);

    logInfo("Job check_all_derogations réussi", { clubId: job.club_id, jobId: job.id, ...result });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, message);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    logError("Job check_all_derogations en erreur", error, { clubId: job.club_id, jobId: job.id });
    return false;
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
