import { createHash } from "node:crypto";

/**
 * Limiteur de débit en mémoire, par instance (fenêtre fixe). Suffisant
 * contre les rafales d'un même visiteur ; pas un plafond global entre
 * instances Vercel (voir docs : constat A-6). Les clés sont hachées : aucune
 * IP ni adresse n'est conservée en clair.
 */
const buckets = new Map<string, { start: number; count: number }>();

export function hitRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const id = createHash("sha256").update(key).digest("base64url");
  const bucket = buckets.get(id);
  if (!bucket || now - bucket.start >= windowMs) {
    buckets.set(id, { start: now, count: 1 });
    if (buckets.size > 10_000) for (const [k, b] of buckets) if (now - b.start >= windowMs) buckets.delete(k);
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

/** Pour les tests. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** IP du visiteur derrière le proxy Vercel (premier élément de x-forwarded-for). */
export function clientIp(header: string | undefined): string {
  return header?.split(",")[0]?.trim() || "unknown";
}
