import { describe, expect, it } from "vitest";
import { reapOrphanedRunningSyncRuns } from "./sync.js";

/**
 * Un run "running" jamais clôturé (kill dur du processus avant la mise à
 * jour finale, voir sync.ts) doit être requalifié en "error" — sinon
 * /admin/sync affiche une synchronisation bloquée pour toujours (constaté
 * en production, voir docs/FFBB.md).
 */
describe("reapOrphanedRunningSyncRuns", () => {
  it("clôture en 'error' les sync_runs FFBB 'running' de CE club, jamais ceux d'un autre club/provider", async () => {
    const updates: { patch: Record<string, unknown>; filters: [string, unknown][] }[] = [];

    const supabase = {
      from(table: string) {
        expect(table).toBe("sync_runs");
        return {
          update: (patch: Record<string, unknown>) => {
            const filters: [string, unknown][] = [];
            const chain = {
              eq(col: string, value: unknown) {
                filters.push([col, value]);
                return chain;
              },
              then(onFulfilled: (value: { error: null }) => unknown) {
                updates.push({ patch, filters });
                return Promise.resolve({ error: null }).then(onFulfilled);
              },
            };
            return chain;
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await reapOrphanedRunningSyncRuns(supabase, "club-1");

    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch.status).toBe("error");
    expect(typeof updates[0]!.patch.finished_at).toBe("string");
    expect(updates[0]!.filters).toEqual([
      ["club_id", "club-1"],
      ["provider", "ffbb"],
      ["status", "running"],
    ]);
  });

  it("ne lève jamais si la mise à jour échoue (nettoyage best-effort, ne doit jamais bloquer la synchronisation)", async () => {
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: { message: "boom" } }),
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(reapOrphanedRunningSyncRuns(supabase, "club-1")).resolves.toBeUndefined();
  });
});
