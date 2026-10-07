/**
 * Test décisif « UNE connexion FBI, rien d'autre » (2026-10-07), à lancer sur
 * un poste où FBI répond (Mac du club). Isolé : aucune base de données, aucun
 * job, aucune variable de production — rien n'est envoyé ailleurs que vers FBI.
 *
 * Déroulé :
 *   1. sonde réseau couche par couche AVANT (extranet.ffbb.com + témoin
 *      resultats.ffbb.com, même bloc d'adresses) ; FBI injoignable = arrêt,
 *      aucune connexion tentée ;
 *   2. Chromium local via Playwright ;
 *   3. UNE connexion avec le moteur de PRODUCTION (`BrowserFbiClient.login`,
 *      mêmes options que la découverte e-Marque : `lightSession: true`) ;
 *   4. aucune recherche, aucun téléchargement ;
 *   5. fin de session comme en production (`closeSession` : déconnexion FBI
 *      puis fermeture), ou session gardée ouverte et inactive (`--keep-session`) ;
 *   6. sondes immédiatement puis toutes les 5 min pendant 30 min ;
 *   7. aucune reconnexion, quoi qu'il arrive ;
 *   8. journal horodaté (JSONL) : heure exacte de chaque requête de la
 *      connexion (chemins seulement) et de chaque sonde.
 *
 * Usage : npm run fbi:login-test -- [--interval-min 5] [--duration-min 30] [--keep-session] [--headed]
 * Identifiants saisis au clavier (mot de passe masqué), jamais écrits.
 */
import { appendFileSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { BrowserFbiClient, type BrowserFbiSession } from "../../src/integrations/fbi/browser-client.js";
import { probeFbiLayers, type LayeredProbeResult } from "../../src/integrations/fbi/layered-probe.js";
import { ask } from "../fbi-session-worker/prompt.js";

const args = process.argv.slice(2);
const numberArg = (name: string, fallback: number) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};
const intervalMin = numberArg("--interval-min", 5);
const durationMin = numberArg("--duration-min", 30);
const keepSession = args.includes("--keep-session");
const headed = args.includes("--headed");
// Surchargeables uniquement pour l'auto-test contre le faux FBI (ops/fbi-session-worker/fake-fbi-server.mjs).
const BASE_URL = process.env.FBI_TEST_BASE_URL || "https://extranet.ffbb.com/fbi";
const CONTROL_HOST = process.env.FBI_TEST_CONTROL_HOST || "resultats.ffbb.com";
const base = new URL(BASE_URL);
const fbiTarget = { host: base.hostname, port: base.port ? Number(base.port) : base.protocol === "https:" ? 443 : 80, useTls: base.protocol === "https:", path: `${base.pathname}/connexion.fbi` };
const logFile = `fbi-login-test-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;

function log(event: string, data: Record<string, unknown> = {}): void {
  const row = { at: new Date().toISOString(), event, ...data };
  appendFileSync(logFile, `${JSON.stringify(row)}\n`);
}

function summarize(result: LayeredProbeResult) {
  return {
    classification: result.classification,
    failedLayer: result.failedLayer,
    address: result.tcp?.address ?? result.dns.addresses[0] ?? null,
    dnsMs: result.dns.elapsedMs,
    tcpMs: result.tcp?.elapsedMs ?? null,
    tcpError: result.tcp?.error ?? null,
    tlsMs: result.tls?.elapsedMs ?? null,
    tlsIssuer: result.tls?.certIssuer ?? null,
    httpStatus: result.http?.status ?? null,
    httpMs: result.http?.elapsedMs ?? null,
    httpError: result.http?.error ?? null,
  };
}

/** Phrases visibles d'une page FBI qui ressemblent à un message d'erreur ou d'information. */
function visibleMessages(html: string): string[] {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&eacute;/g, "é")
    .replace(/&egrave;/g, "è")
    .replace(/&agrave;/g, "à");
  const lines = text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line.length > 15);
  const pattern = /incorrect|invalide|erron|bloqu|verrouill|expir|session|tentative|captcha|désactiv|suspendu|refus|erreur|échec|connect/i;
  return [...new Set(lines.filter((line) => pattern.test(line)))].slice(0, 5).map((line) => line.slice(0, 200));
}

async function egressIp(): Promise<string | null> {
  try {
    const response = await fetch("https://checkip.amazonaws.com/", { signal: AbortSignal.timeout(5_000) });
    return response.ok ? (await response.text()).trim() : null;
  } catch {
    return null;
  }
}

async function probe(label: string): Promise<boolean> {
  const [fbi, control, ip] = await Promise.all([
    probeFbiLayers({ ...fbiTarget, tcpTimeoutMs: 10_000, httpTimeoutMs: 20_000 }),
    probeFbiLayers({ host: CONTROL_HOST, path: "/", tcpTimeoutMs: 10_000, httpTimeoutMs: 20_000 }),
    egressIp(),
  ]);
  const fbiSummary = summarize(fbi);
  const controlSummary = summarize(control);
  log("probe", { label, egressIp: ip, fbi: fbiSummary, control: { host: CONTROL_HOST, ...controlSummary } });
  const reachable = fbi.tcp?.ok === true && fbi.http?.status !== null && fbi.http?.status !== undefined;
  console.log(
    `[${new Date().toISOString()}] ${label.padEnd(14)} FBI : ${fbi.classification}` +
      ` (TCP ${fbiSummary.tcpMs ?? "-"} ms, HTTP ${fbiSummary.httpStatus ?? "-"})` +
      ` | témoin : ${control.tcp?.ok ? `TCP ${controlSummary.tcpMs} ms` : control.classification}` +
      ` | IP ${ip ?? "?"}`,
  );
  return reachable;
}

async function main(): Promise<void> {
  console.log(`Journal : ${logFile}`);
  log("test_started", { intervalMin, durationMin, keepSession, headed, node: process.version, platform: process.platform });

  // 1. Avant tout : FBI joignable ?
  if (!(await probe("avant"))) {
    log("test_aborted", { reason: "FBI injoignable avant le test — aucune connexion tentée" });
    console.log("FBI injoignable avant le test : aucune connexion tentée. Fin.");
    return;
  }

  const username = await ask("Identifiant FBI : ", false);
  const password = await ask("Mot de passe FBI (masqué) : ", true);

  // 2. Chromium local, mêmes options que la production hors binaire (production : @sparticuz/chromium sur Vercel).
  const browser: Browser = await chromium.launch({
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled"],
    ...(process.env.FBI_TEST_CHROMIUM ? { executablePath: process.env.FBI_TEST_CHROMIUM } : {}),
  });
  log("browser_launched", { version: browser.version() });

  // Message affiché par FBI en réponse au formulaire (mot de passe incorrect,
  // compte bloqué, session déjà ouverte…) : lu sur la réponse du POST, sans
  // toucher au moteur de production. Texte visible seulement (balises et
  // valeurs de champs retirées : jamais l'identifiant ni le mot de passe).
  let loginResponse: { status: number; messages: string[] } | null = null;
  const originalNewContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await originalNewContext(options);
    context.on("response", async (response) => {
      if (response.request().method() !== "POST" || !/identification\.fbi/.test(response.url())) return;
      const html = await response.text().catch(() => "");
      loginResponse = { status: response.status(), messages: visibleMessages(html) };
    });
    return context;
  };
  const client = new BrowserFbiClient({ baseUrl: BASE_URL, browser, lightSession: true });

  // 3. UNE connexion. Jamais d'autre appel à `login`, même en cas d'échec.
  let session: BrowserFbiSession | null = null;
  const loginStartedAt = new Date().toISOString();
  log("login_started");
  try {
    session = await client.login({ username, password });
    log("login_finished", { ok: true, startedAt: loginStartedAt, finalPath: new URL(session.page.url()).pathname });
    console.log(`[${new Date().toISOString()}] connexion       : réussie (${new URL(session.page.url()).pathname})`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    log("login_finished", { ok: false, startedAt: loginStartedAt, error: message, code: (error as { code?: string }).code ?? null, fbiResponse: loginResponse });
    console.log(`[${new Date().toISOString()}] connexion       : ÉCHEC — ${message} (aucune nouvelle tentative)`);
    const shown = (loginResponse as { messages: string[] } | null)?.messages ?? [];
    console.log(`                           message affiché par FBI : ${shown.length ? shown.join(" | ") : "(aucun message reconnu)"}`);
  }
  // Horodatage exact de chaque requête de la connexion (chemins, statuts, erreurs réseau).
  const trace = client.lastTrace;
  if (trace) {
    const identification = trace.events.find((e) => e.m === "POST" && e.u.includes("identification"));
    log("login_trace", {
      traceStartedAt: trace.startedAt,
      identificationPostAt: identification ? new Date(Date.parse(trace.startedAt) + identification.t).toISOString() : null,
      events: trace.events,
      dropped: trace.dropped,
      fingerprint: trace.fingerprint,
    });
  }

  // 4. Aucune recherche, aucun téléchargement.
  // 5. Fin de session.
  if (session && !keepSession) {
    await client.closeSession(session);
    log("session_closed", { how: "closeSession (déconnexion FBI puis fermeture, comme en production)" });
    const logout = client.lastTrace?.events.find((e) => e.u.includes("deconnexion"));
    if (logout) log("logout_request", { status: logout.s, durationMs: logout.d });
  } else if (session) {
    log("session_kept", { how: "session gardée ouverte, aucune requête jusqu'à la fin du test" });
  }
  if (!keepSession) await browser.close();

  // 6. Sondes : immédiatement, puis toutes les `intervalMin` minutes pendant `durationMin` minutes.
  const steps = Math.floor(durationMin / intervalMin);
  for (let step = 0; step <= steps; step += 1) {
    if (step > 0) await new Promise((resolve) => setTimeout(resolve, intervalMin * 60_000));
    await probe(step === 0 ? "immédiat" : `+${step * intervalMin} min`);
  }

  if (keepSession) {
    // Fin du test : fermeture locale SANS requête FBI (la session expirera d'elle-même côté FBI).
    await browser.close();
    log("session_closed", { how: "fermeture locale sans déconnexion (--keep-session)" });
  }
  log("test_finished");
  console.log(`Terminé. Journal complet : ${logFile}`);
}

process.on("SIGINT", () => {
  log("test_interrupted");
  console.log(`\nInterrompu. Journal : ${logFile}`);
  process.exit(130);
});

main().catch((error: unknown) => {
  log("test_crashed", { error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
  console.error(error);
  process.exit(1);
});
