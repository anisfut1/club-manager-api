import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildFbiLicenceXlsx, licenceRow } from "../../test-support/fbi-licence-xlsx.js";
import { LicenceExportError, parseFbiLicenceExport } from "./fbi-licence-export.js";

describe("parseFbiLicenceExport — export Excel FBI « Rechercher une licence »", () => {
  it("lit les en-têtes réels de FBI : N° national, Numéro, nom, prénom, date (JJ/MM/AAAA → AAAA-MM-JJ), catégorie, sexe", async () => {
    const file = await buildFbiLicenceXlsx([
      licenceRow({ id: "200000001234567", numero: "BC123456", nom: "MARTIN", prenom: "Léa", naissance: "05/03/2012", categorie: "U15", sexe: "F" }),
      licenceRow({ id: "271056", numero: "VT780264", nom: "Dupont-Lefèvre", prenom: "Jean Marc", naissance: "17/08/1978", categorie: "Seniors", sexe: "M" }),
    ]);
    const { rows, skippedLines } = await parseFbiLicenceExport(file);
    expect(skippedLines).toBe(0);
    expect(rows).toEqual([
      { ffbbLicenceId: "200000001234567", licenseNumber: "BC123456", firstName: "Léa", lastName: "MARTIN", birthDate: "2012-03-05", categoryLabel: "U15", sexe: "F" },
      { ffbbLicenceId: "271056", licenseNumber: "VT780264", firstName: "Jean Marc", lastName: "Dupont-Lefèvre", birthDate: "1978-08-17", categoryLabel: "Seniors", sexe: "M" },
    ]);
  });

  it("ignore les lignes incomplètes (sans N° national, nom ou prénom) et les lignes vides", async () => {
    const file = await buildFbiLicenceXlsx([licenceRow({ id: "", numero: "BC1", nom: "SANS", prenom: "Id" }), ["", "", "", ""], licenceRow({ id: "1", numero: "BC2", nom: "OK", prenom: "Ok" })]);
    const { rows, skippedLines } = await parseFbiLicenceExport(file);
    expect(rows.map((r) => r.ffbbLicenceId)).toEqual(["1"]);
    expect(skippedLines).toBe(1);
  });

  it("accepte aussi les chaînes partagées et les nombres/dates Excel natifs", async () => {
    const zip = new JSZip();
    zip.file("xl/sharedStrings.xml", "<sst><si><t>N° national</t></si><si><t>Nom</t></si><si><t>Prénom</t></si><si><t>Né(e) le</t></si><si><t>ROUX</t></si><si><t>Zoé</t></si></sst>");
    zip.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
        '<row r="2"><c r="A2"><v>200000004889030</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c><c r="D2"><v>40909</v></c></row></sheetData></worksheet>',
    );
    const { rows } = await parseFbiLicenceExport(await zip.generateAsync({ type: "uint8array" }));
    expect(rows).toEqual([{ ffbbLicenceId: "200000004889030", licenseNumber: null, firstName: "Zoé", lastName: "ROUX", birthDate: "2012-01-01", categoryLabel: null, sexe: null }]);
  });

  it("refuse clairement un fichier qui n'est pas un Excel, ou un Excel qui n'est pas l'export des licences", async () => {
    await expect(parseFbiLicenceExport(new TextEncoder().encode("Nom;Prénom\nA;B"))).rejects.toMatchObject({ code: "NOT_AN_XLSX" });
    const other = await buildFbiLicenceXlsx([["1", "x"]], ["Rencontre", "Nom", "Score"]);
    const error = await parseFbiLicenceExport(other).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LicenceExportError);
    expect((error as LicenceExportError).message).toContain("N° national");
    await expect(parseFbiLicenceExport(await buildFbiLicenceXlsx([]))).rejects.toMatchObject({ code: "EMPTY_EXPORT" });
  });
});
