import { BrowserFbiClient } from "./browser-client.js";
import { launchServerlessBrowser } from "./browser-launcher.js";
import { classifyFbiLoginStatus, FbiError, type FbiLoginStatus } from "./errors.js";
import type { FbiCredentialsInput } from "./types.js";
import { getEnv } from "../../config/env.js";

export interface BrowserLoginAttemptResult {
  success: boolean;
  message: string;
  loginStatus: FbiLoginStatus;
}

/**
 * Lance un Chromium serverless, tente une connexion FBI, ferme la session
 * et le navigateur — toujours, succès ou échec (`finally`). Factorisé
 * depuis `jobs/process-test-connection.ts` : utilisé aussi en SYNCHRONE par
 * `POST /v1/clubs/:clubId/integrations/fbi/test` (voir routes.ts) pour que
 * "Tester la connexion" réponde directement, sans job/cron intermédiaire —
 * un admin cliquant ce bouton attend une réponse immédiate, pas besoin de
 * déclencher `/internal/cron/fbi-jobs` à la main (constaté en production
 * le 2026-09-24, voir docs/FBI.md). `maxDuration: 300` (vercel.json) laisse
 * largement la place pour un login navigateur (quelques secondes en
 * pratique, voir docs/FBI.md "BrowserFbiClient sur Vercel").
 */
export async function attemptBrowserFbiLogin(credentials: FbiCredentialsInput): Promise<BrowserLoginAttemptResult> {
  const browser = await launchServerlessBrowser();
  const client = new BrowserFbiClient({ baseUrl: getEnv().FBI_BASE_URL, browser });

  try {
    const session = await client.login(credentials);
    await client.closeSession(session);
    return { success: true, message: "Connexion réussie (navigateur).", loginStatus: "CONNECTED" };
  } catch (error) {
    const loginStatus = classifyFbiLoginStatus(error);
    const message = error instanceof FbiError ? error.message : "Connexion FBI impossible.";
    return { success: false, message, loginStatus };
  } finally {
    await browser.close();
  }
}
