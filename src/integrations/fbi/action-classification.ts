/**
 * FBI est une application Java historique où des actions de LECTURE
 * peuvent légitimement passer par POST (recherche, export, génération de
 * document...). Bloquer systématiquement tout POST — comme le faisait le
 * spike par précaution — empêcherait l'automatisation de fonctionner.
 *
 * Ce module classe une action FBI (déduite de son URL, typiquement
 * `nomAction.fbi`) en READ_ONLY / WRITE / UNKNOWN à partir de motifs de
 * verbes. Le doute profite toujours à la prudence : une action qui
 * correspond à un motif WRITE l'emporte sur un motif READ_ONLY, et une
 * action qui ne correspond à AUCUN motif connu est UNKNOWN — jamais
 * appelée automatiquement par FbiProvider (voir README §6 du brief SaaS).
 *
 * Nouvelle action FBI rencontrée en pratique : l'ajouter ici plutôt que de
 * contourner la classification ailleurs dans le code.
 */

export type FbiActionClassification = "READ_ONLY" | "WRITE" | "UNKNOWN";

const READ_ONLY_PATTERNS: RegExp[] = [
  /^afficher/i,
  /^rechercher/i,
  /^chercher/i,
  /^recherche/i,
  /^lister/i,
  /^liste/i,
  /^consulter/i,
  /^voir/i,
  /^visualiser/i,
  /^filtrer/i,
  /^paginer/i,
  /^exporter/i,
  /^export/i,
  /^generer/i,
  /^generate/i,
  /^telecharger/i,
  /^download/i,
  /^imprimer/i,
  /^print/i,
  /^search/i,
  /^list/i,
  /^view/i,
  /^display/i,
  /^get[A-Z]/,
];

const WRITE_PATTERNS: RegExp[] = [
  /^enregistrer/i,
  /^sauvegarder/i,
  /^valider/i,
  /^modifier/i,
  /^editer/i,
  /^supprimer/i,
  /^effacer/i,
  /^creer/i,
  /^ajouter/i,
  /^envoyer/i,
  /^soumettre/i,
  /^accepter/i,
  /^refuser/i,
  /^annuler/i,
  /^confirmer/i,
  /^save/i,
  /^update/i,
  /^delete/i,
  /^remove/i,
  /^create/i,
  /^submit/i,
  /^send/i,
  /^accept/i,
  /^reject/i,
  /^cancel/i,
  /^insert/i,
  /^post[A-Z]/,
];

/** Extrait le nom d'action d'une URL FBI (ex: "afficherLicenceStatistiqueAjax.fbi" -> "afficherLicenceStatistiqueAjax"). */
export function extractFbiActionName(url: string): string {
  const withoutQuery = url.split("?")[0] ?? url;
  const segments = withoutQuery.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  return last.replace(/\.(fbi|do|action|jsp|jspx)$/i, "");
}

/**
 * Classe une action FBI. Le motif WRITE est vérifié en premier : en cas
 * d'ambiguïté (l'action correspondrait aux deux), on considère qu'elle
 * écrit — jamais l'inverse.
 */
export function classifyFbiAction(url: string): FbiActionClassification {
  const action = extractFbiActionName(url);
  if (!action) return "UNKNOWN";

  if (WRITE_PATTERNS.some((pattern) => pattern.test(action))) return "WRITE";
  if (READ_ONLY_PATTERNS.some((pattern) => pattern.test(action))) return "READ_ONLY";
  return "UNKNOWN";
}

/**
 * Une requête FBI est autorisée dans FbiProvider (strictement read-only,
 * voir ARCHITECTURE.md) si sa méthode est intrinsèquement sûre (GET/HEAD/
 * OPTIONS) OU si son action est classée READ_ONLY. Toute action UNKNOWN
 * ou WRITE est refusée — jamais appelée automatiquement.
 */
export function isFbiRequestAllowed(method: string, url: string): boolean {
  const upperMethod = method.toUpperCase();
  if (upperMethod === "GET" || upperMethod === "HEAD" || upperMethod === "OPTIONS") return true;
  return classifyFbiAction(url) === "READ_ONLY";
}
