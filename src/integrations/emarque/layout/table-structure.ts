/**
 * Repère la structure d'un tableau "2 équipes" (résumé ou feuillematch) à
 * partir des lignes de grille horizontales détectées sur la page (voir
 * `DocumentExtractor#detectHorizontalLines`) — remplace un calibrage à
 * coordonnées Y FIXES (`resume-layout.ts`/`feuillematch-layout.ts` avant
 * ce correctif), cassé dès qu'un document réel a un effectif différent de
 * l'échantillon de calibration.
 *
 * Retour du club, 2026-09-29 : les stats d'un match à 12 joueurs LOCAUX (la
 * calibration d'origine supposait 8) étaient méconnaissables — la ligne
 * "VISITEURS" du gabarit FFBB est imprimée APRÈS le tableau LOCAUX, donc sa
 * position verticale dépend directement du nombre de joueurs LOCAUX. Une
 * coordonnée Y fixe pour l'équipe B ne peut donc être correcte que pour UN
 * SEUL effectif LOCAUX précis — n'importe quel autre décale la lecture dans
 * du texte sans rapport (en-tête, ligne de synthèse...), produisant des
 * noms/statistiques qui ne correspondent à RIEN dans le document réel.
 *
 * Principe : l'en-tête de colonnes de chaque équipe ("N° Maillot / NOM
 * Prénom / ...") est visuellement PLUS HAUT qu'une ligne de données (deux
 * lignes de texte contre une seule) — mesuré pixel par pixel sur deux
 * documents réels de compétitions différentes (rencontre 1481 et rencontre
 * 6 vs Agde Basket, docs/EMARQUE.md "Correctifs d'import") : l'écart
 * en-tête est systématiquement ~1,5× plus grand qu'un écart ligne de
 * données, jamais dans la même plage. Ce ratio, pas un effectif supposé,
 * sert à repérer où commence chaque tableau.
 */

export interface DetectedTeamTable {
  /**
   * Limites Y (fraction de page) de chaque "ligne" du tableau détecté, dans
   * l'ordre : `rowBoundaries[i]` à `rowBoundaries[i+1]` délimite la ligne i
   * — un joueur réel OU une ligne de synthèse ("Total Équipe"...), jamais
   * distingué ici (voir le "portillon" numéro de maillot/licence côté
   * appelant, qui s'arrête sur une ligne sans numéro valide).
   */
  rowBoundaries: number[];
}

/**
 * `lines` DOIT être trié croissant (garanti par
 * `DocumentExtractor#detectHorizontalLines`). Retourne un tableau détecté
 * PAR EN-TÊTE trouvé, dans l'ordre où ils apparaissent sur la page (LOCAUX
 * puis VISITEURS pour les documents e-Marque V2 — jamais l'inverse,
 * confirmé sur les deux échantillons réels utilisés pour calibrer cette
 * détection).
 */
export function locateTeamTables(lines: number[], headerGapRange: readonly [number, number]): DetectedTeamTable[] {
  const headerStartIndices: number[] = [];

  for (let i = 0; i < lines.length - 1; i += 1) {
    const gap = lines[i + 1]! - lines[i]!;
    if (gap >= headerGapRange[0] && gap <= headerGapRange[1]) headerStartIndices.push(i);
  }

  return headerStartIndices.map((headerIdx, i) => {
    const dataStartIdx = headerIdx + 1; // ligne = fin de l'en-tête = haut de la ligne 0.
    const nextHeaderIdx = headerStartIndices[i + 1] ?? lines.length - 1; // s'arrête au début de l'en-tête suivant, ou à la fin.
    return { rowBoundaries: lines.slice(dataStartIdx, nextHeaderIdx + 1) };
  });
}
