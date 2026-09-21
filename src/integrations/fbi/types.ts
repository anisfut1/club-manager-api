/**
 * Types partagés entre les identifiants FBI stockés (credentials-store.ts)
 * et les clients d'automatisation (http-client.ts). Un seul endroit pour
 * cette forme évite deux définitions structurellement identiques qui
 * divergeraient sans qu'aucune erreur de type ne le signale.
 */
export interface FbiCredentialsInput {
  username: string;
  password: string;
}

/** Référence à un document e-Marque découvert chez FBI, pas encore téléchargé. */
export interface EmarqueDocumentRef {
  url: string;
  fileName: string;
}

/**
 * Contrat commun à `HttpFbiClient` (ce dossier, HTTP direct — cookie jar,
 * pas de navigateur) et `BrowserFbiClient` (./browser-client.ts, Playwright).
 * Le reste de l'application (jobs, actions serveur) programme contre cette
 * interface : il ne sait jamais laquelle des deux implémentations est
 * réellement active (§ "Architecture" du brief FBI).
 *
 * `TSession` est opaque pour l'appelant — chaque implémentation choisit sa
 * propre forme (cookie jar pour HTTP, contexte navigateur pour Playwright).
 */
export interface FbiAutomationClient<TSession> {
  login(credentials: FbiCredentialsInput): Promise<TSession>;
  isSessionValid(session: TSession): Promise<boolean>;
  findEmarqueDocuments(session: TSession, matchNumber: string): Promise<EmarqueDocumentRef[]>;
  downloadDocument(session: TSession, url: string): Promise<Buffer>;
}
