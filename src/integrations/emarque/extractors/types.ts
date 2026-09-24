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

export interface DocumentExtractor {
  readonly name: string;
  extractZone(pageNumber: number, zone: ZoneFraction, options?: ExtractZoneOptions): Promise<ExtractedText>;
  dispose(): Promise<void>;
}
