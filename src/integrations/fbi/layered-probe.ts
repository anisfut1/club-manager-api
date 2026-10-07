import { lookup } from "node:dns/promises";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * Diagnostic FBI couche par couche (2026-10-07) : DNS, ouverture TCP, TLS,
 * réponse HTTP — chaque étape mesurée et classée séparément, pour qu'une
 * panne soit attribuée à UNE couche d'après la trace, jamais supposée.
 *
 * Volontairement SANS cookie ni identifiant : une requête anonyme (page de
 * connexion par défaut). L'état d'une session (JSESSIONID) se vérifie dans
 * le navigateur qui la détient, jamais en la rejouant d'ailleurs.
 *
 * Non utilisé par le pipeline de production : outil du worker de test
 * (ops/fbi-session-worker) et de la commande `npm run fbi:probe`.
 */

export type ProbeClassification =
  | "ok"
  | "redirect_to_login"
  | "dns_failure"
  | "tcp_timeout"
  | "tcp_reset"
  | "tcp_refused"
  | "tcp_unreachable"
  | "tcp_error"
  | "tls_timeout"
  | "tls_reset"
  | "tls_error"
  | "http_timeout"
  | "http_reset"
  | "http_closed_without_response"
  | "http_unparseable"
  | "http_403"
  | "http_429"
  | "http_5xx"
  | "http_4xx";

export interface StageResult {
  ok: boolean;
  elapsedMs: number;
  /** Code système (ETIMEDOUT, ECONNRESET, ENOTFOUND…) ou cause courte. */
  error: string | null;
}

export interface LayeredProbeResult {
  startedAt: string;
  host: string;
  path: string;
  classification: ProbeClassification;
  /** Première couche en échec (`null` si tout a répondu). */
  failedLayer: "dns" | "tcp" | "tls" | "http" | null;
  dns: StageResult & { addresses: string[] };
  tcp: (StageResult & { address: string | null; localPort: number | null }) | null;
  tls:
    | (StageResult & {
        protocol: string | null;
        cipher: string | null;
        certSubject: string | null;
        /** Émetteur + empreinte : un équipement intermédiaire qui intercepte TLS se voit ici (émetteur inattendu). */
        certIssuer: string | null;
        certFingerprint256: string | null;
        certValidTo: string | null;
      })
    | null;
  http:
    | (StageResult & {
        status: number | null;
        location: string | null;
        setCookieNames: string[];
        server: string | null;
        /** Octets reçus avant la fin des en-têtes (détection d'une réponse tronquée). */
        headBytes: number;
      })
    | null;
}

export interface LayeredProbeOptions {
  host?: string;
  port?: number;
  path?: string;
  /** `false` pour les tests locaux (HTTP en clair). */
  useTls?: boolean;
  dnsTimeoutMs?: number;
  tcpTimeoutMs?: number;
  tlsTimeoutMs?: number;
  httpTimeoutMs?: number;
  userAgent?: string;
}

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Pages vers lesquelles FBI renvoie une session absente ou expirée. */
const LOGIN_PATH_PATTERN = /\/(identification|connexion)\.(fbi|do)\b/i;

export function isFbiLoginUrl(url: string | null | undefined): boolean {
  return !!url && LOGIN_PATH_PATTERN.test(url);
}

function errorCode(error: unknown): string {
  const err = error as NodeJS.ErrnoException | undefined;
  return err?.code ?? (err?.message ? err.message.split("\n")[0].slice(0, 120) : String(error).slice(0, 120));
}

function classifyTcpError(code: string): ProbeClassification {
  if (code === "ETIMEDOUT") return "tcp_timeout";
  if (code === "ECONNRESET") return "tcp_reset";
  if (code === "ECONNREFUSED") return "tcp_refused";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "tcp_unreachable";
  return "tcp_error";
}

export function classifyHttpStatus(status: number, location: string | null): ProbeClassification {
  if (status >= 300 && status < 400 && isFbiLoginUrl(location)) return "redirect_to_login";
  if (status === 403) return "http_403";
  if (status === 429) return "http_429";
  if (status >= 500) return "http_5xx";
  if (status >= 400) return "http_4xx";
  return "ok";
}

/**
 * Erreur réseau Chromium (`net::ERR_…`, message d'un `page.goto`/`fetch`
 * Playwright) → même classement que la sonde Node. `null` si le message
 * n'est pas une erreur réseau Chromium reconnue.
 */
export function classifyChromiumNetError(message: string): ProbeClassification | null {
  const code = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  if (!code) return null;
  if (code === "ERR_NAME_NOT_RESOLVED" || code === "ERR_NAME_RESOLUTION_FAILED") return "dns_failure";
  if (code === "ERR_CONNECTION_TIMED_OUT") return "tcp_timeout";
  if (code === "ERR_CONNECTION_REFUSED") return "tcp_refused";
  if (code === "ERR_ADDRESS_UNREACHABLE" || code === "ERR_NETWORK_UNREACHABLE") return "tcp_unreachable";
  if (code === "ERR_CONNECTION_RESET") return "tcp_reset";
  if (code.startsWith("ERR_SSL_") || code.startsWith("ERR_CERT_")) return "tls_error";
  if (code === "ERR_TIMED_OUT") return "http_timeout";
  if (code === "ERR_EMPTY_RESPONSE" || code === "ERR_CONNECTION_CLOSED") return "http_closed_without_response";
  if (code === "ERR_INVALID_RESPONSE" || code === "ERR_INVALID_HTTP_RESPONSE") return "http_unparseable";
  return "tcp_error";
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(Object.assign(new Error(`délai dépassé (${ms} ms)`), { code: "ETIMEDOUT" }));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseHead(head: string): { status: number | null; headers: Array<[string, string]> } {
  const lines = head.split("\r\n");
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0] ?? "")?.[1];
  const headers: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) headers.push([line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()]);
  }
  return { status: status ? Number(status) : null, headers };
}

export async function probeFbiLayers(options: LayeredProbeOptions = {}): Promise<LayeredProbeResult> {
  const host = options.host ?? "extranet.ffbb.com";
  const port = options.port ?? 443;
  const path = options.path ?? "/fbi/connexion.fbi";
  const useTls = options.useTls ?? true;
  const result: LayeredProbeResult = {
    startedAt: new Date().toISOString(),
    host,
    path,
    classification: "ok",
    failedLayer: null,
    dns: { ok: false, elapsedMs: 0, error: null, addresses: [] },
    tcp: null,
    tls: null,
    http: null,
  };

  // 1. DNS
  let started = Date.now();
  try {
    const addresses = await withTimeout(lookup(host, { all: true }), options.dnsTimeoutMs ?? 5_000, () => undefined);
    result.dns = { ok: addresses.length > 0, elapsedMs: Date.now() - started, error: addresses.length > 0 ? null : "aucune adresse", addresses: addresses.map((a) => a.address) };
  } catch (error) {
    result.dns = { ok: false, elapsedMs: Date.now() - started, error: errorCode(error), addresses: [] };
  }
  if (!result.dns.ok) return { ...result, classification: "dns_failure", failedLayer: "dns" };
  const address = result.dns.addresses.find((a) => !a.includes(":")) ?? result.dns.addresses[0];

  // 2. TCP
  started = Date.now();
  let socket: Socket;
  try {
    socket = await withTimeout(
      new Promise<Socket>((resolve, reject) => {
        const s = netConnect({ host: address, port });
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      }),
      options.tcpTimeoutMs ?? 10_000,
      () => undefined,
    );
    result.tcp = { ok: true, elapsedMs: Date.now() - started, error: null, address, localPort: socket.localPort ?? null };
  } catch (error) {
    const code = errorCode(error);
    result.tcp = { ok: false, elapsedMs: Date.now() - started, error: code, address, localPort: null };
    return { ...result, classification: classifyTcpError(code), failedLayer: "tcp" };
  }

  // 3. TLS
  let stream: Socket | TLSSocket = socket;
  if (useTls) {
    started = Date.now();
    try {
      const tls = await withTimeout(
        new Promise<TLSSocket>((resolve, reject) => {
          const t = tlsConnect({ socket, servername: host });
          t.once("secureConnect", () => resolve(t));
          t.once("error", reject);
          socket.once("close", () => reject(Object.assign(new Error("connexion fermée pendant TLS"), { code: "ECONNRESET" })));
        }),
        options.tlsTimeoutMs ?? 10_000,
        () => socket.destroy(),
      );
      const cert = tls.getPeerCertificate();
      result.tls = {
        ok: true,
        elapsedMs: Date.now() - started,
        error: null,
        protocol: tls.getProtocol() ?? null,
        cipher: tls.getCipher()?.name ?? null,
        certSubject: typeof cert?.subject?.CN === "string" ? cert.subject.CN : null,
        certIssuer: [cert?.issuer?.O, cert?.issuer?.CN].filter((v) => typeof v === "string").join(" / ") || null,
        certFingerprint256: cert?.fingerprint256 ?? null,
        certValidTo: cert?.valid_to ?? null,
      };
      stream = tls;
    } catch (error) {
      socket.destroy();
      const code = errorCode(error);
      result.tls = { ok: false, elapsedMs: Date.now() - started, error: code, protocol: null, cipher: null, certSubject: null, certIssuer: null, certFingerprint256: null, certValidTo: null };
      return { ...result, classification: code === "ETIMEDOUT" ? "tls_timeout" : code === "ECONNRESET" ? "tls_reset" : "tls_error", failedLayer: "tls" };
    }
  }

  // 4. HTTP (en-têtes seulement, puis fermeture)
  started = Date.now();
  const request = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${options.userAgent ?? DEFAULT_USER_AGENT}\r\nAccept: text/html\r\nAccept-Language: fr-FR,fr;q=0.9\r\nConnection: close\r\n\r\n`;
  try {
    const head = await withTimeout(
      new Promise<string>((resolve, reject) => {
        let buffer = "";
        stream.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("latin1");
          const end = buffer.indexOf("\r\n\r\n");
          if (end >= 0) resolve(buffer.slice(0, end));
        });
        stream.once("error", reject);
        stream.once("end", () => (buffer ? resolve(buffer) : reject(Object.assign(new Error("fermée sans réponse"), { code: "EMPTY_RESPONSE" }))));
        stream.write(request);
      }),
      options.httpTimeoutMs ?? 20_000,
      () => stream.destroy(),
    );
    stream.destroy();
    const { status, headers } = parseHead(head);
    const header = (name: string) => headers.find(([key]) => key === name)?.[1] ?? null;
    const setCookieNames = headers.filter(([key]) => key === "set-cookie").map(([, value]) => value.split("=")[0].trim());
    const location = header("location");
    result.http = { ok: status !== null, elapsedMs: Date.now() - started, error: status === null ? "en-tête illisible" : null, status, location, setCookieNames, server: header("server"), headBytes: head.length };
    if (status === null) return { ...result, classification: "http_unparseable", failedLayer: "http" };
    const classification = classifyHttpStatus(status, location);
    return { ...result, classification, failedLayer: classification === "ok" || classification === "redirect_to_login" ? null : "http" };
  } catch (error) {
    stream.destroy();
    const code = errorCode(error);
    result.http = { ok: false, elapsedMs: Date.now() - started, error: code, status: null, location: null, setCookieNames: [], server: null, headBytes: 0 };
    const classification: ProbeClassification = code === "ETIMEDOUT" ? "http_timeout" : code === "ECONNRESET" ? "http_reset" : code === "EMPTY_RESPONSE" ? "http_closed_without_response" : "http_unparseable";
    return { ...result, classification, failedLayer: "http" };
  }
}
