import { connect as netConnect } from "node:net";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { DbClient } from "../../db/client.js";
import { decryptSecret, encryptSecret } from "../../security/crypto.js";
import { logError } from "../../logger.js";
import type { FbiSessionTrace } from "./browser-client.js";
import type { FbiProxySettings } from "./browser-launcher.js";

/**
 * Diagnostic et ménagement de l'accès FBI (2026-10-06) : FBI coupe par
 * moments l'adresse utilisée (Vercel, puis le VPS du proxy). Trois outils,
 * tables service_role uniquement (migration 20261006180000) :
 * - `checkFbiReachability` : UNE requête légère (page de connexion, sans
 *   s'identifier) avant chaque passage — FBI injoignable = passage sauté,
 *   jamais de navigateur ni de connexion qui prolongeraient la coupure ;
 * - `saveFbiSessionTrace` : chaque requête d'une session navigateur ;
 * - `loadFbiSavedSession`/`saveFbiSavedSession` : session reprise d'un passage
 *   à l'autre (une connexion par jour au lieu d'une par passage).
 */

const FBI_HOST = "extranet.ffbb.com";
const PROBE_PATH = "/fbi/connexion.fbi";
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/** Au-delà, la session conservée n'est plus tentée (FBI l'a forcément expirée). */
const SAVED_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface FbiReachability {
  via: "proxy" | "direct";
  ok: boolean;
  httpStatus: number | null;
  elapsedMs: number;
  error: string | null;
}

/** 2xx/3xx seulement : un 403/429 de FBI est un refus (blocage), pas une réponse exploitable. */
function isReachableStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 400;
}

function statusFromHead(head: string): number | null {
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head);
  return match ? Number(match[1]) : null;
}

/** GET de la page de connexion FBI, à travers le proxy s'il y en a un — jamais d'identifiant. */
export function checkFbiReachability(proxy: FbiProxySettings | undefined): Promise<FbiReachability> {
  const startedAt = Date.now();
  const via = proxy ? "proxy" : "direct";
  const result = (ok: boolean, httpStatus: number | null, error: string | null): FbiReachability => ({ via, ok, httpStatus, elapsedMs: Date.now() - startedAt, error });
  const getRequest = `GET ${PROBE_PATH} HTTP/1.1\r\nHost: ${FBI_HOST}\r\nUser-Agent: ${PROBE_USER_AGENT}\r\nAccept: text/html\r\nAccept-Language: fr-FR,fr;q=0.9\r\nConnection: close\r\n\r\n`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: FbiReachability) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(result(false, null, `délai dépassé (${PROBE_TIMEOUT_MS} ms)`)), PROBE_TIMEOUT_MS);

    if (!proxy) {
      const req = httpsRequest({ host: FBI_HOST, path: PROBE_PATH, method: "GET", headers: { "user-agent": PROBE_USER_AGENT, "accept-language": "fr-FR,fr;q=0.9" } }, (res) => {
        res.resume();
        finish(result(isReachableStatus(res.statusCode ?? null), res.statusCode ?? null, null));
      });
      req.on("error", (error: NodeJS.ErrnoException) => finish(result(false, null, error.code ?? error.message)));
      req.end();
      return;
    }

    const proxyUrl = new URL(proxy.server);
    const socket = netConnect({ host: proxyUrl.hostname, port: Number(proxyUrl.port || 80) });
    socket.on("error", (error: NodeJS.ErrnoException) => finish(result(false, null, `proxy : ${error.code ?? error.message}`)));
    socket.on("connect", () => {
      const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64")}\r\n` : "";
      socket.write(`CONNECT ${FBI_HOST}:443 HTTP/1.1\r\nHost: ${FBI_HOST}:443\r\n${auth}\r\n`);
    });
    socket.once("data", (chunk: Buffer) => {
      const connectStatus = statusFromHead(chunk.toString("latin1"));
      if (connectStatus !== 200) {
        socket.destroy();
        finish(result(false, null, `proxy : CONNECT ${connectStatus ?? "réponse illisible"}`));
        return;
      }
      const tls = tlsConnect({ socket, servername: FBI_HOST });
      tls.on("error", (error: NodeJS.ErrnoException) => finish(result(false, null, `TLS : ${error.code ?? error.message}`)));
      tls.on("secureConnect", () => tls.write(getRequest));
      tls.once("data", (data: Buffer) => {
        const status = statusFromHead(data.toString("latin1"));
        tls.destroy();
        finish(result(isReachableStatus(status), status, status === null ? "réponse illisible" : null));
      });
    });
  });
}

/**
 * Adresse IP publique de sortie de cette fonction (2026-10-07) — pour
 * vérifier si FBI coupe une ADRESSE (réutilisée d'un passage à l'autre) ou
 * autre chose. Jamais bloquant : `null` si le service ne répond pas.
 */
export async function fetchEgressIp(): Promise<string | null> {
  try {
    const response = await fetch("https://checkip.amazonaws.com/", { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const ip = (await response.text()).trim();
    return /^[0-9a-f.:]{3,45}$/i.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

export async function recordFbiReachability(supabase: DbClient, check: FbiReachability): Promise<void> {
  const { error } = await supabase.from("fbi_reachability_checks").insert({
    egress_ip: check.via === "direct" ? await fetchEgressIp() : null,
    via: check.via,
    ok: check.ok,
    http_status: check.httpStatus,
    elapsed_ms: check.elapsedMs,
    error: check.error,
  });
  if (error) logError("Enregistrement de la joignabilité FBI échoué", error);
}

export async function saveFbiSessionTrace(
  supabase: DbClient,
  input: { clubId: string; trace: FbiSessionTrace | null; via: "proxy" | "direct"; outcome: string },
): Promise<void> {
  if (!input.trace) return;
  const events = input.trace.events;
  const failed = events.filter((event) => typeof event.s === "string" && event.s !== "ignoré").length;
  const { error } = await supabase.from("fbi_session_traces").insert({
    club_id: input.clubId,
    started_at: input.trace.startedAt,
    via: input.via,
    outcome: input.outcome.slice(0, 2000),
    request_count: events.length + input.trace.dropped,
    failed_count: failed,
    events,
    fingerprint: { ...(input.trace.fingerprint ?? {}), egressIp: input.via === "direct" ? await fetchEgressIp() : null },
  });
  if (error) logError("Enregistrement de la trace de session FBI échoué", error, { clubId: input.clubId });
}

/** Session FBI conservée pour ce club (cookies déchiffrés), ou `null`. */
export async function loadFbiSavedSession(supabase: DbClient, clubId: string): Promise<string | null> {
  const { data } = await supabase.from("fbi_saved_sessions").select("state_ciphertext, state_iv, state_auth_tag, updated_at").eq("club_id", clubId).maybeSingle();
  if (!data || Date.now() - new Date(data.updated_at).getTime() > SAVED_SESSION_MAX_AGE_MS) return null;
  try {
    return decryptSecret({ ciphertext: data.state_ciphertext, iv: data.state_iv, authTag: data.state_auth_tag }, clubId);
  } catch {
    return null;
  }
}

export async function saveFbiSavedSession(supabase: DbClient, clubId: string, state: string | null): Promise<void> {
  if (!state) {
    await supabase.from("fbi_saved_sessions").delete().eq("club_id", clubId);
    return;
  }
  const encrypted = encryptSecret(state, clubId);
  const now = new Date().toISOString();
  const { error } = await supabase.from("fbi_saved_sessions").upsert(
    { club_id: clubId, state_ciphertext: encrypted.ciphertext, state_iv: encrypted.iv, state_auth_tag: encrypted.authTag, updated_at: now },
    { onConflict: "club_id" },
  );
  if (error) logError("Enregistrement de la session FBI échoué", error, { clubId });
}

/**
 * Interrupteur général (2026-10-06) : `platform_settings.fbi_paused_until`
 * (date ISO). Avant cette date, aucune connexion automatique à FBI (cron et
 * bouton « traiter les jobs ») — pour laisser retomber une protection FBI
 * qui coupe l'adresse dès la connexion.
 */
export async function fbiPausedUntil(supabase: DbClient): Promise<Date | null> {
  try {
    const { data } = await supabase.from("platform_settings").select("value").eq("key", "fbi_paused_until").maybeSingle();
    const until = data?.value ? new Date(data.value) : null;
    return until && !Number.isNaN(until.getTime()) && until.getTime() > Date.now() ? until : null;
  } catch {
    // Réglage illisible : pas de pause (comportement normal).
    return null;
  }
}

/**
 * Identifiant FBI de la saison (2026-10-07), mis en cache dans
 * `platform_settings` (`fbi_season_id:<libellé>`) : il ne change pas de la
 * saison, et le relire sur l'écran de recherche coûte ≈ 1,7 s dans la courte
 * fenêtre que FBI laisse après la connexion. Jamais bloquant : illisible =
 * pas de cache (la saison est relue sur FBI).
 */
function seasonIdKey(seasonLabel: string): string {
  return `fbi_season_id:${seasonLabel}`;
}

export async function loadFbiSeasonId(supabase: DbClient, seasonLabel: string | null): Promise<string | null> {
  if (!seasonLabel) return null;
  try {
    const { data } = await supabase.from("platform_settings").select("value").eq("key", seasonIdKey(seasonLabel)).maybeSingle();
    return data?.value ? data.value : null;
  } catch {
    return null;
  }
}

/** `value` vide = cache invalidé (identifiant à relire sur FBI au prochain passage). */
export async function saveFbiSeasonId(supabase: DbClient, seasonLabel: string, value: string): Promise<void> {
  try {
    const { error } = await supabase.from("platform_settings").upsert({ key: seasonIdKey(seasonLabel), value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) logError("Enregistrement de l'identifiant de saison FBI échoué", error, { seasonLabel });
  } catch (error) {
    logError("Enregistrement de l'identifiant de saison FBI échoué", error, { seasonLabel });
  }
}

/**
 * Écart minimal entre deux connexions FBI avec identifiants (2026-10-07).
 * Constat (`fbi_jobs`, `fbi_session_traces`) : jusqu'au 30/09, une connexion
 * toutes les ~20 min, jamais coupée. Depuis le 02/10, la file est traitée en
 * boucle (plusieurs connexions en 1-2 min) et les connexions rapprochées sont
 * coupées — même depuis une adresse IP différente (07/10 07:46 réussie depuis
 * 13.221.x, 07:47 coupée 3 s après la connexion depuis 44.192.x).
 */
export const FBI_MIN_LOGIN_GAP_MS = 12 * 60 * 1000;

/** Date de la dernière connexion FBI si elle date de moins de `FBI_MIN_LOGIN_GAP_MS`, sinon `null`. */
export async function recentFbiCredentialLogin(supabase: DbClient, clubId: string | null = null): Promise<Date | null> {
  try {
    let query = supabase.from("fbi_integration_status").select("last_credential_login_at").not("last_credential_login_at", "is", null);
    if (clubId) query = query.eq("club_id", clubId);
    const { data } = await query.order("last_credential_login_at", { ascending: false }).limit(1);
    const last = data?.[0]?.last_credential_login_at ? new Date(data[0].last_credential_login_at) : null;
    return last && Date.now() - last.getTime() < FBI_MIN_LOGIN_GAP_MS ? last : null;
  } catch {
    // Illisible : pas de blocage (comportement normal).
    return null;
  }
}
