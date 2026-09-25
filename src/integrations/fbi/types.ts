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
 * Une ligne du tableau de résultats de `rechercherRencontreSaisieResultat.fbi`
 * (rapprochement calendrier FFBB/FBI, voir docs/FBI.md) — colonnes confirmées
 * en production le 2026-09-24 : Division | N° | Equipe 1 | Equipe 2 | Date de
 * rencontre | Heure | Salle | EM | Score 1 | Forfait 1 (voir
 * `selectors.ts#resultsTableColumns`, déjà utilisé par la découverte de
 * documents e-Marque). Les champs connus sont extraits par LIBELLÉ d'en-tête
 * (jamais une position fixe) ; `raw` conserve TOUTES les colonnes trouvées
 * sur la page, y compris celles non modélisées ici — jamais perdu si FBI
 * ajoute/renomme une colonne.
 */
export interface FbiScheduleRow {
  division: string | null;
  numero: string | null;
  equipe1: string | null;
  equipe2: string | null;
  dateRencontre: string | null;
  heure: string | null;
  salle: string | null;
  em: string | null;
  score1: string | null;
  forfait1: string | null;
  raw: Record<string, string>;
}

/**
 * Une ligne du tableau de résultats de `rechercherDerogation.fbi` (gestion
 * des dérogations, voir docs/FBI.md — demande du club, 2026-09-25 : "faut
 * qu'on gere les derog depuis l'outil") — colonnes confirmées par capture
 * d'écran du VRAI FBI le 2026-09-25 : Date de dépôt | N° Renc | Division |
 * Domicile | Visiteur | Date rencontre | Heure | Date déro | Etat de la
 * dérogation. `raw` conserve toutes les colonnes trouvées, y compris non
 * modélisées.
 */
export interface FbiDerogationRow {
  numero: string | null;
  division: string | null;
  domicile: string | null;
  visiteur: string | null;
  dateRencontre: string | null;
  heure: string | null;
  dateDepot: string | null;
  dateDerogation: string | null;
  etat: string | null;
  raw: Record<string, string>;
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
  /**
   * Récupère TOUTES les rencontres du club listées par FBI (calendrier
   * complet, toutes divisions confondues — voir `rechercherRencontreSaisieResultat.fbi`,
   * rapprochement calendrier FFBB/FBI, docs/FBI.md), pas une seule rencontre
   * ciblée comme `findEmarqueDocuments`. Gère elle-même la pagination
   * ("Précédent 1 2 3 … Suivant", confirmé en production le 2026-09-25).
   */
  fetchScheduleRows(session: TSession): Promise<FbiScheduleRow[]>;
  /**
   * Consulte l'état de la dérogation d'UN match précis, par numéro de
   * rencontre (voir `rechercherDerogation.fbi`) — "faudra utiliser la
   * recherche par numéro de rencontre, car on l'a déjà et c'est bcp +
   * simple" (demande du club). `null` quand aucune dérogation n'existe
   * pour ce match — jamais une erreur (cas normal, la majorité des
   * matchs n'ont aucune dérogation en cours).
   */
  fetchDerogationForMatch(session: TSession, matchNumber: string): Promise<FbiDerogationRow | null>;
}
