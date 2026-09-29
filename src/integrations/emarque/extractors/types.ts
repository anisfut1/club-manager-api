/**
 * DocumentExtractor — abstraction demandée par ARCHITECTURE.md §16 : le
 * parser métier e-Marque (normalizers/) ne doit jamais dépendre directement
 * d'une bibliothèque OCR précise.
 */

/** Zone rectangulaire exprimée en fractions de la page (0..1), indépendante de la résolution de rendu. */
export interface ZoneFraction {
  xFrac: number;
  yFrac: number;
  widthFrac: number;
  heightFrac: number;
}

export interface ExtractedText {
  text: string;
  /** 0-100. 100 = extraction native (texte réel du PDF), sinon score OCR. */
  confidence: number;
}

export interface ExtractZoneOptions {
  /**
   * La zone est une cellule numérique isolée (jamais du texte libre) —
   * permet à un extracteur OCR de tenter une seconde passe ciblée
   * (agrandissement + alphabet restreint aux chiffres) si la première n'a
   * trouvé aucun chiffre, voir `PdfRasterOcrExtractor`. Ignoré par
   * `PdfTextExtractor` (texte natif, jamais besoin d'une seconde passe).
   */
  expectDigitsOnly?: boolean;
}

export interface DetectLinesOptions {
  /** Fraction de pixels sombres (0..1) le long d'une rangée pour la compter comme une ligne de grille. Défaut : 0.5. */
  minDarknessFraction?: number;
}

export interface DocumentExtractor {
  readonly name: string;
  extractZone(pageNumber: number, zone: ZoneFraction, options?: ExtractZoneOptions): Promise<ExtractedText>;
  /**
   * Détecte les lignes de grille HORIZONTALES d'un tableau à l'intérieur
   * d'une zone (voir `layout/table-structure.ts`) — remplace un calibrage à
   * coordonnées pixel FIXES (cassé dès qu'un document réel a un nombre de
   * lignes différent de l'échantillon de calibration, voir docs/EMARQUE.md
   * "Correctifs d'import"). Retourne les positions Y des centres de ligne,
   * en fraction de la PAGE ENTIÈRE (jamais de la zone), triées du haut vers
   * le bas. `[]` si l'extracteur n'a pas accès aux pixels de rendu (voir
   * `PdfTextExtractor`) — sans objet pour un document avec couche texte.
   */
  detectHorizontalLines(pageNumber: number, zone: ZoneFraction, options?: DetectLinesOptions): Promise<number[]>;
  dispose(): Promise<void>;
}
