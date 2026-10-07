/**
 * Diagnostic de la lecture des licences sur les feuilles e-Marque (2026-10-07).
 *
 * Pour chaque feuille dont des licences de l'équipe A n'ont pas été lues
 * (avertissement PLAYER_LICENSE_MISSING « domicile ») et dont le ZIP est
 * encore stocké : refait la détection des lignes du tableau comme le parsing
 * de production, puis pour CHAQUE ligne de l'équipe A enregistre l'image de
 * la zone licence et ce que l'OCR lit avec chaque gabarit de colonnes.
 * Résultat dans `emarque_debug_cells` (service uniquement). Rien d'autre
 * n'est modifié.
 *
 * Usage (poste du club, même `.env.fbi-local` que le worker) :
 *   npm run emarque:debug-licenses [-- <match_id> ...]
 */
import { existsSync } from "node:fs";
import JSZip from "jszip";

if (!existsSync(".env.fbi-local")) {
  console.error("Fichier .env.fbi-local introuvable (voir ops/fbi-local-worker/README.md).");
  process.exit(1);
}
process.loadEnvFile(".env.fbi-local");
process.env.FBI_CREDENTIALS_ENCRYPTION_KEY ||= Buffer.alloc(32).toString("base64");
process.env.CRON_SECRET ||= "diagnostic-local-non-utilise";
process.env.FRONTEND_ORIGINS ||= "http://localhost";

const { createServiceSupabaseClient } = await import("../../src/db/client.js");
const { downloadEmarqueFile } = await import("../../src/storage/emarque-storage.js");
const { PdfRasterOcrExtractor } = await import("../../src/integrations/emarque/extractors/pdf-raster-ocr-extractor.js");
const { FEUILLEMATCH_ROSTER, ROSTER_HEADER_GAP_FRACTION_RANGE, ROSTER_TABLE_SCAN_ZONE } = await import("../../src/integrations/emarque/layout/feuillematch-layout.js");
const { locateTeamTables } = await import("../../src/integrations/emarque/layout/table-structure.js");
const { extractIsolatedLicenseNumber, extractLicenseNumber } = await import("../../src/integrations/emarque/normalizers/text-fields.js");

const supabase = createServiceSupabaseClient();

async function targetMatchIds(): Promise<string[]> {
  const fromArgs = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/.test(a));
  if (fromArgs.length) return fromArgs;
  const { data, error } = await supabase.from("emarque_imports").select("match_id, quality_warnings").eq("status", "imported");
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((row) => JSON.stringify(row.quality_warnings ?? []).match(/PLAYER_LICENSE_MISSING[^}]*domicile/))
    .map((row) => row.match_id as string);
}

// Bande couvrant les colonnes licence des deux gabarits (référence 2479 px de large).
const STRIP_X: readonly [number, number] = [100, 560];

for (const matchId of await targetMatchIds()) {
  const { data: doc } = await supabase.from("match_documents").select("storage_path, purged_at").eq("match_id", matchId).eq("type", "emarque_zip").maybeSingle();
  if (!doc?.storage_path || doc.purged_at) {
    console.log(`${matchId} : ZIP plus disponible, ignoré`);
    continue;
  }
  const zip = await JSZip.loadAsync(await downloadEmarqueFile(supabase, doc.storage_path));
  const entry = Object.values(zip.files).find((f) => /feuillematch_/i.test(f.name));
  if (!entry) {
    console.log(`${matchId} : pas de feuillematch dans le ZIP`);
    continue;
  }
  const extractor = new PdfRasterOcrExtractor(Buffer.from(await entry.async("uint8array")));
  try {
    const lines = await extractor.detectHorizontalLines(1, ROSTER_TABLE_SCAN_ZONE);
    const tables = locateTeamTables(lines, ROSTER_HEADER_GAP_FRACTION_RANGE);
    const teamA = tables[0];
    if (!teamA) {
      console.log(`${matchId} : tableau équipe A non détecté (${lines.length} lignes de grille)`);
      continue;
    }
    const rows = teamA.rowBoundaries;
    let exported = 0;
    for (let row = 0; row < rows.length - 1 && row < FEUILLEMATCH_ROSTER.maxRows; row += 1) {
      const top = rows[row]!;
      const bottom = rows[row + 1]!;
      const results: Record<string, unknown> = {};
      for (const [name, layout] of [["gabaritA", FEUILLEMATCH_ROSTER.teamA[0]!], ["gabaritB", FEUILLEMATCH_ROSTER.teamA[1]!]] as const) {
        const narrow = (await extractor.extractZone(1, layout.cellZone(top, bottom, "licenseNumber"))).text;
        const wide = (await extractor.extractZone(1, layout.licenseNumberWideZone(top, bottom))).text;
        results[name] = { narrow, narrowParsed: extractIsolatedLicenseNumber(narrow), wide, wideParsed: extractLicenseNumber(wide) };
      }
      // Image seulement pour les lignes où aucun gabarit ne lit de licence (celles à comprendre).
      const anyParsed = Object.values(results).some((r) => (r as { narrowParsed: string | null }).narrowParsed);
      const png = anyParsed ? null : await extractor.debugZonePng(1, { xFrac: STRIP_X[0] / 2479, yFrac: top, widthFrac: (STRIP_X[1] - STRIP_X[0]) / 2479, heightFrac: bottom - top });
      const { error } = await supabase.from("emarque_debug_cells").insert({ match_id: matchId, team: "A", row_index: row, row_top: top, row_bottom: bottom, results, png_base64: png ? png.toString("base64") : null });
      if (error) throw new Error(error.message);
      exported += 1;
    }
    console.log(`${matchId} : ${exported} ligne(s) de l'équipe A exportée(s)`);
  } finally {
    await extractor.dispose();
  }
}
console.log("Terminé.");
