import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { getFbiCredentials } from "../integrations/fbi/credentials-store.js";
import { BrowserFbiClient } from "../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../integrations/fbi/browser-launcher.js";
import { classifyFbiLoginStatus, FbiError } from "../integrations/fbi/errors.js";
import { getEnv } from "../config/env.js";
import { logError, logInfo } from "../logger.js";

/**
 * Traite un job `test_connection` via `BrowserFbiClient` — utilisé UNIQUEMENT
 * en secours quand `HttpFbiClient` (chemin synchrone principal, voir
 * src/modules/integrations/routes.ts) échoue avec `LOGIN_FORM_NOT_RECOGNIZED`
 * OU `LOGIN_FAILED`, ET que `BROWSER_FBI_ENABLED=true` (§35 de la demande,
 * élargi à `LOGIN_FAILED` le 2026-09-22 — voir docs/FBI.md). Un navigateur
 * réussissant là où le HTTP direct échoue indique soit un changement de
 * structure de page, soit une protection anti-bot (empreinte TLS/JS)
 * qu'un `fetch` brut ne peut pas contourner mais qu'un vrai Chromium peut
 * franchir — confirmé en production pour un premier club.
 */
export async function processTestConnectionJob(supabase: DbClient, job: FbiJobRow): Promise<void> {
  const credentials = await getFbiCredentials(supabase, job.club_id);
  const testedAt = new Date().toISOString();

  if (!credentials) {
    await supabase.from("fbi_jobs").update({ status: "failed", finished_at: testedAt, last_error: "Aucun identifiant FBI enregistré." }).eq("id", job.id);
    return;
  }

  const browser = await launchServerlessBrowser();
  const client = new BrowserFbiClient({ baseUrl: getEnv().FBI_BASE_URL, browser });

  try {
    const session = await client.login(credentials);
    await client.closeSession(session);

    await supabase.from("fbi_integration_status").upsert(
      // last_error: null — sinon l'échec HTTP qui a déclenché ce repli
      // navigateur (LOGIN_FAILED, voir routes.ts) reste affiché
      // indéfiniment sur /admin/intégrations à côté d'un statut
      // "Connecté ✅", contradiction constatée en production le
      // 2026-09-22 (voir docs/FBI.md).
      { club_id: job.club_id, configured: true, last_test_at: testedAt, last_test_success: true, last_test_message: "Connexion réussie (navigateur).", last_login_at: testedAt, last_login_success: true, last_error: null, updated_at: testedAt },
      { onConflict: "club_id" },
    );
    await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: testedAt, result: { loginStatus: "CONNECTED" } }).eq("id", job.id);
    logInfo("Job test_connection réussi (navigateur)", { clubId: job.club_id, jobId: job.id });
  } catch (error) {
    const status = classifyFbiLoginStatus(error);
    const message = error instanceof FbiError ? error.message : "Connexion FBI impossible.";

    await supabase.from("fbi_integration_status").upsert(
      { club_id: job.club_id, configured: true, last_test_at: testedAt, last_test_success: false, last_test_message: message, last_login_success: false, last_error: message, updated_at: testedAt },
      { onConflict: "club_id" },
    );
    await supabase.from("fbi_jobs").update({ status: "failed", finished_at: testedAt, last_error: message, result: { loginStatus: status } }).eq("id", job.id);
    logError("Job test_connection en échec (navigateur)", error, { clubId: job.club_id, jobId: job.id, loginStatus: status });
  } finally {
    await browser.close();
  }
}
