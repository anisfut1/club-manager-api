import { randomBytes, createHash } from "node:crypto";

/**
 * Jeton personnel sans compte (retour du club, 2026-09-29). Haute entropie
 * (32 octets aléatoires), jamais un identifiant devinable — c'est LA seule
 * preuve d'identité de ce flux, il doit résister au brute-force.
 */
export function generatePublicToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Jamais le jeton en clair en base (voir migration) — seul le hash est comparé/stocké. */
export function hashPublicToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
