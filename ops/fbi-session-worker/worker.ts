/**
 * Worker de test FBI « session persistante » (2026-10-07) — À NE PAS
 * CONFONDRE avec le pipeline de production (Vercel), qu'il ne touche pas.
 *
 * Question testée : une session FBI créée sur CE worker (VPS OVH, IP fixe,
 * accès DIRECT à FBI, sans proxy) reste-t-elle utilisable dans le temps
 * quand elle n'est réutilisée QUE depuis ce worker, ce navigateur et ce
 * profil Chromium, sans aucune nouvelle authentification ?
 *
 * Règles :
 * - UN seul navigateur Chromium, profil persistant, lancé au démarrage et
 *   gardé ouvert entre les passages (jamais recréé par passage) ;
 * - AUCUN identifiant stocké : la connexion n'a lieu que sur commande
 *   (`ctl.ts login`, saisie au clavier sur le VPS), une seule tentative,
 *   et elle est refusée tant que la session en cours est authentifiée ;
 * - renvoi vers la page d'identification = session expirée : journalisée
 *   avec ses preuves (chaîne de redirection, cookie JSESSIONID avant/après)
 *   et traitements authentifiés ARRÊTÉS — jamais de reconnexion automatique ;
 * - chaque passage commence par la sonde anonyme couche par couche
 *   (DNS/TCP/TLS/HTTP, voir src/integrations/fbi/layered-probe.ts) ;
 * - journal : fichier JSONL local + table `fbi_probe_events` (insertion
 *   seule, jeton du worker) si configurée. Jamais de mot de passe, de valeur
 *   de cookie (empreinte tronquée seulement) ni de contenu de page.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { chromium, type BrowserContext, type Page, type Response as PwResponse } from "playwright-core";
import { fbiBrowserIdentity } from "../../src/integrations/fbi/browser-client.js";
import { classifyChromiumNetError, classifyHttpStatus, isFbiLoginUrl, probeFbiLayers, type ProbeClassification } from "../../src/integrations/fbi/layered-probe.js";
import * as selectors from "../../src/integrations/fbi/selectors.js";
import { executeSearchQuery, searchFormFields } from "../../src/integrations/fbi/emarque-search.js";

const config = {
  workerId: process.env.FBI_WORKER_ID || hostname(),
  baseUrl: (process.env.FBI_BASE_URL || "https://extranet.ffbb.com/fbi").replace(/\/$/, ""),
  profileDir: process.env.FBI_WORKER_PROFILE_DIR || "/var/lib/fbi-session-worker/profile",
  logFile: process.env.FBI_WORKER_LOG || "/var/lib/fbi-session-worker/events.jsonl",
  socketPath: process.env.FBI_WORKER_SOCKET || "/run/fbi-session-worker/ctl.sock",
  tickMinutes: Number(process.env.FBI_WORKER_TICK_MINUTES || 15),
  /** Recherche e-Marque en lecture seule à chaque passage (optionnelle) : identifiant de saison FBI + numéro de rencontre. */
  searchSeasonId: process.env.FBI_WORKER_SEARCH_SEASON_ID || "",
  searchMatchNumber: process.env.FBI_WORKER_SEARCH_MATCH || "",
  supabaseUrl: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  probeToken: process.env.FBI_PROBE_TOKEN || "",
  /** Chromium à utiliser (sinon celui installé par `playwright-core install chromium`). */
  chromiumPath: process.env.FBI_WORKER_CHROMIUM || "",
  /**
   * Hôte témoin, même bloc d'adresses et même chemin réseau que FBI
   * (resultats.ffbb.com = 178.170.19.78, FBI = .77 ; traceroutes du 07/10) :
   * témoin joignable + FBI injoignable = blocage limité au serveur FBI,
   * pas une panne du chemin.
   */
  controlHost: process.env.FBI_WORKER_CONTROL_HOST ?? "resultats.ffbb.com",
};

type SessionState = "no_session" | "authenticated" | "expired";

interface WorkerEvent {
  kind: string;
  outcome: string;
  elapsedMs?: number;
  detail?: Record<string, unknown>;
}

let state: SessionState = "no_session";
let authenticatedSince: string | null = null;
let lastEvent: (WorkerEvent & { at: string }) | null = null;
let busy = false;

async function record(event: WorkerEvent): Promise<void> {
  const row = { worker_id: config.workerId, at: new Date().toISOString(), kind: event.kind, outcome: event.outcome, elapsed_ms: event.elapsedMs ?? null, state, detail: event.detail ?? {} };
  lastEvent = { ...event, at: row.at };
  await appendFile(config.logFile, `${JSON.stringify(row)}\n`).catch((error: unknown) => console.error("journal local impossible", error));
  console.log(`[${row.at}] ${row.kind} → ${row.outcome}${row.elapsed_ms !== null ? ` (${row.elapsed_ms} ms)` : ""}`);
  if (!config.supabaseUrl || !config.supabaseAnonKey || !config.probeToken) return;
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/fbi_probe_events`, {
      method: "POST",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
        "x-probe-token": config.probeToken,
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error(`envoi Supabase refusé : HTTP ${response.status}`);
  } catch (error) {
    console.error("envoi Supabase impossible", error instanceof Error ? error.message : error);
  }
}

async function egressIp(): Promise<string | null> {
  try {
    const response = await fetch("https://checkip.amazonaws.com/", { signal: AbortSignal.timeout(5_000) });
    return response.ok ? (await response.text()).trim() : null;
  } catch {
    return null;
  }
}

function chromeMajorVersion(): string {
  try {
    return /(\d+)\./.exec(execFileSync(config.chromiumPath || chromium.executablePath(), ["--version"], { encoding: "utf8" }))?.[1] ?? "141";
  } catch {
    return "141";
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host === new URL(config.baseUrl).host ? "" : parsed.host}${parsed.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

/** Cookie de session FBI : présence, empreinte tronquée (jamais la valeur), expiration. */
async function sessionCookie(context: BrowserContext): Promise<{ present: boolean; fingerprint: string | null; expires: number | null; names: string[] }> {
  const cookies = await context.cookies(config.baseUrl);
  const jsession = cookies.find((cookie) => cookie.name === "JSESSIONID");
  return {
    present: !!jsession,
    fingerprint: jsession ? createHash("sha256").update(jsession.value).digest("hex").slice(0, 10) : null,
    expires: jsession ? jsession.expires : null,
    names: cookies.map((cookie) => cookie.name),
  };
}

async function redirectChain(response: PwResponse | null): Promise<Array<{ path: string; status: number | null }>> {
  const chain: Array<{ path: string; status: number | null }> = [];
  let request = response?.request() ?? null;
  while (request) {
    const hop = await request.response();
    chain.unshift({ path: pathOf(request.url()), status: hop?.status() ?? null });
    request = request.redirectedFrom();
  }
  return chain;
}

type SessionVerdict = "authenticated" | "redirected_to_login" | "indeterminate" | ProbeClassification | "navigation_error";

/**
 * Visite de la page d'accueil FBI dans le navigateur persistant. Preuve
 * positive d'authentification : lien de déconnexion présent ET aucun champ
 * mot de passe. Preuve d'expiration : URL d'identification/connexion ou
 * formulaire de connexion. Sinon : indéterminé (jamais deviné).
 */
async function checkSession(page: Page, context: BrowserContext, label: string): Promise<SessionVerdict> {
  const before = await sessionCookie(context);
  const started = Date.now();
  let response: PwResponse | null = null;
  let navigationError: string | null = null;
  try {
    response = await page.goto(`${config.baseUrl}/accueil.fbi`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (error) {
    navigationError = error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : String(error);
  }
  const elapsedMs = Date.now() - started;
  const after = await sessionCookie(context);
  const chain = await redirectChain(response);
  const finalUrl = page.url();
  const passwordField = navigationError ? null : await selectors.looksLikeLoginPage(page).catch(() => null);
  const logoutLink = navigationError ? null : await selectors.logoutLink(page).count().then((n) => n > 0).catch(() => null);
  const status = response?.status() ?? null;

  let verdict: SessionVerdict;
  if (navigationError) verdict = classifyChromiumNetError(navigationError) ?? "navigation_error";
  else if (isFbiLoginUrl(finalUrl) || chain.some((hop) => isFbiLoginUrl(hop.path)) || passwordField) verdict = "redirected_to_login";
  else if (status !== null && status >= 400) verdict = classifyHttpStatus(status, null);
  else if (logoutLink && !passwordField) verdict = "authenticated";
  else verdict = "indeterminate";

  await record({
    kind: label,
    outcome: verdict,
    elapsedMs,
    detail: {
      status,
      finalPath: pathOf(finalUrl),
      chain,
      passwordField,
      logoutLink,
      navigationError,
      title: navigationError ? null : await page.title().catch(() => null),
      jsessionBefore: before,
      jsessionAfter: after,
      jsessionChanged: before.fingerprint !== after.fingerprint,
      authenticatedSince,
    },
  });
  return verdict;
}

interface SearchStep {
  name: string;
  status: number;
  redirected: boolean;
  finalUrl: string;
  bytes: number;
  json: boolean;
  passwordField: boolean;
  records: string | null;
}

const IN_PAGE_SEARCH = `async ({ searchUrl, form, query }) => {
  const step = async (name, response) => {
    const text = await response.text();
    const records = /"iTotalRecords"\\s*:\\s*"?(\\d+)/.exec(text);
    return { name, status: response.status, redirected: response.redirected, finalUrl: response.url, bytes: text.length, json: text.trim().startsWith("{"), passwordField: /type=["']?password/i.test(text), records: records ? records[1] : null };
  };
  try {
    const control = await fetch(searchUrl + "?action=controleRecherche", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams(form).toString(),
      credentials: "include",
      signal: AbortSignal.timeout(30000),
    });
    const first = await step("controleRecherche", control);
    const execute = await fetch(searchUrl + "?" + query, { headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "include", signal: AbortSignal.timeout(30000) });
    return { steps: [first, await step("executeRecherche", execute)], error: null };
  } catch (error) {
    return { steps: [], error: error && error.name ? error.name + ": " + error.message : String(error) };
  }
}`;

/** Recherche e-Marque en lecture seule (mêmes requêtes que le site), dans la page — jamais rejouée hors du navigateur. */
async function searchOnce(page: Page): Promise<void> {
  if (!config.searchSeasonId || !config.searchMatchNumber) return;
  const criteria = { seasonId: config.searchSeasonId, matchNumber: config.searchMatchNumber };
  const started = Date.now();
  // Code exécuté DANS la page, en texte brut : tsx/esbuild ajoute sinon un
  // utilitaire (`__name`) inconnu du navigateur aux fonctions nommées.
  const args = { searchUrl: `${config.baseUrl}/rechercherRencontreSaisieResultat.fbi`, form: searchFormFields(criteria), query: executeSearchQuery(criteria) };
  const outcome = await page
    .evaluate<{ steps: SearchStep[]; error: string | null }>(`(${IN_PAGE_SEARCH})(${JSON.stringify(args)})`)
    .catch((error: unknown) => ({ steps: [], error: `évaluation impossible : ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` }));

  const steps = outcome.steps.map((s) => ({ ...s, finalUrl: pathOf(s.finalUrl) }));
  const toLogin = steps.some((s) => isFbiLoginUrl(s.finalUrl) || s.passwordField);
  const verdict = outcome.error ? (classifyChromiumNetError(outcome.error) ?? "fetch_error") : toLogin ? "redirected_to_login" : steps.every((s) => s.status === 200 && s.json) ? "ok" : "unexpected_response";
  await record({ kind: "search", outcome: verdict, elapsedMs: Date.now() - started, detail: { steps, error: outcome.error } });
  if (verdict === "redirected_to_login") await markExpired("search");
}

async function markExpired(source: string): Promise<void> {
  state = "expired";
  await record({
    kind: "session_expired",
    outcome: "traitements_arretes",
    detail: { source, authenticatedSince, ageMinutes: authenticatedSince ? Math.round((Date.now() - Date.parse(authenticatedSince)) / 60_000) : null, note: "aucune reconnexion automatique — `ctl.ts login` pour une nouvelle session" },
  });
}

async function networkProbe(kind: string): Promise<void> {
  const base = new URL(config.baseUrl);
  const result = await probeFbiLayers({
    host: base.hostname,
    port: base.port ? Number(base.port) : base.protocol === "https:" ? 443 : 80,
    useTls: base.protocol === "https:",
    path: `${base.pathname}/connexion.fbi`,
  });
  const control = config.controlHost ? await probeFbiLayers({ host: config.controlHost, path: "/" }) : null;
  await record({
    kind,
    outcome: result.classification,
    elapsedMs: (result.dns.elapsedMs ?? 0) + (result.tcp?.elapsedMs ?? 0) + (result.tls?.elapsedMs ?? 0) + (result.http?.elapsedMs ?? 0),
    detail: {
      ...result,
      egressIp: await egressIp(),
      control: control && {
        host: control.host,
        address: control.tcp?.address ?? control.dns.addresses[0] ?? null,
        classification: control.classification,
        // Un 404 sur « / » du témoin est une réponse HTTP normale : seule compte l'ouverture TCP/TLS.
        tcpOk: control.tcp?.ok ?? false,
        tcpMs: control.tcp?.elapsedMs ?? null,
        httpStatus: control.http?.status ?? null,
      },
    },
  });
}

async function tick(page: Page, context: BrowserContext, reason: string): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await networkProbe("network_probe");
    if (state !== "authenticated") {
      await record({ kind: "tick", outcome: `aucun_traitement (${state})`, detail: { reason } });
      return;
    }
    const verdict = await checkSession(page, context, "session_check");
    if (verdict === "redirected_to_login") return markExpired("session_check");
    if (verdict !== "authenticated") {
      // Échec réseau ou réponse inattendue : localiser la couche tout de suite, sans toucher à la session.
      await networkProbe("network_probe_after_failure");
      return;
    }
    await searchOnce(page);
  } finally {
    busy = false;
  }
}

/** UNE tentative de connexion, sur commande uniquement. Refusée si la session en cours est authentifiée. */
async function login(page: Page, context: BrowserContext, credentials: { username: string; password: string }): Promise<string> {
  if (busy) return "occupé (passage en cours), réessayer dans un instant";
  busy = true;
  try {
    if (state === "authenticated") {
      const verdict = await checkSession(page, context, "session_check_before_login");
      if (verdict === "authenticated") {
        await record({ kind: "credential_login", outcome: "refusee_session_valide" });
        return "refusé : la session en cours est toujours authentifiée (aucune connexion effectuée)";
      }
      if (verdict === "redirected_to_login") await markExpired("session_check_before_login");
      else return `refusé : état de session indéterminé (${verdict}) — aucune connexion tant que ce n'est pas tranché`;
    }

    const started = Date.now();
    const before = await sessionCookie(context);
    try {
      const response = await page.goto(`${config.baseUrl}/connexion.fbi`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (!(await selectors.looksLikeLoginPage(page))) {
        await record({ kind: "credential_login", outcome: "formulaire_introuvable", elapsedMs: Date.now() - started, detail: { status: response?.status() ?? null, finalPath: pathOf(page.url()) } });
        return "échec : formulaire de connexion introuvable";
      }
      await selectors.usernameInput(page).fill(credentials.username);
      await selectors.passwordInput(page).fill(credentials.password);
      const submit = (await selectors.submitControl(page).count()) > 0 ? selectors.submitControl(page).first() : selectors.submitButtonByText(page);
      await submit.click();
      await page.waitForURL((url) => !/connexion\.fbi$/.test(url.pathname), { timeout: 30_000 }).catch(() => undefined);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : String(error);
      await record({ kind: "credential_login", outcome: classifyChromiumNetError(message) ?? "navigation_error", elapsedMs: Date.now() - started, detail: { error: message } });
      return `échec réseau pendant la connexion (${message}) — pas de nouvel essai automatique`;
    }
    const after = await sessionCookie(context);
    const loggedIn = !(await selectors.looksLikeLoginPage(page)) && (await selectors.logoutLink(page).count()) > 0;
    if (loggedIn) {
      state = "authenticated";
      authenticatedSince = new Date().toISOString();
    }
    await record({
      kind: "credential_login",
      outcome: loggedIn ? "ok" : "refusee_par_fbi",
      elapsedMs: Date.now() - started,
      detail: { finalPath: pathOf(page.url()), jsessionBefore: before, jsessionAfter: after, egressIp: await egressIp() },
    });
    return loggedIn ? "connecté — la session sera réutilisée sans nouvelle connexion" : "échec : FBI a renvoyé le formulaire de connexion (identifiants ?)";
  } finally {
    busy = false;
  }
}

async function main(): Promise<void> {
  // Socket de commande, journal et profil lisibles par ce seul utilisateur.
  process.umask(0o077);
  await mkdir(dirname(config.logFile), { recursive: true });
  await mkdir(config.profileDir, { recursive: true });
  await mkdir(dirname(config.socketPath), { recursive: true });

  const identity = fbiBrowserIdentity(chromeMajorVersion());
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: true,
    ...(config.chromiumPath ? { executablePath: config.chromiumPath } : {}),
    args: ["--disable-blink-features=AutomationControlled"],
    ...identity,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  await record({
    kind: "worker_started",
    outcome: "ok",
    detail: { browser: chromeMajorVersion(), profileDir: config.profileDir, tickMinutes: config.tickMinutes, search: !!(config.searchSeasonId && config.searchMatchNumber), egressIp: await egressIp() },
  });

  // Un cookie de session ne survit pas au redémarrage du navigateur : on vérifie quand même (preuve, pas supposition).
  const startupVerdict = await checkSession(page, context, "session_check_startup");
  if (startupVerdict === "authenticated") {
    state = "authenticated";
    authenticatedSince = new Date().toISOString();
  }

  const timer = setInterval(() => void tick(page, context, "planifié"), config.tickMinutes * 60_000);

  await rm(config.socketPath, { force: true });
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      const line = buffer.slice(0, buffer.indexOf("\n"));
      buffer = "";
      let reply: unknown;
      try {
        const request = JSON.parse(line) as { cmd: string; username?: string; password?: string };
        if (request.cmd === "status") reply = { state, authenticatedSince, busy, lastEvent };
        else if (request.cmd === "tick") {
          await tick(page, context, "manuel");
          reply = { state, lastEvent };
        } else if (request.cmd === "login" && request.username && request.password) {
          reply = { message: await login(page, context, { username: request.username, password: request.password }), state };
        } else reply = { error: "commande inconnue" };
      } catch (error) {
        reply = { error: error instanceof Error ? error.message : String(error) };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  server.listen(config.socketPath);

  const shutdown = async () => {
    clearInterval(timer);
    server.close();
    await record({ kind: "worker_stopped", outcome: "ok" });
    await context.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch(async (error: unknown) => {
  await record({ kind: "worker_crashed", outcome: "erreur", detail: { error: error instanceof Error ? error.message.split("\n")[0] : String(error) } });
  process.exit(1);
});
