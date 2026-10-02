/**
 * Recherche e-Marque DIRECTE sur FBI — retour du club, 2026-10-02 (« on peut
 * re-analyser pourquoi j'ai des matchs sans stats chargées ? »). Constaté en
 * production (jobs du 27/09, rencontres n°5, n°6, n°9503) : piloter le
 * formulaire FBI à la souris est instable —
 *  - changer la saison relance en AJAX la liste des divisions
 *    (`rechercherDivisionListe.fbi?action=rechargeListeDivisionSaisieResultats`)
 *    APRÈS notre sélection de division, qui est alors effacée, et la
 *    recherche part sans division ou pas du tout ;
 *  - le clic sur l'icône EM (`<a onclick="telechargerMatch('<jeton>','<id>')">`,
 *    icône CSS 0×0) ne déclenche parfois aucun téléchargement.
 *
 * On rejoue donc EXACTEMENT les deux requêtes que fait le navigateur (même
 * session, mêmes cookies) : `POST ...?action=controleRecherche` puis
 * `GET ...?action=executeRecherche` (DataTables, réponse JSON `aaData`), sans
 * filtre de division (la colonne Division de chaque ligne sert à choisir la
 * bonne rencontre — un numéro n'est PAS unique au club). Le lien EM porte le
 * jeton du téléchargement : `telechargerMatch('<jeton>', …)` →
 * `telechargerFeuilleMatchEmarque.fbi?action=emV2&plugin=true&idRenc=<jeton>`
 * (correspondance observée en production : rencontres n°1481 et n°6/U11).
 * Fonctions pures ici ; l'appel réseau vit dans `BrowserFbiClient`.
 */

const FIELD_PREFIX = "rechercheRencontreSaisieResultatForm.rechercherRencontreSaisieResultatBean.";
const COLUMN_COUNT = 14;

export interface EmarqueSearchCriteria {
  seasonId: string;
  matchNumber: string;
}

/** Corps du `POST ...?action=controleRecherche` (mêmes champs que le formulaire). */
export function searchFormFields(criteria: EmarqueSearchCriteria): Record<string, string> {
  return {
    [`${FIELD_PREFIX}idSaison`]: criteria.seasonId,
    [`${FIELD_PREFIX}idDivision`]: "",
    [`${FIELD_PREFIX}rechercherEquipe2`]: "O",
    [`${FIELD_PREFIX}dateDebutRencontre`]: "",
    [`${FIELD_PREFIX}dateFinRencontre`]: "",
    [`${FIELD_PREFIX}idPoule`]: "",
    [`${FIELD_PREFIX}numeroEquipe`]: "",
    [`${FIELD_PREFIX}numeroRencontre`]: criteria.matchNumber,
  };
}

/** Query string du `GET ...?action=executeRecherche` — format DataTables capturé en production. */
export function executeSearchQuery(criteria: EmarqueSearchCriteria, now = Date.now()): string {
  const params = new URLSearchParams({ action: "executeRecherche", ...searchFormFields(criteria) });
  params.set("sEcho", "1");
  params.set("iColumns", String(COLUMN_COUNT));
  params.set("sColumns", ",".repeat(COLUMN_COUNT - 1));
  params.set("iDisplayStart", "0");
  params.set("iDisplayLength", "100");
  params.set("selected", "[]");
  for (let i = 0; i < COLUMN_COUNT; i += 1) {
    params.set(`mDataProp_${i}`, String(i));
    params.set(`bSortable_${i}`, "true");
  }
  params.set("iSortCol_0", "5");
  params.set("sSortDir_0", "asc");
  params.set("iSortCol_1", "6");
  params.set("sSortDir_1", "asc");
  params.set("iSortingCols", "2");
  params.set("_", String(now));
  return params.toString();
}

export interface EmarqueSearchRow {
  division: string;
  matchNumber: string;
  /** Jeton tel qu'écrit dans `telechargerMatch('<jeton>', …)` — déjà encodé pour une URL. */
  emarqueToken: string | null;
  fbiMatchId: string | null;
  /** `true` si le lien EM est un e-Marque V2 (classe `emarqueV2…`), seul format dont l'URL est confirmée. */
  emarqueV2: boolean;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function divisionOf(cell: string): string {
  const title = /title=['"]([^'"]+)['"]/.exec(cell)?.[1];
  return (title ?? stripHtml(cell)).trim();
}

/** Lit la réponse JSON DataTables. Lève si la forme n'est pas celle attendue (l'appelant retombe alors sur le parcours à la souris). */
export function parseSearchResponse(body: string): EmarqueSearchRow[] {
  const json = JSON.parse(body) as { aaData?: unknown };
  if (!Array.isArray(json.aaData)) throw new Error("Réponse FBI sans aaData.");
  return json.aaData
    .filter((row): row is string[] => Array.isArray(row) && row.length >= 9)
    .map((row) => {
      const cells = row.map((c) => String(c ?? ""));
      const emCell = cells.find((c) => c.includes("telechargerMatch(")) ?? null;
      const token = emCell ? /telechargerMatch\(\s*'([^']+)'\s*,\s*'([^']*)'/.exec(emCell) : null;
      return {
        division: divisionOf(cells[1] ?? ""),
        matchNumber: stripHtml(cells[2] ?? ""),
        emarqueToken: token?.[1] ?? null,
        fbiMatchId: token?.[2] || null,
        emarqueV2: emCell !== null && /emarqueV2/.test(emCell),
      };
    });
}

/**
 * La ligne de CETTE rencontre : numéro exact, et division exacte quand on la
 * connaît (code de compétition FFBB, ex. "BU15MN1" — confirmé identique à la
 * colonne Division de FBI). Sans division connue, une seule ligne au numéro
 * exact est acceptée — jamais un choix au hasard entre plusieurs.
 */
export function pickRow(rows: EmarqueSearchRow[], matchNumber: string, division: string | null): EmarqueSearchRow | null {
  const sameNumber = rows.filter((r) => r.matchNumber === matchNumber);
  if (division) return sameNumber.find((r) => r.division === division) ?? null;
  return sameNumber.length === 1 ? sameNumber[0]! : null;
}

export function emarqueDownloadUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/telechargerFeuilleMatchEmarque.fbi?action=emV2&plugin=true&idRenc=${token}`;
}

/** Un ZIP commence toujours par « PK ». FBI renvoie une page HTML quand le fichier n'est pas (encore) disponible. */
export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}
