
/**
 * `pdfjs-dist` expose un module ESM (`legacy/build/pdf.mjs`, la variante
 * compatible Node sans DOM). Chargé une seule fois et mis en cache : c'est
 * un import dynamique un peu coûteux (parsing du module worker inclus).
 */
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let modulePromise: Promise<PdfjsModule> | null = null;

/**
 * Constaté en production sur Vercel (job discover_emarque n°1481, § docs/FBI.md
 * "Vingt-neuvième déclenchement" — le document ZIP est bien téléchargé, mais
 * son parsing échoue) : `PDFWorker._setupFakeWorkerGlobal` (interne à
 * `pdfjs-dist`) essaie par défaut un `import("./pdf.worker.mjs")` DYNAMIQUE et
 * RELATIF au moment de l'appel — invisible à l'analyse statique de la
 * pipeline de build de Vercel (`docs/DEPLOYMENT.md` : empaquetage esbuild
 * réel d'une Function unique), donc ce fichier n'est jamais inclus dans le
 * déploiement (`/var/task/node_modules/...` n'a que `pdf.mjs`, jamais
 * `pdf.worker.mjs`) → `Setting up fake worker failed: Cannot find module`.
 *
 * `pdfjs-dist` a exactement prévu ce cas : AVANT de tenter cet import
 * dynamique, il vérifie `globalThis.pdfjsWorker?.WorkerMessageHandler` (voir
 * `pdf.mjs`, `PDFWorker.#mainThreadWorkerMessageHandler`) — s'il est déjà
 * défini, l'import dynamique n'a jamais lieu. Un import STATIQUE (littéral,
 * jamais un chemin calculé) du module worker EST visible par l'analyse
 * statique de la pipeline de build, donc correctement inclus dans le
 * déploiement — on l'assigne ici à ce global avant tout appel à
 * `getDocument()`.
 */
async function installFakeWorkerGlobal(): Promise<void> {
  const workerModule = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = workerModule;
}

export function loadPdfjs(): Promise<PdfjsModule> {
  modulePromise ??= installFakeWorkerGlobal().then(() => import("pdfjs-dist/legacy/build/pdf.mjs"));
  return modulePromise;
}
