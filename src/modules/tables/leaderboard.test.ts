import { describe, expect, it } from "vitest";
import { rankTableLeaderboard, type LeaderboardPerson } from "./leaderboard.js";

const person = (id: string, lastName: string, photoUrl: string | null = null): [string, LeaderboardPerson] => [id, { id, firstName: "P", lastName, photoUrl }];

describe("rankTableLeaderboard", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const seasonStart = new Date("2026-08-01T00:00:00Z");
  const people = new Map([person("a", "Alpha", "https://example.test/a.webp"), person("b", "Bravo"), person("c", "Charlie"), person("d", "Delta")]);

  it("classe par tables TENUES, ex æquo au même rang, à venir et saison passée exclues du compte", () => {
    const result = rankTableLeaderboard(
      [
        { licencieId: "b", role: "SCORER", matchDatetime: "2026-10-01T10:00:00Z" },
        { licencieId: "b", role: "TIMEKEEPER", matchDatetime: "2026-10-02T10:00:00Z" },
        { licencieId: "a", role: "SCORER", matchDatetime: "2026-09-20T10:00:00Z" },
        { licencieId: "a", role: "SCORER", matchDatetime: "2026-09-27T10:00:00Z" },
        { licencieId: "a", role: "SCORER", matchDatetime: "2026-10-20T10:00:00Z" },
        { licencieId: "c", role: "REFEREE", matchDatetime: "2026-09-27T10:00:00Z" },
        { licencieId: "d", role: "SCORER", matchDatetime: "2026-05-01T10:00:00Z" },
        { licencieId: "inconnu", role: "SCORER", matchDatetime: "2026-09-27T10:00:00Z" },
      ],
      people,
      now,
      seasonStart,
    );

    expect(result.totalDone).toBe(5);
    expect(result.entries.map((e) => [e.rank, e.licencie.id, e.done, e.upcoming])).toEqual([
      [1, "a", 2, 1],
      [1, "b", 2, 0],
      [3, "c", 1, 0],
    ]);
    expect(result.entries[0]!.licencie.photoUrl).toBe("https://example.test/a.webp");
    expect(result.entries[1]!.byRole).toEqual([
      { role: "SCORER", count: 1 },
      { role: "TIMEKEEPER", count: 1 },
    ]);
  });

  it("personne sans table tenue : absente du classement", () => {
    const result = rankTableLeaderboard([{ licencieId: "a", role: "SCORER", matchDatetime: "2026-10-20T10:00:00Z" }], people, now, seasonStart);
    expect(result.entries).toEqual([]);
  });
});
