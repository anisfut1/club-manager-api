import type { MatchDocumentType } from "../../db/types.js";

const SUMMARY_PATTERN = /résumé|resume/i;
const MATCH_SHEET_PATTERN = /feuille/i;
const SHOT_CHART_PATTERN = /position.*tir|shot/i;

/**
 * Devine le type de document (§23 du brief FBI) à partir du nom de fichier
 * — dont `BrowserFbiClient` dérive une version normalisée du libellé
 * affiché sur la page FBI quand l'URL elle-même n'est pas explicite (voir
 * `fileNameFromLabelOrUrl` dans browser-client.ts). Le ZIP complet a
 * toujours priorité (§19) : cette fonction n'est utile que pour les
 * documents séparés.
 */
export function inferMatchDocumentType(fileName: string): MatchDocumentType {
  if (/\.zip$/i.test(fileName)) return "emarque_zip";
  if (MATCH_SHEET_PATTERN.test(fileName)) return "match_sheet";
  if (SUMMARY_PATTERN.test(fileName)) return "summary";
  if (SHOT_CHART_PATTERN.test(fileName)) return "shot_chart";
  return "other";
}

export function mimeTypeForFileName(fileName: string): string {
  if (/\.zip$/i.test(fileName)) return "application/zip";
  if (/\.pdf$/i.test(fileName)) return "application/pdf";
  return "application/octet-stream";
}
