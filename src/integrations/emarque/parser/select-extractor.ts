import { PdfTextExtractor } from "../extractors/pdf-text-extractor.js";
import { PdfRasterOcrExtractor } from "../extractors/pdf-raster-ocr-extractor.js";
import type { DocumentExtractor } from "../extractors/types.js";

/**
 * Choisit l'extracteur adapté à un document (ARCHITECTURE.md §15/§16) :
 * texte natif s'il existe, rendu image + OCR sinon. Sur les documents
 * e-Marque V2 réellement observés, c'est systématiquement le second cas
 * (aucune couche texte, voir docs/FBI_AUTHENTICATED_SPIKE.md).
 */
export async function selectExtractor(pdfBuffer: Buffer): Promise<DocumentExtractor> {
  const textExtractor = new PdfTextExtractor(pdfBuffer);

  if (await textExtractor.hasTextLayer(1)) {
    return textExtractor;
  }

  await textExtractor.dispose();
  return new PdfRasterOcrExtractor(pdfBuffer);
}
