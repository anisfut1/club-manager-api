import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../storage/emarque-storage.js", () => ({
  deleteEmarqueFile: vi.fn(async () => undefined),
}));

import { deleteEmarqueFile } from "../../storage/emarque-storage.js";
import { deleteMatchesBeforeCurrentSeason, purgeAllStoredEmarqueDocuments } from "./maintenance.js";

/**
 * Retour du club, 2026-09-29 : "je veux juste l'interpréter... pas la
 * stocker" (purge rétroactive) et "focus saison 2026-2027" (suppression
 * définitive des saisons précédentes). Ces deux fonctions ne sont
 * JAMAIS testées au niveau route (platform_admin, pas de fake club-scopé
 * standard) — testées ici directement contre un fake Supabase minimal,
 * suffisant pour vérifier la logique (portée club, cascade FK implicite
 * via `.delete()`, idempotence de la purge), jamais l'isolation RLS réelle
 * (voir `supabase/tests/isolation_test.sql` pour ça).
 */

interface FakeDoc {
  id: string;
  club_id: string;
  storage_path: string;
  purged_at: string | null;
}

function makeFakeSupabaseForPurge(docs: FakeDoc[]) {
  const updates: Array<{ id: string; patch: unknown }> = [];
  const supabase = {
    from(table: string) {
      if (table !== "match_documents") throw new Error(`Table inattendue : ${table}`);
      return {
        select: (_cols?: string) => {
          const filters: { col: string; value: unknown }[] = [];
          const api = {
            is(col: string, value: null) {
              filters.push({ col, value });
              return api;
            },
            eq(col: string, value: unknown) {
              filters.push({ col, value });
              return api;
            },
            then(onFulfilled: (v: { data: FakeDoc[]; error: null }) => unknown) {
              const filtered = docs.filter((d) => filters.every((f) => (d as unknown as Record<string, unknown>)[f.col] === f.value));
              return Promise.resolve({ data: filtered, error: null }).then(onFulfilled);
            },
          };
          return api;
        },
        update: (patch: unknown) => ({
          eq: (_col: string, id: string) => {
            updates.push({ id, patch });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { supabase, updates };
}

describe("purgeAllStoredEmarqueDocuments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ne touche que les documents non déjà purgés (purged_at IS NULL) — idempotent, sûr à relancer", async () => {
    const { supabase, updates } = makeFakeSupabaseForPurge([
      { id: "doc-1", club_id: "club-a", storage_path: "a.zip", purged_at: null },
      { id: "doc-2", club_id: "club-a", storage_path: "b.zip", purged_at: "2026-09-01T00:00:00Z" },
    ]);

    const result = await purgeAllStoredEmarqueDocuments(supabase);

    expect(result).toEqual({ documentsExamined: 1, documentsPurged: 1, errors: 0 });
    expect(deleteEmarqueFile).toHaveBeenCalledTimes(1);
    expect(deleteEmarqueFile).toHaveBeenCalledWith(supabase, "a.zip");
    expect(updates).toEqual([{ id: "doc-1", patch: expect.objectContaining({ purged_at: expect.any(String) }) }]);
  });

  it("filtre par club quand clubId est fourni", async () => {
    const { supabase } = makeFakeSupabaseForPurge([
      { id: "doc-1", club_id: "club-a", storage_path: "a.zip", purged_at: null },
      { id: "doc-2", club_id: "club-b", storage_path: "b.zip", purged_at: null },
    ]);

    const result = await purgeAllStoredEmarqueDocuments(supabase, "club-a");

    expect(result).toEqual({ documentsExamined: 1, documentsPurged: 1, errors: 0 });
    expect(deleteEmarqueFile).toHaveBeenCalledWith(supabase, "a.zip");
  });

  it("une suppression Storage en échec est comptée en erreur, jamais fatale pour les autres documents", async () => {
    vi.mocked(deleteEmarqueFile).mockRejectedValueOnce(new Error("Storage indisponible")).mockResolvedValueOnce(undefined);
    const { supabase } = makeFakeSupabaseForPurge([
      { id: "doc-1", club_id: "club-a", storage_path: "a.zip", purged_at: null },
      { id: "doc-2", club_id: "club-a", storage_path: "b.zip", purged_at: null },
    ]);

    const result = await purgeAllStoredEmarqueDocuments(supabase);

    expect(result).toEqual({ documentsExamined: 2, documentsPurged: 1, errors: 1 });
  });
});

interface FakeMatch {
  id: string;
  club_id: string;
  match_datetime: string | null;
}

function makeFakeSupabaseForDelete(matches: FakeMatch[]) {
  let deleteFilters: { col: string; value: unknown }[] = [];
  const supabase = {
    from(table: string) {
      if (table !== "matches") throw new Error(`Table inattendue : ${table}`);
      return {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          const filters: { col: string; value: unknown }[] = [];
          const api = {
            eq(col: string, value: unknown) {
              filters.push({ col, value });
              return api;
            },
            lt(col: string, value: string) {
              filters.push({ col, value: "lt:" + value });
              return api;
            },
            then(onFulfilled: (v: { data: FakeMatch[] | null; error: null; count: number }) => unknown) {
              const clubId = filters.find((f) => f.col === "club_id")?.value;
              const cutoff = (filters.find((f) => f.col === "match_datetime")?.value as string)?.replace("lt:", "");
              const filtered = matches.filter((m) => m.club_id === clubId && m.match_datetime !== null && m.match_datetime < cutoff);
              return Promise.resolve({ data: opts?.head ? null : filtered, error: null, count: filtered.length }).then(onFulfilled);
            },
          };
          return api;
        },
        delete: () => {
          const filters: { col: string; value: unknown }[] = [];
          const api = {
            eq(col: string, value: unknown) {
              filters.push({ col, value });
              return api;
            },
            lt(col: string, value: string) {
              filters.push({ col, value: "lt:" + value });
              deleteFilters = filters;
              return Promise.resolve({ error: null });
            },
          };
          return api;
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { supabase, getDeleteFilters: () => deleteFilters };
}

describe("deleteMatchesBeforeCurrentSeason", () => {
  it("ne compte/supprime que les matchs du club demandé, avant le 1er août de la saison en cours, jamais les dates NULL", async () => {
    const { supabase, getDeleteFilters } = makeFakeSupabaseForDelete([
      { id: "match-old", club_id: "club-a", match_datetime: "2025-05-01T00:00:00.000Z" },
      { id: "match-current", club_id: "club-a", match_datetime: "2026-09-26T00:00:00.000Z" },
      { id: "match-no-date", club_id: "club-a", match_datetime: null },
      { id: "match-other-club", club_id: "club-b", match_datetime: "2024-01-01T00:00:00.000Z" },
    ]);

    const result = await deleteMatchesBeforeCurrentSeason(supabase, "club-a", new Date("2026-09-29T00:00:00Z"));

    expect(result.matchesDeleted).toBe(1);
    expect(result.seasonStart).toBe(new Date(2026, 7, 1).toISOString());
    expect(getDeleteFilters()).toContainEqual({ col: "club_id", value: "club-a" });
  });

  it("ne supprime rien s'il n'y a aucun match antérieur à la saison en cours", async () => {
    const { supabase, getDeleteFilters } = makeFakeSupabaseForDelete([{ id: "match-current", club_id: "club-a", match_datetime: "2026-09-26T00:00:00.000Z" }]);

    const result = await deleteMatchesBeforeCurrentSeason(supabase, "club-a", new Date("2026-09-29T00:00:00Z"));

    expect(result.matchesDeleted).toBe(0);
    expect(getDeleteFilters()).toEqual([]);
  });
});
