import path from "node:path";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { loadPdfjs } from "./pdfjs-loader";
import type { DocumentExtractor, ExtractedText, ZoneFraction } from "./types";

/**
 * Résolution de rendu. Calibré empiriquement (voir docs/
 * FBI_AUTHENTICATED_SPIKE.md et le travail de calibration mené sur
 * l'échantillon réel fourni) : 300dpi donne un texte lisible par Tesseract
 * sur les documents e-Marque V2, 150dpi est trop grossier pour les petites
 * cellules de tableau.
 */
const RENDER_SCALE = 300 / 72;

/**
 * Chemin du modèle de langue vendorisé (voir ocr-data/README.md). Résolu
 * depuis `process.cwd()` : c'est la convention documentée par Next.js pour
 * les fichiers déclarés via `outputFileTracingIncludes` (voir
 * next.config.ts) dans une fonction serverless Vercel.
 */
const OCR_LANG_PATH = path.join(process.cwd(), "src/server/emarque/ocr-data");

/**
 * Extraction par rendu image + OCR ciblé (Tesseract), pour les documents
 * e-Marque V2 : ils n'ont AUCUNE couche texte (confirmé sur l'échantillon
 * réel fourni — voir docs/FBI_AUTHENTICATED_SPIKE.md). Le rendu de chaque
 * page est mis en cache (une page peut être découpée en dizaines de zones :
 * en-tête, chaque ligne de l'effectif, table des officiels...).
 *
 * Statut : validé manuellement contre un vrai document e-Marque V2 pendant
 * le développement (rendu + OCR + extraction de plusieurs champs corrects,
 * dont un numéro de licence OTM). Non re-testé en CI (pas de fixture PDF
 * réelle committée, voir docs/FBI_AUTHENTICATED_SPIKE.md) : les tests
 * automatisés couvrent la couche de normalisation (regex) en aval, pas ce
 * rendu+OCR lui-même.
 */
export class PdfRasterOcrExtractor implements DocumentExtractor {
  readonly name = "pdf-raster-ocr";
  private readonly canvasCache = new Map<number, Canvas>();
  private workerPromise: Promise<Worker> | null = null;

  constructor(private readonly pdfBuffer: Buffer) {}

  private async getWorker(): Promise<Worker> {
    this.workerPromise ??= createWorker("fra", 1, { langPath: OCR_LANG_PATH, gzip: false }).then(async (worker) => {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      return worker;
    });

    return this.workerPromise;
  }

  private async getPageCanvas(pageNumber: number): Promise<Canvas> {
    const cached = this.canvasCache.get(pageNumber);
    if (cached) return cached;

    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(this.pdfBuffer) }).promise;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(viewport.width, viewport.height);

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    this.canvasCache.set(pageNumber, canvas);
    return canvas;
  }

  async extractZone(pageNumber: number, zone: ZoneFraction): Promise<ExtractedText> {
    const pageCanvas = await this.getPageCanvas(pageNumber);

    const x = Math.round(zone.xFrac * pageCanvas.width);
    const y = Math.round(zone.yFrac * pageCanvas.height);
    const width = Math.round(zone.widthFrac * pageCanvas.width);
    const height = Math.round(zone.heightFrac * pageCanvas.height);

    const cropped = createCanvas(Math.max(width, 1), Math.max(height, 1));
    cropped.getContext("2d").drawImage(pageCanvas, x, y, width, height, 0, 0, width, height);

    const worker = await this.getWorker();
    const { data } = await worker.recognize(cropped.toBuffer("image/png"));

    return { text: data.text.trim(), confidence: data.confidence };
  }

  async dispose(): Promise<void> {
    this.canvasCache.clear();

    if (this.workerPromise) {
      const worker = await this.workerPromise;
      await worker.terminate();
      this.workerPromise = null;
    }
  }
}
