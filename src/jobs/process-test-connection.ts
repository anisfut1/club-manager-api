import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { getFbiCredentials } from "../integrations/fbi/credentials-store.js";
import { attemptBrowserFbiLogin } from "../integrations/fbi/browser-login-attempt.js";
import { logError, logInfo } from "../logger.js";

/**
 * Traite un job `test_connection` via `BrowserFbiClient`
 * (`attemptBrowserFbiLogin`, factorisé avec `POST .../fbi/test`).
 *
 * Depuis le 2026-09-24 (voir docs/FBI.md), `POST .../fbi/test` n'enqueue
 * plus ce type de job : il appelle `attemptBrowserFbiLogin` directement et
 * répond de façon synchrone — un admin cliquant "Tester la connexion"
 * attend un résultat immédiat, pas un aller-retour par
 * `/internal/cron/fbi-jobs` (qui ne tourne qu'une fois par jour, voir
 * vercel.json) nécessitant un déclenchement manuel du dashboard Vercel.
 * Ce traitement de job reste néanmoins en place : rien n'empêche un futur
 * appelant (retry différé, diagnostic admin en arrière-plan) de créer un
 * job `test_connection` plutôt que d'appeler le chemin synchrone.
 */
export async function processTestConnectionJob(supabase: DbClient, job: FbiJobRow): Promise<boolean> {
  const credentials = await getFbiCredentials(supabase, job.club_id);
  const testedAt = new Date().toISOString();

  if (!credentials) {
    await supabase.from("fbi_jobs").update({ status: "failed", finished_at: testedAt, last_error: "Aucun identifiant FBI enregistré." }).eq("id", job.id);
    return false;
  }

  const attempt = await attemptBrowserFbiLogin(credentials);

  await supabase.from("fbi_integration_status").upsert(
    // last_error: null sur succès — sinon un échec précédent reste affiché
    // indéfiniment sur /admin/intégrations à côté d'un statut "Connecté ✅"
    // (contradiction constatée en production le 2026-09-22, voir docs/FBI.md).
    {
      club_id: job.club_id,
      configured: true,
      last_test_at: testedAt,
      last_test_success: attempt.success,
      last_test_message: attempt.message,
      last_login_at: attempt.success ? testedAt : undefined,
      last_login_success: attempt.success,
      last_error: attempt.success ? null : attempt.message,
      updated_at: testedAt,
    },
    { onConflict: "club_id" },
  );

  if (attempt.success) {
    await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: testedAt, result: { loginStatus: attempt.loginStatus } }).eq("id", job.id);
    logInfo("Job test_connection réussi (navigateur)", { clubId: job.club_id, jobId: job.id });
    return true;
  }

  await supabase.from("fbi_jobs").update({ status: "failed", finished_at: testedAt, last_error: attempt.message, result: { loginStatus: attempt.loginStatus } }).eq("id", job.id);
  logError("Job test_connection en échec (navigateur)", new Error(attempt.message), { clubId: job.club_id, jobId: job.id, loginStatus: attempt.loginStatus });
  return false;
}
