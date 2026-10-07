import type { BrowserFbiClient, BrowserFbiSession } from "../integrations/fbi/browser-client.js";

/**
 * Session FBI déjà ouverte et gardée par l'appelant (worker FBI local,
 * ops/fbi-local-worker, 2026-10-07). Passée à un traitement de job, elle
 * remplace son propre lancement de navigateur, sa connexion et sa
 * déconnexion — jamais fournie par Vercel (comportement inchangé).
 */
export interface SharedFbiSession {
  client: BrowserFbiClient;
  session: BrowserFbiSession;
}
