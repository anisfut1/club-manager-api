/**
 * Cookie jar minimal, suffisant pour une session FBI (voir
 * docs/FBI_AUTHENTICATED_SPIKE.md : application Java classique, cookie de
 * session type JSESSIONID). Ne vise pas la conformité RFC 6265 complète
 * (domaines/paths/expiration multiples) — un seul hôte, une seule session,
 * pas besoin de plus.
 */
export class SimpleCookieJar {
  private readonly cookies = new Map<string, string>();

  /** Lit les en-têtes Set-Cookie d'une réponse et met à jour le jar. */
  applySetCookieHeaders(headers: Headers): void {
    const setCookieHeaders = this.extractSetCookieHeaders(headers);

    for (const raw of setCookieHeaders) {
      const firstPair = raw.split(";")[0];
      if (!firstPair) continue;

      const separatorIndex = firstPair.indexOf("=");
      if (separatorIndex === -1) continue;

      const name = firstPair.slice(0, separatorIndex).trim();
      const value = firstPair.slice(separatorIndex + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  private extractSetCookieHeaders(headers: Headers): string[] {
    // `getSetCookie()` (Node >= 18.14 / undici) renvoie chaque cookie
    // séparément ; à défaut, on retombe sur un seul en-tête combiné.
    if (typeof headers.getSetCookie === "function") {
      return headers.getSetCookie();
    }

    const single = headers.get("set-cookie");
    return single ? [single] : [];
  }

  get cookieHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get size(): number {
    return this.cookies.size;
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }
}
