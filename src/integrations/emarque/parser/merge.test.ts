import { describe, expect, it } from "vitest";
import type { EMarquePlayer } from "../types.js";
import type { ResumeRowResult } from "./parse-resume.js";
import { mergePlayersWithStats } from "./merge.js";

function buildPlayer(overrides: Partial<EMarquePlayer> = {}): EMarquePlayer {
  return {
    teamSide: "home",
    jerseyNumber: "6",
    lastName: "MARTIN",
    firstName: "Léo",
    licenseNumber: "OC123456",
    isCaptain: false,
    isStarter: null,
    confidence: 90,
    ...overrides,
  };
}

function buildStatRow(overrides: Partial<ResumeRowResult> = {}): ResumeRowResult {
  return {
    teamSide: "home",
    jerseyNumber: "6",
    lastName: null,
    firstName: null,
    isStarter: true,
    secondsPlayed: 1060,
    points: 12,
    shotsMade: 5,
    threePointsMade: 1,
    twoPointsInteriorMade: 1,
    twoPointsExteriorMade: 1,
    freeThrowsMade: 2,
    foulsCommitted: 1,
    ...overrides,
  };
}

describe("mergePlayersWithStats", () => {
  it("rapproche un joueur et sa ligne de statistiques par (équipe, maillot)", () => {
    const players = [buildPlayer()];
    const stats = [buildStatRow()];

    const { players: merged, playerStats } = mergePlayersWithStats(players, stats);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.isStarter).toBe(true);
    // L'identité (nom/licence) vient toujours de feuillematch, jamais de resume.
    expect(merged[0]?.lastName).toBe("MARTIN");
    expect(merged[0]?.licenseNumber).toBe("OC123456");
    // Pas de prénom lu côté "resume" ici (buildStatRow par défaut) : celui de "feuillematch" est conservé.
    expect(merged[0]?.firstName).toBe("Léo");

    expect(playerStats).toHaveLength(1);
    expect(playerStats[0]).toMatchObject({ teamSide: "home", jerseyNumber: "6", points: 12 });
  });

  it("ramène le prénom COMPLET de 'resume' par-dessus celui, abrégé à une lettre, de 'feuillematch' (demande du club, § 'Trente-cinquième déclenchement', docs/FBI.md) — jamais le reste de l'identité", () => {
    const players = [buildPlayer({ firstName: "L." })];
    const stats = [buildStatRow({ firstName: "Léo" })];

    const { players: merged } = mergePlayersWithStats(players, stats);

    expect(merged[0]?.firstName).toBe("Léo");
    expect(merged[0]?.lastName).toBe("MARTIN"); // jamais écrasé par resume
  });

  it("ne rapproche jamais deux joueurs de côtés différents portant le même numéro de maillot", () => {
    const players = [buildPlayer({ teamSide: "home", jerseyNumber: "4" }), buildPlayer({ teamSide: "away", jerseyNumber: "4" })];
    const stats = [buildStatRow({ teamSide: "away", jerseyNumber: "4", points: 20 })];

    const { players: merged } = mergePlayersWithStats(players, stats);

    const home = merged.find((p) => p.teamSide === "home");
    const away = merged.find((p) => p.teamSide === "away");
    expect(home?.isStarter).toBeNull();
    expect(away?.isStarter).toBe(true);
  });

  it("laisse isStarter à null quand aucune ligne de statistiques ne correspond au joueur", () => {
    const players = [buildPlayer({ jerseyNumber: "99" })];
    const stats = [buildStatRow({ jerseyNumber: "6" })];

    const { players: merged } = mergePlayersWithStats(players, stats);

    expect(merged.find((p) => p.jerseyNumber === "99")?.isStarter).toBeNull();
  });

  it("synthétise un joueur minimal à partir de la ligne 'resume' quand l'effectif 'feuillematch' n'a pas ce maillot (régression production n°1481, § 'Trente-deuxième déclenchement', docs/FBI.md : sans ce joueur synthétisé, persist-emarque-match.ts#insertPlayerStats n'a aucun participant à quoi rattacher la statistique et l'ignore silencieusement — le joueur disparaît entièrement de l'affichage malgré des statistiques lues correctement)", () => {
    const stats = [buildStatRow({ jerseyNumber: "77", lastName: "NOUVEAU", firstName: "Joueur", isStarter: true })];

    const { players: merged, playerStats } = mergePlayersWithStats([], stats);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      teamSide: "home",
      jerseyNumber: "77",
      lastName: "NOUVEAU",
      firstName: "Joueur",
      isStarter: true,
      // Jamais de licence inventée : seule une vraie correspondance de
      // numéro de licence (jamais lue par "resume") relie un participant
      // à un licencié existant (ARCHITECTURE.md §22/§26).
      licenseNumber: null,
      isCaptain: false,
    });

    expect(playerStats).toHaveLength(1);
    expect(playerStats[0]?.jerseyNumber).toBe("77");
  });

  it("ne synthétise jamais de doublon quand le joueur existe déjà côté feuillematch", () => {
    const players = [buildPlayer({ jerseyNumber: "6" })];
    const stats = [buildStatRow({ jerseyNumber: "6" })];

    const { players: merged } = mergePlayersWithStats(players, stats);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.lastName).toBe("MARTIN");
  });

  it("rapproche par nom de famille (jamais de doublon) un joueur 'feuillematch' dont SEUL le maillot est illisible — régression production n°1481, § 'Trente-troisième déclenchement', docs/FBI.md : \"COUIX L. Ô\" (maillot illisible, mais licence VT640539 et capitanat lus correctement) et la ligne 'resume' \"COUIX\" (maillot 8 lisible, aucune licence) désignent la MÊME personne, produisaient pourtant deux lignes distinctes (donc \"#?\" affiché côté UI en plus d'une ligne correcte)", () => {
    const players = [buildPlayer({ jerseyNumber: null, lastName: "COUIX L. Ô", firstName: "LE", licenseNumber: "VT640539", isCaptain: true })];
    const stats = [buildStatRow({ jerseyNumber: "8", lastName: "COUIX", firstName: "Laetitia", isStarter: true })];

    const { players: merged, playerStats } = mergePlayersWithStats(players, stats);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      jerseyNumber: "8", // comblé depuis "resume", seule donnée que "feuillematch" n'avait pas lue
      isStarter: true, // idem
      // Identité lue proprement sur "resume" (retour du club, 2026-10-06) ;
      // la licence et le capitanat restent ceux de "feuillematch".
      lastName: "COUIX",
      // Le prénom, lui, est ramené COMPLET depuis "resume" (§ "Trente-cinquième déclenchement").
      firstName: "Laetitia",
      licenseNumber: "VT640539",
      isCaptain: true,
    });
    expect(playerStats).toHaveLength(1);
  });

  it(
    "rapproche par nom de famille (jamais de doublon) un joueur 'feuillematch' dont le maillot EST lu, quand 'resume' a mal lu LE SIEN — régression production n°1481, § 'Trente-cinquième déclenchement', docs/FBI.md : \"MESTRES J.\" maillot 11 (lu correctement par 'feuillematch', licence JN870663) vs. la ligne 'resume' \"MESTRES\" maillot '1' (confusion OCR sur le chiffre répété '11'→'1') ne se rapprochaient jamais par maillot exact — la ligne 'resume' restait synthétisée en un DEUXIÈME participant fantôme (sans licence), qui récupérait les VRAIES statistiques à la place du participant licencié",
    () => {
      const players = [buildPlayer({ jerseyNumber: "11", lastName: "MESTRES", firstName: "J.", licenseNumber: "JN870663" })];
      const stats = [buildStatRow({ jerseyNumber: "1", lastName: "MESTRES", firstName: "Julie", points: 28, isStarter: true })];

      const { players: merged, playerStats } = mergePlayersWithStats(players, stats);

      // Un seul participant, jamais un fantôme en plus.
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({
        jerseyNumber: "11", // celui de "feuillematch", JAMAIS remplacé par le "1" erroné de "resume"
        lastName: "MESTRES",
        firstName: "Julie", // prénom complet ramené de "resume"
        licenseNumber: "JN870663", // jamais perdue au profit d'un fantôme sans licence
        isStarter: true,
      });

      // La statistique doit être réindexée sous le maillot FINAL (11), sans
      // quoi persist-emarque-match.ts#insertPlayerStats ne retrouverait plus
      // le participant (qui n'a jamais eu de maillot "1") et l'ignorerait
      // silencieusement — régression du "Trente-deuxième déclenchement".
      expect(playerStats).toHaveLength(1);
      expect(playerStats[0]).toMatchObject({ teamSide: "home", jerseyNumber: "11", points: 28 });
    },
  );

  it("ne rapproche jamais par nom de famille en cas d'ambiguïté (plusieurs candidats possibles) — synthétise plutôt un doublon que de deviner", () => {
    const players = [buildPlayer({ jerseyNumber: null, lastName: "MARTIN X.", firstName: "?" })];
    const stats = [
      buildStatRow({ jerseyNumber: "6", lastName: "MARTIN", firstName: "Alex" }),
      buildStatRow({ jerseyNumber: "7", lastName: "MARTIN", firstName: "Sacha" }),
    ];

    const { players: merged } = mergePlayersWithStats(players, stats);

    const feuillematchPlayer = merged.find((p) => p.lastName === "MARTIN X.");
    expect(feuillematchPlayer?.jerseyNumber).toBeNull();
    // Les deux lignes "resume" restent synthétisées séparément, jamais fusionnées au hasard.
    expect(merged).toHaveLength(3);
  });

  it("ne transforme jamais une statistique absente en zéro (null != 0)", () => {
    const players = [buildPlayer()];
    const stats = [buildStatRow({ points: null, threePointsMade: null, secondsPlayed: null })];

    const { playerStats } = mergePlayersWithStats(players, stats);

    expect(playerStats[0]?.points).toBeNull();
    expect(playerStats[0]?.threePointsMade).toBeNull();
    expect(playerStats[0]?.secondsPlayed).toBeNull();
  });

  it("rapproche par NOM avant le maillot : les maillots mal lus par 'feuillematch' ne collent plus les statistiques au mauvais joueur — régression production n°2645 (retour du club, 2026-10-06 : stats de SALEM Sanaa affichées sous « Sanaa SCHNEIDER »)", () => {
    const sheet = (jerseyNumber: string | null, lastName: string, firstName: string | null, licenseNumber: string, isCaptain = false) =>
      buildPlayer({ teamSide: "away", jerseyNumber, lastName, firstName, licenseNumber, isCaptain });
    const players = [
      sheet(null, "HNAWIA", "S.", "VT830247"),
      sheet(null, "SALEMS.", null, "VT073742"),
      sheet("10", "SCHNEIDER", "T.", "VT024679"),
      sheet("1", "MEHENNIS.", null, "VT041580"),
      sheet("2", "HEDDOUCHE I.", null, "VT890617", true),
      sheet("5", "CHAUSSINAND MOHAMM...", null, "VT026669"),
    ];
    const row = (jerseyNumber: string, lastName: string, firstName: string, points: number) => buildStatRow({ teamSide: "away", jerseyNumber, lastName, firstName, points });
    const stats = [
      row("5", "HNAWIA", "Sebastien", 6),
      row("8", "SCHNEIDER", "Theo", 4),
      row("9", "MEHENNI", "Selyan", 3),
      row("10", "SALEM", "Sanaa", 0),
      row("15", "CHAUSSINAND MOHAMMED", "Louis", 3),
      row("22", "HEDDOUCHE", "Icheme", 8),
    ];

    const { players: merged, playerStats } = mergePlayersWithStats(players, stats);

    expect(merged).toHaveLength(6);
    const byJersey = Object.fromEntries(merged.map((p) => [p.jerseyNumber, `${p.lastName} ${p.firstName} ${p.licenseNumber}${p.isCaptain ? " (CAP)" : ""}`]));
    expect(byJersey).toEqual({
      "5": "HNAWIA Sebastien VT830247",
      "8": "SCHNEIDER Theo VT024679",
      "9": "MEHENNI Selyan VT041580",
      "10": "SALEM Sanaa VT073742",
      "15": "CHAUSSINAND MOHAMMED Louis VT026669",
      "22": "HEDDOUCHE Icheme VT890617 (CAP)",
    });
    expect(Object.fromEntries(playerStats.map((s) => [s.jerseyNumber, s.points]))).toEqual({ "5": 6, "8": 4, "9": 3, "10": 0, "15": 3, "22": 8 });
  });

  it("ne rapproche jamais par maillot deux noms lus qui se contredisent", () => {
    const players = [buildPlayer({ jerseyNumber: "10", lastName: "SCHNEIDER", licenseNumber: "VT024679" })];
    const stats = [buildStatRow({ jerseyNumber: "10", lastName: "SALEM", firstName: "Sanaa" })];

    const { players: merged } = mergePlayersWithStats(players, stats);

    expect(merged.find((p) => p.lastName === "SALEM")).toMatchObject({ jerseyNumber: "10", licenseNumber: null });
    // Le joueur de "feuillematch" est conservé, sans maillot (déjà porté par SALEM) pour ne jamais capter ses statistiques.
    expect(merged.find((p) => p.lastName === "SCHNEIDER")).toMatchObject({ jerseyNumber: null, licenseNumber: "VT024679" });
  });
});
