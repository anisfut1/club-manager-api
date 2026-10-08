import JSZip from "jszip";

/**
 * Fabrique un export « Rechercher une licence » au format du vrai fichier
 * FBI (cellules texte `inlineStr`, en-têtes réels du fichier fourni par le
 * club le 2026-10-08) — données fictives uniquement.
 */
export const FBI_LICENCE_HEADERS = ["N° national", "Numéro", "Nom", "Prénom", "Né(e) le", "Groupement", "Licence", "Catégorie", "Qualification", "Sexe", "Surc.", "Fonctions"];

const COLS = "ABCDEFGHIJKL";

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function buildFbiLicenceXlsx(rows: string[][], headers: string[] = FBI_LICENCE_HEADERS): Promise<Uint8Array> {
  const allRows = [headers, ...rows];
  const sheetRows = allRows
    .map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => `<c r="${COLS[c]}${r + 1}" t="inlineStr"><is><t>${escapeXml(v)}</t></is></c>`).join("")}</row>`)
    .join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Licences" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "uint8array" });
}

/** Une ligne d'export fictive. */
export function licenceRow(input: { id: string; numero: string; nom: string; prenom: string; naissance?: string; categorie?: string; sexe?: string }): string[] {
  return [input.id, input.numero, input.nom, input.prenom, input.naissance ?? "01/02/2012", "CLUB FICTIF BASKET", "0C", input.categorie ?? "U15", "15/09/2026", input.sexe ?? "F", "", ""];
}
