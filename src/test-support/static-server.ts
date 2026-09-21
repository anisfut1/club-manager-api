import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";

/**
 * Petit serveur HTTP local servant des pages HTML/fichiers synthétiques
 * pour tester `BrowserFbiClient` SANS jamais toucher le vrai FBI (§54 du
 * brief FBI). Les routes sont déclarées par le test appelant (voir
 * fixtures ci-dessous) — ce serveur ne connaît rien de FBI lui-même.
 */
export interface StaticRoute {
  method?: "GET" | "POST";
  path: string;
  contentType: string;
  body: string | Buffer;
}

export class TestServer {
  private server: Server | null = null;
  private routes = new Map<string, StaticRoute>();
  baseUrl = "";

  setRoute(route: StaticRoute): void {
    this.routes.set(`${route.method ?? "GET"} ${route.path}`, route);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const key = `${req.method} ${url.pathname}`;
      const route = this.routes.get(key);

      if (!route) {
        res.writeHead(404).end("not found");
        return;
      }

      res.writeHead(200, { "content-type": route.contentType });
      res.end(route.body);
    });

    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address && typeof address === "object") {
      this.baseUrl = `http://127.0.0.1:${address.port}`;
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server?.close((err) => (err ? reject(err) : resolve())) ?? resolve());
  }
}

export function readFixture(path: string): string {
  return readFileSync(path, "utf8");
}
