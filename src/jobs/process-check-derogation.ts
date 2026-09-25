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
 * Traite un job `check_derogation` : login FBI (navigateur), consulte
 * l'état de la dérogation d'UN match par numéro de rencontre
 * (`rechercherDerogation.fbi`, voir docs/FBI.md — demande du club, "faut
 * qu'on gere les derog depuis l'outil"), journalise le résultat dans
 * `fbi_derogation_checks`. LECTURE SEULE : ne soumet/modifie jamais de
 * dérogation — cette phase (écriture) est volontairement pas construite
 * (voir "Ce qui n'est pas fait" dans docs/FBI.md).
 */
export async function processCheckDerogationJob(supabase: DbClient, job: FbiJobRow): Promise<boolean> {
  if (!job.match_id) {
    await failJob(supabase, job, "Job check_derogation sans match_id (ne devrait jamais arriver, voir la contrainte NOT NULL applicative).");
    return false;
  }

  const { data: match, error: matchError } = await supabase.from("matches").select("id, club_id, numero").eq("id", job.match_id).maybeSingle();

  if (matchError || !match || !match.numero) {
    await failJob(supabase, job, `Match introuvable ou sans numéro de rencontre : ${matchError?.message ?? "numero manquant"}`);
    return false;
  }

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

    logError("Job check_derogation : connexion FBI échouée", error, { clubId: job.club_id, jobId: job.id, loginStatus: status });
    await browser.close();
    return false;
  }

  try {
    const derogation = await client.fetchDerogationForMatch(session, match.numero);
    const now = new Date().toISOString();

    if (derogation) {
      const { error: upsertError } = await supabase.from("fbi_derogation_checks").upsert(
        {
          club_id: job.club_id,
          match_id: job.match_id,
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
    } else {
      // Aucune dérogation trouvée pour ce match — supprime une éventuelle
      // ligne périmée d'une vérification précédente plutôt que de la
      // laisser afficher un état obsolète.
      await supabase.from("fbi_derogation_checks").delete().eq("club_id", job.club_id).eq("match_id", job.match_id);
    }

    await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: now, result: { found: Boolean(derogation) } }).eq("id", job.id);

    logInfo("Job check_derogation réussi", { clubId: job.club_id, jobId: job.id, matchId: job.match_id, found: Boolean(derogation) });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, message);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    logError("Job check_derogation en erreur", error, { clubId: job.club_id, jobId: job.id, matchId: job.match_id });
    return false;
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
