import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EMarqueMatchData } from "@/integrations/emarque/types";

vi.mock("@/storage/emarque-storage", () => ({
  downloadEmarqueFile: vi.fn(async () => Buffer.from("contenu-zip-synthetique")),
}));

vi.mock("@/integrations/emarque/parser/parse-emarque-zip", () => ({
  PARSER_VERSION: "test-version",
  parseEmarqueZip: vi.fn(),
}));

vi.mock("@/integrations/emarque/persist/persist-emarque-match", () => ({
  persistEmarqueMatchData: vi.fn(async () => ({ importId: "import-1", status: "imported", alreadyImported: false, participantsLinked: 0, participantsUnlinked: 0 })),
}));

import { downloadEmarqueFile } from "@/storage/emarque-storage";
import { parseEmarqueZip } from "@/integrations/emarque/parser/parse-emarque-zip";
import { persistEmarqueMatchData } from "@/integrations/emarque/persist/persist-emarque-match";
import { parseDownloadedEmarqueDocuments } from "./parse-downloaded-documents";

const EMPTY_EMARQUE_DATA: EMarqueMatchData = {
  match: {
    rencontreNumero: "2813",
    competitionLabel: null,
    pouleLabel: null,
    date: null,
    heure: null,
    lieu: null,
    homeTeamName: null,
    awayTeamName: null,
    homeClubCode: null,
    awayClubCode: null,
    scoreHome: 69,
    scoreAway: 101,
    scoreByPeriod: [],
  },
  players: [],
  coaches: [],
  officials: [],
  tableOfficials: [],
  playerStats: [],
  shotData: { experimental: true, documentPresent: false },
  quality: { warnings: [], overallConfidence: null },
};

interface FakeDocument {
  id: string;
  club_id: string;
  match_id: string;
  filename: string | null;
  storage_path: string;
  sha256: string;
}

function makeFakeSupabase(options: {
  pendingDocs: FakeDocument[];
  matchesById: Record<string, { numero: string | null; score_home: number | null; score_away: number | null }>;
  documentUpdates: Array<{ id: string; patch: unknown }>;
  matchUpdates: Array<{ id: string; patch: unknown }>;
}) {
  return {
    from(table: string) {
      if (table === "match_documents") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: options.pendingDocs, error: null }),
            }),
          }),
          update: (patch: unknown) => ({
            eq: (_col: string, id: string) => {
              options.documentUpdates.push({ id, patch });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === "matches") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              single: () => Promise.resolve({ data: options.matchesById[id] ?? null, error: options.matchesById[id] ? null : { message: "introuvable" } }),
            }),
          }),
          update: (patch: unknown) => ({
            eq: (_col: string, id: string) => {
              options.matchUpdates.push({ id, patch });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      throw new Error(`Table inattendue dans le fake Supabase de test : ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseDownloadedEmarqueDocuments", () => {
  it("ne fait rien quand aucun document n'attend d'être parsé", async () => {
    const supabase = makeFakeSupabase({ pendingDocs: [], matchesById: {}, documentUpdates: [], matchUpdates: [] });

    const result = await parseDownloadedEmarqueDocuments(supabase);

    expect(result).toEqual({ candidatesExamined: 0, imported: 0, errors: 0 });
    expect(downloadEmarqueFile).not.toHaveBeenCalled();
  });

  it("télécharge depuis le storage, parse et persiste un document ZIP téléchargé (cas nominal)", async () => {
    vi.mocked(parseEmarqueZip).mockResolvedValue(EMPTY_EMARQUE_DATA);
    const documentUpdates: Array<{ id: string; patch: unknown }> = [];
    const matchUpdates: Array<{ id: string; patch: unknown }> = [];

    const supabase = makeFakeSupabase({
      pendingDocs: [{ id: "doc-1", club_id: "club-1", match_id: "match-1", filename: "2813.zip", storage_path: "private/emarque/club-1/2025-2026/match-1/original.zip", sha256: "abc123" }],
      matchesById: { "match-1": { numero: "2813", score_home: 69, score_away: 101 } },
      documentUpdates,
      matchUpdates,
    });

    const result = await parseDownloadedEmarqueDocuments(supabase);

    expect(result).toEqual({ candidatesExamined: 1, imported: 1, errors: 0 });
    expect(downloadEmarqueFile).toHaveBeenCalledWith(supabase, "private/emarque/club-1/2025-2026/match-1/original.zip");
    expect(persistEmarqueMatchData).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ matchId: "match-1", clubId: "club-1", fileHash: "abc123", parserVersion: "test-version" }),
    );
    // Marqué "parsing" avant traitement, "imported" après (jamais laissé en 'downloaded').
    expect(documentUpdates.map((u) => (u.patch as { status: string }).status)).toEqual(["parsing", "imported"]);
  });

  it("marque le document et le match en erreur sans planter les autres documents", async () => {
    vi.mocked(parseEmarqueZip).mockRejectedValue(new Error("ZIP corrompu"));
    const documentUpdates: Array<{ id: string; patch: unknown }> = [];
    const matchUpdates: Array<{ id: string; patch: unknown }> = [];

    const supabase = makeFakeSupabase({
      pendingDocs: [{ id: "doc-1", club_id: "club-1", match_id: "match-1", filename: "2813.zip", storage_path: "path.zip", sha256: "abc123" }],
      matchesById: { "match-1": { numero: "2813", score_home: null, score_away: null } },
      documentUpdates,
      matchUpdates,
    });

    const result = await parseDownloadedEmarqueDocuments(supabase);

    expect(result).toEqual({ candidatesExamined: 1, imported: 0, errors: 1 });
    expect(documentUpdates.at(-1)).toMatchObject({ id: "doc-1", patch: expect.objectContaining({ status: "error" }) });
  });

  it("traite plusieurs documents de clubs différents indépendamment", async () => {
    vi.mocked(parseEmarqueZip).mockResolvedValue(EMPTY_EMARQUE_DATA);
    const documentUpdates: Array<{ id: string; patch: unknown }> = [];
    const matchUpdates: Array<{ id: string; patch: unknown }> = [];

    const supabase = makeFakeSupabase({
      pendingDocs: [
        { id: "doc-a", club_id: "club-a", match_id: "match-a1", filename: "a.zip", storage_path: "a.zip", sha256: "hash-a" },
        { id: "doc-b", club_id: "club-b", match_id: "match-b1", filename: "b.zip", storage_path: "b.zip", sha256: "hash-b" },
      ],
      matchesById: {
        "match-a1": { numero: "1", score_home: null, score_away: null },
        "match-b1": { numero: "2", score_home: null, score_away: null },
      },
      documentUpdates,
      matchUpdates,
    });

    const result = await parseDownloadedEmarqueDocuments(supabase);

    expect(result.imported).toBe(2);
    expect(persistEmarqueMatchData).toHaveBeenCalledWith(supabase, expect.objectContaining({ clubId: "club-a", matchId: "match-a1" }));
    expect(persistEmarqueMatchData).toHaveBeenCalledWith(supabase, expect.objectContaining({ clubId: "club-b", matchId: "match-b1" }));
  });
});
