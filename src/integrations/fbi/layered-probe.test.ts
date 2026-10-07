import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { classifyChromiumNetError, classifyHttpStatus, isFbiLoginUrl, probeFbiLayers } from "./layered-probe.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

function listen(onConnection: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      sockets.push(socket);
      onConnection(socket);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function respond(head: string) {
  return (socket: Socket) => socket.once("data", () => socket.end(`${head}\r\n\r\n`));
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const local = (port: number) => ({ host: "localhost", port, useTls: false, httpTimeoutMs: 500, tcpTimeoutMs: 500 });

describe("probeFbiLayers — chaque couche classée séparément", () => {
  it("réponse 200 : ok, aucune couche en échec, noms de cookies relevés (jamais leur valeur)", async () => {
    const port = await listen(respond("HTTP/1.1 200 OK\r\nServer: Apache\r\nSet-Cookie: JSESSIONID=secret; Path=/fbi"));
    const result = await probeFbiLayers(local(port));
    expect(result.classification).toBe("ok");
    expect(result.failedLayer).toBeNull();
    expect(result.dns.ok && result.tcp?.ok && result.http?.status === 200).toBe(true);
    expect(result.http?.setCookieNames).toEqual(["JSESSIONID"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("302 vers identification.fbi : redirect_to_login (pas une panne réseau)", async () => {
    const port = await listen(respond("HTTP/1.1 302 Found\r\nLocation: https://extranet.ffbb.com/fbi/identification.fbi"));
    const result = await probeFbiLayers(local(port));
    expect(result.classification).toBe("redirect_to_login");
    expect(result.failedLayer).toBeNull();
  });

  it.each([
    ["HTTP/1.1 403 Forbidden", "http_403"],
    ["HTTP/1.1 429 Too Many Requests", "http_429"],
    ["HTTP/1.1 503 Service Unavailable", "http_5xx"],
    ["HTTP/1.1 404 Not Found", "http_4xx"],
  ])("%s → %s, couche http", async (head, expected) => {
    const port = await listen(respond(head));
    const result = await probeFbiLayers(local(port));
    expect(result.classification).toBe(expected);
    expect(result.failedLayer).toBe("http");
  });

  it("connexion acceptée puis coupée par le serveur : http_reset ou fermeture sans réponse", async () => {
    const port = await listen((socket) => socket.once("data", () => socket.resetAndDestroy()));
    const result = await probeFbiLayers(local(port));
    expect(["http_reset", "http_closed_without_response"]).toContain(result.classification);
    expect(result.tcp?.ok).toBe(true);
    expect(result.failedLayer).toBe("http");
  });

  it("connexion acceptée mais aucune réponse : http_timeout (TCP ouvert, donc pas un blocage réseau)", async () => {
    const port = await listen(() => undefined);
    const result = await probeFbiLayers(local(port));
    expect(result.classification).toBe("http_timeout");
    expect(result.tcp?.ok).toBe(true);
  });

  it("port fermé : tcp_refused", async () => {
    const port = await listen(() => undefined);
    await new Promise((resolve) => servers.pop()!.close(resolve));
    const result = await probeFbiLayers(local(port));
    expect(result.classification).toBe("tcp_refused");
    expect(result.failedLayer).toBe("tcp");
  });

  it("nom introuvable : dns_failure, aucune tentative TCP", async () => {
    const result = await probeFbiLayers({ host: "fbi-probe-test.invalid", useTls: false, dnsTimeoutMs: 2_000 });
    expect(result.classification).toBe("dns_failure");
    expect(result.tcp).toBeNull();
  });
});

describe("classements", () => {
  it("statuts HTTP", () => {
    expect(classifyHttpStatus(302, "/fbi/connexion.fbi")).toBe("redirect_to_login");
    expect(classifyHttpStatus(302, "/fbi/accueil.fbi")).toBe("ok");
    expect(classifyHttpStatus(200, null)).toBe("ok");
  });

  it("erreurs réseau Chromium", () => {
    expect(classifyChromiumNetError("page.goto: net::ERR_CONNECTION_TIMED_OUT at https://x")).toBe("tcp_timeout");
    expect(classifyChromiumNetError("net::ERR_CONNECTION_RESET")).toBe("tcp_reset");
    expect(classifyChromiumNetError("net::ERR_NAME_NOT_RESOLVED")).toBe("dns_failure");
    expect(classifyChromiumNetError("net::ERR_SSL_PROTOCOL_ERROR")).toBe("tls_error");
    expect(classifyChromiumNetError("net::ERR_EMPTY_RESPONSE")).toBe("http_closed_without_response");
    expect(classifyChromiumNetError("Timeout 30000ms exceeded")).toBeNull();
  });

  it("pages d'identification FBI", () => {
    expect(isFbiLoginUrl("https://extranet.ffbb.com/fbi/identification.fbi")).toBe(true);
    expect(isFbiLoginUrl("https://extranet.ffbb.com/fbi/connexion.fbi?x=1")).toBe(true);
    expect(isFbiLoginUrl("https://extranet.ffbb.com/fbi/accueil.fbi")).toBe(false);
  });
});
