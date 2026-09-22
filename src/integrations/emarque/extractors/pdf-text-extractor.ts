import { loadPdfjs } from "./pdfjs-loader.js";
import type { DocumentExtractor, ExtractedText, ZoneFraction } from "./types.js";

/**
 * Extraction native du texte d'un PDF, quand une couche texte existe.
 *
 * Statut sur les documents e-Marque V2 réellement observés (voir
 * docs/FBI_AUTHENTICATED_SPIKE.md et l'échantillon fourni) : AUCUNE couche
 * texte (0 caractère extrait sur toutes les pages testées, y compris avec
 * plusieurs bibliothèques). Cette classe reste utile si un autre type de
 * document e-Marque (ou une version future) expose une vraie couche texte —
 * voir `hasTextLayer` pour la détection, utilisée par le sélecteur
 * d'extracteur (parser/select-extractor.ts).
 *
 * Limite assumée : `extractZone` ignore la géométrie de la zone et retourne
 * le texte de la page entière (pas de zonage fin sans rendu image) — ce
 * n'est utilisé que lorsqu'une couche texte existe, cas non rencontré à ce
 * jour.
 */
export class PdfTextExtractor implements DocumentExtractor {
  readonly name = "pdf-text";
  private readonly pageTextCache = new Map<number, string>();

  constructor(private readonly pdfBuffer: Buffer) {}

  async hasTextLayer(pageNumber: number): Promise<boolean> {
    const text = await this.getPageText(pageNumber);
    return text.trim().length > 10;
  }

  private async getPageText(pageNumber: number): Promise<string> {
    const cached = this.pageTextCache.get(pageNumber);
    if (cached !== undefined) return cached;

    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(this.pdfBuffer) }).promise;
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ").trim();

    this.pageTextCache.set(pageNumber, text);
    return text;
  }

  async extractZone(pageNumber: number, _zone: ZoneFraction): Promise<ExtractedText> {
    const text = await this.getPageText(pageNumber);
    return { text, confidence: text ? 100 : 0 };
  }

  async dispose(): Promise<void> {
    this.pageTextCache.clear();
  }
}
