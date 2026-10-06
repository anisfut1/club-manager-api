import { describe, expect, it } from "vitest";
import type { EMarqueMatchData } from "../types.js";
import { persistEmarqueMatchData } from "./persist-emarque-match.js";

function buildData(overrides: Partial<EMarqueMatchData> = {}): EMarqueMatchData {
  return {
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
    ...overrides,
  };
}

interface FakeSupabaseOptions {
  existingImport?: { id: string; status: string; parser_version: string } | null;
  licenciesByLicense?: Record<string, string[]>;
  /** Licenciés du club (rattachement par nom, voir `findLicencieIdByName`). */
  licenciesByName?: { id: string; first_name: string; last_name: string }[];
  failOnTable?: string;
  /** `matches.is_home` pour BASE_PARAMS.matchId — `undefined`/absent = non renseigné (jamais une supposition, voir persist-emarque-match.ts). */
  isHome?: boolean;
  /** `matches.team_id` pour BASE_PARAMS.matchId — transmis à l'auto-provisionnement (docs/TEAMS.md). */
  teamId?: string;
  /** Simule une course avec un autre import (23505) sur LE PROCHAIN insert dans `licencies` uniquement. */
  licenciesInsertConflict?: boolean;
}

function makeFakeSupabase(options: FakeSupabaseOptions = {}) {
  const inserted: Record<string, unknown[]> = {};
  const updated: Record<string, { id: string; payload: unknown }[]> = {};
  const deleted: Record<string, { col: string; value: unknown }[][]> = {};
  let participantCounter = 0;
  let importCounter = 0;
  let licencieCounter = 0;
  let licenciesInsertConflictPending = options.licenciesInsertConflict ?? false;

  const fail = (table: string) => options.failOnTable === table;

  function deletable(table: string) {
    const filters: { col: string; value: unknown }[] = [];
    const api = {
      eq(col: string, value: unknown) {
        filters.push({ col, value });
        return api;
      },
      then(onFulfilled: (v: { error: null }) => unknown) {
        (deleted[table] ??= []).push(filters);
        return Promise.resolve({ error: null }).then(onFulfilled);
      },
    };
    return api;
  }

  const supabase = {
    _inserted: inserted,
    _updated: updated,
    _deleted: deleted,
    from(table: string) {
      switch (table) {
        case "emarque_imports":
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: options.existingImport ?? null, error: null }),
                }),
              }),
            }),
            insert: (payload: unknown) => ({
              select: () => ({
                single: () => {
                  importCounter += 1;
                  (inserted[table] ??= []).push(payload);
                  return Promise.resolve({ data: { id: `import-${importCounter}` }, error: null });
                },
              }),
            }),
            update: (payload: unknown) => ({
              eq: (_col: string, id: string) => {
                (updated[table] ??= []).push({ id, payload });
                return Promise.resolve({ error: null });
              },
            }),
            delete: () => deletable(table),
          };
        case "licencies":
          return {
            select: () => ({
              eq: () => ({
                eq: (_col: string, license: string) => {
                  const ids = options.licenciesByLicense?.[license] ?? [];
                  return Promise.resolve({ data: ids.map((id) => ({ id })), error: null });
                },
                then: (onFulfilled: (v: { data: unknown[]; error: null }) => unknown) =>
                  Promise.resolve({ data: options.licenciesByName ?? [], error: null }).then(onFulfilled),
              }),
            }),
            insert: (payload: unknown) => ({
              select: () => ({
                single: () => {
                  if (licenciesInsertConflictPending) {
                    licenciesInsertConflictPending = false;
                    return Promise.resolve({ data: null, error: { code: "23505", message: "conflit (test)" } });
                  }
                  if (fail(table)) return Promise.resolve({ data: null, error: { code: "XXXXX", message: "insertion échouée (test)" } });
                  licencieCounter += 1;
                  (inserted[table] ??= []).push(payload);
                  return Promise.resolve({ data: { id: `licencie-auto-${licencieCounter}` }, error: null });
                },
              }),
            }),
          };
        case "match_participants":
          return {
            insert: (payload: unknown) => ({
              select: () => ({
                single: () => {
                  if (fail(table)) return Promise.resolve({ data: null, error: { message: "insertion échouée (test)" } });
                  participantCounter += 1;
                  (inserted[table] ??= []).push(payload);
                  return Promise.resolve({ data: { id: `participant-${participantCounter}` }, error: null });
                },
              }),
            }),
            delete: () => deletable(table),
          };
        case "player_match_stats":
        case "match_coaches":
        case "match_officials":
        case "match_table_officials":
          return {
            insert: (payload: unknown) => {
              if (fail(table)) return Promise.resolve({ error: { message: "insertion échouée (test)" } });
              (inserted[table] ??= []).push(payload);
              return Promise.resolve({ error: null });
            },
            delete: () => deletable(table),
          };
        case "matches":
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { is_home: options.isHome ?? null, team_id: options.teamId ?? null }, error: null }),
              }),
            }),
            update: (payload: unknown) => ({
              eq: (_col: string, id: string) => {
                (updated[table] ??= []).push({ id, payload });
                return Promise.resolve({ error: null });
              },
            }),
          };
        default:
          throw new Error(`Table inattendue dans le fake Supabase de test : ${table}`);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return supabase;
}

const BASE_PARAMS = {
  matchId: "match-1",
  clubId: "club-1",
  fileHash: "a".repeat(64),
  sourceFileName: "2813.zip",
  storagePath: "private/emarque/2025-2026/match-1/original.zip",
  parserVersion: "test-version",
};

describe("persistEmarqueMatchData", () => {
  it("ne retraite rien quand un import avec le même hash existe déjà (idempotence)", async () => {
    const supabase = makeFakeSupabase({ existingImport: { id: "import-existing", status: "imported", parser_version: "test-version" } });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data: buildData() });

    expect(result).toEqual({
      importId: "import-existing",
      status: "imported",
      alreadyImported: true,
      participantsLinked: 0,
      participantsUnlinked: 0,
    });
    expect(supabase._inserted.match_participants).toBeUndefined();
    expect(supabase._inserted.emarque_imports).toBeUndefined();
  });

  it("remplace la lecture d'un même fichier faite par une version plus ancienne du parseur", async () => {
    const supabase = makeFakeSupabase({ existingImport: { id: "import-old", status: "imported", parser_version: "old-version" }, licenciesByLicense: { OC123456: ["licencie-1"] } });
    const data = buildData({
      players: [{ teamSide: "home", jerseyNumber: "6", lastName: "DUPONT", firstName: "J.", licenseNumber: "OC123456", isCaptain: false, isStarter: null, confidence: 0.9 }],
    });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.alreadyImported).toBe(false);
    expect(result.participantsLinked).toBe(1);
    expect(supabase._deleted.emarque_imports).toEqual([[{ col: "id", value: "import-old" }]]);
    for (const table of ["match_participants", "match_coaches", "match_officials", "match_table_officials", "player_match_stats"]) {
      expect(supabase._deleted[table]?.[0]).toEqual([
        { col: "match_id", value: "match-1" },
        { col: "club_id", value: "club-1" },
      ]);
    }
    expect(supabase._inserted.emarque_imports).toHaveLength(1);
  });

  describe("rattachement par nom quand la licence n'a pas pu être lue (joueur du club uniquement)", () => {
    const unreadPlayer = (lastName: string, firstName: string, teamSide: "home" | "away" = "home") => ({
      teamSide,
      jerseyNumber: "9",
      lastName,
      firstName,
      licenseNumber: null,
      isCaptain: false,
      isStarter: null,
      confidence: 0.9,
    });

    it("rattache au seul licencié du club portant exactement ce nom et ce prénom (accents, casse et confusion l/I tolérés)", async () => {
      const supabase = makeFakeSupabase({
        isHome: true,
        licenciesByName: [
          { id: "lic-ilyes", last_name: "Morsli", first_name: "Ilyes" },
          { id: "lic-kenzo", last_name: "Morsli", first_name: "Kenzo" },
        ],
      });

      const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data: buildData({ players: [unreadPlayer("MORSLI", "llyes")] }) });

      expect(result.participantsLinked).toBe(1);
      expect(supabase._inserted.match_participants[0]).toMatchObject({ licencie_id: "lic-ilyes", license_number: null });
      expect(supabase._inserted.licencies).toBeUndefined();
    });

    it("ne rattache jamais en cas d'homonymes", async () => {
      const supabase = makeFakeSupabase({
        isHome: true,
        licenciesByName: [
          { id: "lic-1", last_name: "Dubois", first_name: "Liam" },
          { id: "lic-2", last_name: "DUBOIS", first_name: "Liam" },
        ],
      });

      const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data: buildData({ players: [unreadPlayer("Dubois", "Liam")] }) });

      expect(result.participantsLinked).toBe(0);
      expect(supabase._inserted.match_participants[0]).toMatchObject({ licencie_id: null });
    });

    it("ne rattache jamais sur une initiale seule ni pour l'équipe adverse", async () => {
      const supabase = makeFakeSupabase({
        isHome: true,
        licenciesByName: [{ id: "lic-1", last_name: "Rivet", first_name: "Macéo" }],
      });

      const result = await persistEmarqueMatchData(supabase, {
        ...BASE_PARAMS,
        data: buildData({ players: [unreadPlayer("Rivet", "M."), { ...unreadPlayer("Rivet", "Macéo", "away"), jerseyNumber: "4" }] }),
      });

      expect(result.participantsLinked).toBe(0);
    });
  });

  it("lie automatiquement un participant dont la licence correspond exactement à un licencié existant", async () => {
    const supabase = makeFakeSupabase({ licenciesByLicense: { OC123456: ["licencie-1"] } });
    const data = buildData({
      players: [
        {
          teamSide: "home",
          jerseyNumber: "6",
          lastName: "MARTIN",
          firstName: "Léo",
          licenseNumber: "OC123456",
          isCaptain: false,
          isStarter: null,
          confidence: 90,
        },
      ],
    });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.participantsLinked).toBe(1);
    expect(result.participantsUnlinked).toBe(0);
    expect(supabase._inserted.match_participants[0]).toMatchObject({ licencie_id: "licencie-1", license_number: "OC123456" });
  });

  it("ne lie jamais un participant en cas de licence ambiguë (plusieurs licenciés pour le même numéro)", async () => {
    const supabase = makeFakeSupabase({ licenciesByLicense: { OC123456: ["licencie-1", "licencie-2"] } });
    const data = buildData({
      players: [
        {
          teamSide: "home",
          jerseyNumber: "6",
          lastName: "MARTIN",
          firstName: "Léo",
          licenseNumber: "OC123456",
          isCaptain: false,
          isStarter: null,
          confidence: 90,
        },
      ],
    });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.participantsLinked).toBe(0);
    expect(result.participantsUnlinked).toBe(1);
    expect(supabase._inserted.match_participants[0]).toMatchObject({ licencie_id: null });
  });

  it("ne lie jamais un participant sans licence lue (rien à comparer)", async () => {
    const supabase = makeFakeSupabase();
    const data = buildData({
      players: [
        {
          teamSide: "home",
          jerseyNumber: "7",
          lastName: null,
          firstName: null,
          licenseNumber: null,
          isCaptain: false,
          isStarter: null,
          confidence: 40,
        },
      ],
    });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.participantsUnlinked).toBe(1);
    expect(supabase._inserted.match_participants[0]).toMatchObject({ licencie_id: null });
  });

  it("marque l'import 'imported' quand aucun avertissement qualité de sévérité error n'est présent", async () => {
    const supabase = makeFakeSupabase();
    const data = buildData({ quality: { warnings: [{ code: "PLAYER_LICENSE_MISSING", message: "test", severity: "warning" }], overallConfidence: 70 } });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.status).toBe("imported");
    expect(supabase._updated.matches).toContainEqual({ id: "match-1", payload: { emarque_status: "imported" } });
  });

  it("marque l'import 'needs_review' dès qu'un avertissement qualité de sévérité error est présent", async () => {
    const supabase = makeFakeSupabase();
    const data = buildData({ quality: { warnings: [{ code: "SCORE_MISMATCH", message: "test", severity: "error" }], overallConfidence: 70 } });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.status).toBe("needs_review");
    expect(supabase._updated.matches).toContainEqual({ id: "match-1", payload: { emarque_status: "needs_review" } });
  });

  it("associe correctement les statistiques au bon participant (jointure par équipe + maillot)", async () => {
    const supabase = makeFakeSupabase();
    const data = buildData({
      players: [
        {
          teamSide: "home",
          jerseyNumber: "6",
          lastName: "MARTIN",
          firstName: "Léo",
          licenseNumber: null,
          isCaptain: false,
          isStarter: null,
          confidence: 90,
        },
      ],
      playerStats: [
        {
          teamSide: "home",
          jerseyNumber: "6",
          lastName: null,
          firstName: null,
          secondsPlayed: 1060,
          points: 12,
          shotsMade: 5,
          threePointsMade: 1,
          twoPointsInteriorMade: 1,
          twoPointsExteriorMade: 1,
          freeThrowsMade: 2,
          foulsCommitted: 1,
        },
      ],
    });

    await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(supabase._inserted.player_match_stats[0]).toMatchObject({ participant_id: "participant-1", points: 12 });
  });

  it("ignore une ligne de statistiques sans participant correspondant, sans faire échouer l'import", async () => {
    const supabase = makeFakeSupabase();
    const data = buildData({
      playerStats: [
        {
          teamSide: "away",
          jerseyNumber: "99",
          lastName: null,
          firstName: null,
          secondsPlayed: 100,
          points: 4,
          shotsMade: 2,
          threePointsMade: 0,
          twoPointsInteriorMade: 2,
          twoPointsExteriorMade: 0,
          freeThrowsMade: 0,
          foulsCommitted: 0,
        },
      ],
    });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.status).toBe("imported");
    expect(supabase._inserted.player_match_stats).toBeUndefined();
  });

  it("marque l'import et le match en erreur et relance l'exception si une écriture échoue", async () => {
    const supabase = makeFakeSupabase({ failOnTable: "match_participants" });
    const data = buildData({
      players: [
        {
          teamSide: "home",
          jerseyNumber: "6",
          lastName: "MARTIN",
          firstName: "Léo",
          licenseNumber: null,
          isCaptain: false,
          isStarter: null,
          confidence: 90,
        },
      ],
    });

    await expect(persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data })).rejects.toThrow();

    expect(supabase._updated.emarque_imports).toContainEqual({
      id: "import-1",
      payload: expect.objectContaining({ status: "error", last_error: expect.any(String) }),
    });
    expect(supabase._updated.matches).toContainEqual({ id: "match-1", payload: { emarque_status: "error" } });
  });

  it("retour du club, 2026-09-29 (\"ça s'est importé auto mais ça a pas tout bien importé\") : nettoie les données PARTIELLES déjà écrites avant l'échec, un match en erreur n'affiche plus jamais une composition/des stats incomplètes", async () => {
    const supabase = makeFakeSupabase({ failOnTable: "match_coaches" });
    const data = buildData({
      players: [
        { teamSide: "home", jerseyNumber: "6", lastName: "MARTIN", firstName: "Léo", licenseNumber: null, isCaptain: false, isStarter: null, confidence: 90 },
      ],
      coaches: [{ teamSide: "home", role: "principal", lastName: "COACH", firstName: "C.", licenseNumber: null }],
    });

    await expect(persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data })).rejects.toThrow();

    // Le participant a bien été écrit AVANT l'échec (sur match_coaches) —
    // exactement le scénario "composition partielle" observé en production.
    expect(supabase._inserted.match_participants).toHaveLength(1);
    // Nettoyé après coup : un DELETE a bien été émis sur les 5 tables de
    // données dérivées, scopé au bon match/club (jamais un autre match).
    for (const table of ["match_participants", "match_coaches", "match_officials", "match_table_officials", "player_match_stats"]) {
      expect(supabase._deleted[table]).toContainEqual([
        { col: "match_id", value: "match-1" },
        { col: "club_id", value: "club-1" },
      ]);
    }
  });
});

describe("persistEmarqueMatchData — résilience aux doublons de statistiques (retour du club, 2026-09-29)", () => {
  it("ignore une ligne de statistiques en double (même participant déjà servi) au lieu de faire échouer tout le match", async () => {
    const supabase = makeFakeSupabase();
    const data = buildData({
      players: [
        { teamSide: "away", jerseyNumber: "2", lastName: "ROCH", firstName: "Jonas", licenseNumber: null, isCaptain: false, isStarter: null, confidence: 90 },
      ],
      playerStats: [
        {
          teamSide: "away",
          jerseyNumber: "2",
          lastName: null,
          firstName: null,
          secondsPlayed: 1200,
          points: 9,
          shotsMade: 4,
          threePointsMade: 0,
          twoPointsInteriorMade: 3,
          twoPointsExteriorMade: 1,
          freeThrowsMade: 0,
          foulsCommitted: 0,
        },
        // Deuxième ligne "resume" résolue vers le MÊME participant (maillot
        // 2, extérieur) — le bug réel constaté (rencontre n°3, U13 M vs
        // Frontignan) : sans le correctif, la deuxième insertion crashait
        // sur la contrainte unique `player_match_stats_participant_id_key`
        // et faisait échouer TOUT l'import, y compris les 15 autres joueurs
        // par ailleurs correctement lus.
        {
          teamSide: "away",
          jerseyNumber: "2",
          lastName: null,
          firstName: null,
          secondsPlayed: 300,
          points: 2,
          shotsMade: 1,
          threePointsMade: 0,
          twoPointsInteriorMade: 1,
          twoPointsExteriorMade: 0,
          freeThrowsMade: 0,
          foulsCommitted: 0,
        },
      ],
    });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.status).toBe("imported");
    // Seule la PREMIÈRE ligne pour ce participant est conservée.
    expect(supabase._inserted.player_match_stats).toHaveLength(1);
    expect(supabase._inserted.player_match_stats[0]).toMatchObject({ participant_id: "participant-1", points: 9 });
  });
});

describe("persistEmarqueMatchData — auto-provisionnement des licenciés (demande du club, docs/LICENCIES.md)", () => {
  function buildHomePlayer(overrides: Partial<EMarqueMatchData["players"][number]> = {}): EMarqueMatchData["players"][number] {
    return {
      teamSide: "home",
      jerseyNumber: "11",
      lastName: "MESTRES",
      firstName: "Julie",
      licenseNumber: "JN870663",
      isCaptain: false,
      isStarter: null,
      confidence: 90,
      ...overrides,
    };
  }

  it("crée un licencié pour un·e joueur·se du CAMP DU CLUB (matches.is_home=true, teamSide='home') quand aucun licencié existant ne correspond déjà", async () => {
    const supabase = makeFakeSupabase({ isHome: true });
    const data = buildData({ players: [buildHomePlayer()] });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.participantsLinked).toBe(1);
    expect(supabase._inserted.licencies).toEqual([{ club_id: "club-1", first_name: "Julie", last_name: "MESTRES", license_number: "JN870663", team_id: null }]);
    expect(supabase._inserted.match_participants[0]).toMatchObject({ licencie_id: "licencie-auto-1" });
  });

  it("rattache le licencié nouvellement créé à l'équipe DU MATCH d'origine (matches.team_id) — demande du club de sectoriser le roster par équipe, docs/TEAMS.md", async () => {
    const supabase = makeFakeSupabase({ isHome: true, teamId: "team-u18-1" });
    const data = buildData({ players: [buildHomePlayer()] });

    await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(supabase._inserted.licencies[0]).toMatchObject({ team_id: "team-u18-1" });
  });

  it("n'auto-provisionne JAMAIS un licencié pour l'équipe ADVERSE, même avec un numéro de licence lu (scope explicite du club)", async () => {
    const supabase = makeFakeSupabase({ isHome: true });
    const data = buildData({ players: [buildHomePlayer({ teamSide: "away", lastName: "ADVERSAIRE" })] });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.participantsUnlinked).toBe(1);
    expect(supabase._inserted.licencies).toBeUndefined();
  });

  it("n'auto-provisionne jamais quand matches.is_home n'est pas renseigné (jamais une supposition sur quelle équipe est la nôtre)", async () => {
    const supabase = makeFakeSupabase(); // isHome absent -> null
    const data = buildData({ players: [buildHomePlayer()] });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.participantsUnlinked).toBe(1);
    expect(supabase._inserted.licencies).toBeUndefined();
  });

  it("n'auto-provisionne jamais un licencié dont le prénom ou le nom est illisible (jamais une identité devinée, ARCHITECTURE.md §22)", async () => {
    const supabase = makeFakeSupabase({ isHome: true });
    const data = buildData({ players: [buildHomePlayer({ firstName: null })] });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.participantsUnlinked).toBe(1);
    expect(supabase._inserted.licencies).toBeUndefined();
  });

  it("ne crée jamais de doublon en cas de course avec un autre import (23505) : retrouve le licencié déjà créé entre-temps", async () => {
    const supabase = makeFakeSupabase({ isHome: true, licenciesInsertConflict: true, licenciesByLicense: { JN870663: ["licencie-race-winner"] } });
    const data = buildData({ players: [buildHomePlayer()] });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.participantsLinked).toBe(1);
    expect(supabase._inserted.match_participants[0]).toMatchObject({ licencie_id: "licencie-race-winner" });
  });

  it("réutilise un licencié EXISTANT par numéro de licence plutôt que d'en créer un doublon, même côté club", async () => {
    const supabase = makeFakeSupabase({ isHome: true, licenciesByLicense: { JN870663: ["licencie-deja-la"] } });
    const data = buildData({ players: [buildHomePlayer()] });

    const result = await persistEmarqueMatchData(supabase, { ...BASE_PARAMS, data });

    expect(result.participantsLinked).toBe(1);
    expect(supabase._inserted.licencies).toBeUndefined();
    expect(supabase._inserted.match_participants[0]).toMatchObject({ licencie_id: "licencie-deja-la" });
  });
});
