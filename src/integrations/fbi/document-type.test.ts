import { describe, expect, it } from "vitest";
import { inferMatchDocumentType, mimeTypeForFileName } from "./document-type";

describe("inferMatchDocumentType", () => {
  it("priorise le ZIP complet (§19 du brief FBI)", () => {
    expect(inferMatchDocumentType("2813.zip")).toBe("emarque_zip");
  });

  it("reconnaît la feuille de match, le résumé et les positions de tir par le libellé", () => {
    expect(inferMatchDocumentType("2813-feuille_de_match.pdf")).toBe("match_sheet");
    expect(inferMatchDocumentType("Resume.pdf")).toBe("summary");
    expect(inferMatchDocumentType("position_tirs.pdf")).toBe("shot_chart");
  });

  it("retombe sur 'other' pour un document non reconnu", () => {
    expect(inferMatchDocumentType("document-mystere.pdf")).toBe("other");
  });
});

describe("mimeTypeForFileName", () => {
  it("déduit le type MIME de l'extension", () => {
    expect(mimeTypeForFileName("a.zip")).toBe("application/zip");
    expect(mimeTypeForFileName("a.pdf")).toBe("application/pdf");
    expect(mimeTypeForFileName("a.bin")).toBe("application/octet-stream");
  });
});
