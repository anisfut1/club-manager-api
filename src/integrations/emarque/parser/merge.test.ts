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

    expect(merged[0]?.isStarter).toBeNull();
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
      // Le nom de famille, la licence et le capitanat restent ceux de "feuillematch", jamais écrasés.
      lastName: "COUIX L. Ô",
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
});
