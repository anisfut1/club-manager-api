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

export async function recordFbiReachability(supabase: DbClient, check: FbiReachability): Promise<void> {
  const { error } = await supabase.from("fbi_reachability_checks").insert({
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
    fingerprint: input.trace.fingerprint,
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
