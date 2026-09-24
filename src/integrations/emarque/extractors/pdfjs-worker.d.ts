/**
 * `pdfjs-dist` ne publie pas de déclaration de type pour son module worker
 * (contrairement à `legacy/build/pdf.mjs`) — seul son contenu JS existe.
 * Importé uniquement pour son effet de bord (voir `pdfjs-loader.ts` :
 * assignation à `globalThis.pdfjsWorker`), jamais pour une valeur typée.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
