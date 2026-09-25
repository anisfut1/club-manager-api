import type { FbiDerogationDetailFields } from "./types.js";

/**
 * Libellés confirmés par capture d'écran du VRAI FBI (2026-09-25, page
 * `afficherDerogation.fbi`) — "Demandeur", "Motif de la demande", "Date
 * rencontre"/"Horaire" (dans "Demande de dérogation" — la date/heure
 * DEMANDÉE, distincte de "Rencontre du"/"Heure" en haut de page qui sont
 * les valeurs INITIALES déjà connues via le tableau de résultats), puis
 * "Adversaire"/"Date de réponse"/"Acceptation"/"Motif de refus" (dans
 * "Réponse de l'adversaire"). Chaque libellé n'apparaît qu'UNE fois sur la
 * page entière (pas d'ambiguïté "Date rencontre" vs "Rencontre du").
 */
const DETAIL_LABELS: Record<keyof FbiDerogationDetailFields, string> = {
  demandeur: "Demandeur",
  motif: "Motif de la demande",
  dateRencontreDemandee: "Date rencontre",
  heureDemandee: "Horaire",
  adversaire: "Adversaire",
  dateReponse: "Date de réponse",
  acceptation: "Acceptation",
  motifRefus: "Motif de refus",
};

/**
 * Extrait les champs de détail à partir du texte visible de la page
 * (chaque ligne = soit un libellé, soit sa valeur juste en dessous —
 * layout "label au-dessus de la valeur" confirmé par capture d'écran).
 * Volontairement indépendant de toute classe CSS/structure DOM devinée
 * (contrairement à un sélecteur `label → input`) : la mise en page de
 * cette page (Angular Material probable, jamais confirmée en HTML brut)
 * n'a été vue qu'en rendu, jamais en source — un sélecteur basé sur des
 * classes inventées casserait silencieusement. Ne capture PAS les cases à
 * cocher (Modifier la date/l'horaire/la salle, Inverser la rencontre/les
 * équipes) : pas demandées, et leur état coché/décoché ne se lit pas de
 * façon fiable dans le texte visible. Fonction PURE, testable sans
 * Playwright ni FBI réel.
 */
const KNOWN_LABELS = new Set(Object.values(DETAIL_LABELS));

export function extractDerogationDetailFields(lines: string[]): FbiDerogationDetailFields {
  const trimmed = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  const values: Partial<Record<keyof FbiDerogationDetailFields, string | null>> = {};

  for (const [key, label] of Object.entries(DETAIL_LABELS) as [keyof FbiDerogationDetailFields, string][]) {
    const index = trimmed.findIndex((line) => line === label);
    if (index === -1 || index + 1 >= trimmed.length) continue;
    const value = trimmed[index + 1];
    // La ligne suivante est elle-même un des libellés connus (voir
    // "Date de réponse" immédiatement suivi de "Acceptation" quand la
    // réponse n'a pas encore été donnée) : le champ est VIDE, jamais la
    // valeur du champ suivant.
    if (KNOWN_LABELS.has(value)) continue;
    values[key] = value.length > 0 ? value : null;
  }

  return {
    demandeur: values.demandeur ?? null,
    motif: values.motif ?? null,
    dateRencontreDemandee: values.dateRencontreDemandee ?? null,
    heureDemandee: values.heureDemandee ?? null,
    adversaire: values.adversaire ?? null,
    dateReponse: values.dateReponse ?? null,
    acceptation: values.acceptation ?? null,
    motifRefus: values.motifRefus ?? null,
  };
}
