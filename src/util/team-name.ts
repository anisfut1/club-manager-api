/**
 * `teams.name` n'encode PAS toujours le sexe de façon fiable — demande du
 * club, 2026-09-28 : "on a SM1 et SF1 donc faut bien spécifier que c les
 * féminin là en l'occurence" (rencontre 9820, équipe "Seniors 1" affichée
 * SANS suffixe alors qu'une AUTRE équipe "Seniors 1 M" existe déjà :
 * ambigu, le suffixe absent ne veut pas dire "masculin par défaut").
 *
 * Root cause (voir migration `20260925100000_teams_gender_split_and_licencie_team.sql`,
 * docs/FFBB.md § "Douzième correctif") : avant le 2026-09-25, une équipe
 * masculine et féminine partageant la même catégorie/numéro fusionnaient
 * en UNE seule ligne `teams`. Le correctif a séparé les VRAIES équipes,
 * mais celle ayant le PLUS de matchs historiques a gardé le nom D'ORIGINE
 * sans suffixe — un pur hasard statistique, jamais une convention de sexe
 * fiable : le nom sans suffixe est le masculin dans une catégorie, le
 * féminin dans une autre.
 *
 * `teams.sexe` (`normalizeSexe()`, sync.ts — "M"/"F"/`null`, alimenté
 * directement par le champ FFBB `sexe` de chaque engagement) reste lui
 * FIABLE : utilisé ici pour ajouter un suffixe explicite quand `name` ne
 * le porte pas déjà, jamais pour deviner un nom depuis zéro. `null`
 * (sexe inconnu, mixte, ou jamais synchronisé) : `name` renvoyé tel quel,
 * jamais un suffixe inventé.
 */
export function formatTeamNameWithGender(name: string, sexe: "M" | "F" | null | undefined): string {
  if (sexe !== "M" && sexe !== "F") return name;

  const alreadyTaggedWithThisSexe = new RegExp(`(^|\\s)${sexe}$`).test(name.trim());
  if (alreadyTaggedWithThisSexe) return name;

  return `${name} (${sexe})`;
}
