
/**
 * `pdfjs-dist` expose un module ESM (`legacy/build/pdf.mjs`, la variante
 * compatible Node sans DOM). Chargé une seule fois et mis en cache : c'est
 * un import dynamique un peu coûteux (parsing du module worker inclus).
 */
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let modulePromise: Promise<PdfjsModule> | null = null;

export function loadPdfjs(): Promise<PdfjsModule> {
  modulePromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return modulePromise;
}
