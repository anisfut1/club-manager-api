/**
 * Worker FBI local (2026-10-07) : exécute le traitement FBI de PRODUCTION
 * (mêmes jobs, mêmes fonctions que `/internal/cron/fbi-jobs`) depuis un poste
 * dont l'accès à FBI fonctionne (Mac du club), à la place de Vercel.
 *
 * - Prise de relais : tant qu'il tourne, il renouvelle `fbi_paused_until`
 *   (bail de 30 min) — Vercel ne se connecte plus à FBI. Arrêté (Ctrl+C), il
 *   libère le bail ; éteint brutalement, le bail expire seul en 30 min et
 *   Vercel reprend.
 * - Une passe toutes les 15 min : jobs dus ? → dernière connexion FBI de plus
 *   de 12 min ? → FBI joignable (requête anonyme) ? → UN job (une connexion).
 * - Le parsing des feuilles reste fait par l'API (workflow toutes les 15 min).
 *
 * Configuration : fichier `.env.fbi-local` à la racine (voir README), rempli
 * par l'utilisateur sur SON poste ; jamais commité (.gitignore).
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";

const ENV_FILE = ".env.fbi-local";
if (!existsSync(ENV_FILE)) {
  console.error(`Fichier ${ENV_FILE} introuvable à la racine du dépôt — voir ops/fbi-local-worker/README.md.`);
  process.exit(1);
}
process.loadEnvFile(ENV_FILE);
process.env.BROWSER_FBI_ENABLED = "true";
process.env.FBI_LOCAL_BROWSER = "1";
// Requis par la validation de configuration de l'API, inutilisés ici.
process.env.CRON_SECRET ||= "worker-local-non-utilise";
process.env.FRONTEND_ORIGINS ||= "http://localhost";

const INTERVAL_MIN = Number(process.env.FBI_LOCAL_INTERVAL_MIN || 15);
const LEASE_MIN = 30;

const { createServiceSupabaseClient } = await import("../../src/db/client.js");
const { claimNextDiscoverJobInSession, claimNextJob } = await import("../../src/jobs/claim.js");
const { processJobBatch } = await import("../../src/jobs/process-batch.js");
const { checkFbiReachability, recordFbiReachability, recentFbiCredentialLogin } = await import("../../src/integrations/fbi/fbi-diagnostics.js");

const supabase = createServiceSupabaseClient();
const workerId = `local#${hostname()}`;

function stamp(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function setLease(until: Date | null): Promise<void> {
  const { error } = await supabase
    .from("platform_settings")
    .upsert({ key: "fbi_paused_until", value: until ? until.toISOString() : "", updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) stamp(`bail Vercel : écriture impossible (${error.message})`);
}

async function pass(): Promise<void> {
  await setLease(new Date(Date.now() + LEASE_MIN * 60_000));

  const { data: due, error } = await supabase.from("fbi_jobs").select("id").eq("status", "pending").lte("scheduled_at", new Date().toISOString());
  if (error) return stamp(`lecture des jobs impossible : ${error.message}`);
  if (!due || due.length === 0) return stamp("aucun job FBI dû");

  const lastLogin = await recentFbiCredentialLogin(supabase);
  if (lastLogin) return stamp(`${due.length} job(s) dû(s), dernière connexion FBI à ${lastLogin.toISOString()} (< 12 min) : passage suivant`);

  const reachability = await checkFbiReachability(undefined);
  await recordFbiReachability(supabase, reachability);
  if (!reachability.ok) return stamp(`FBI injoignable (${reachability.error ?? `HTTP ${reachability.httpStatus}`}) : passage suivant, aucune connexion`);

  stamp(`${due.length} job(s) dû(s), FBI joignable (${reachability.elapsedMs} ms) : traitement d'un job`);
  const result = await processJobBatch(supabase, 1, () => claimNextJob(supabase, workerId), {
    claimNextDiscoverInSession: (clubId) => claimNextDiscoverJobInSession(supabase, clubId, workerId),
  });
  stamp(`résultat : ${JSON.stringify(result)}`);
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  stamp("arrêt : bail libéré, Vercel reprend la main");
  void setLease(null).finally(() => process.exit(0));
});

stamp(`worker FBI local démarré (${workerId}), une passe toutes les ${INTERVAL_MIN} min — Ctrl+C pour arrêter`);
for (;;) {
  try {
    await pass();
  } catch (error) {
    stamp(`passe en erreur : ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MIN * 60_000));
}
