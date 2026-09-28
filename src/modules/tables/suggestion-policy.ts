import type { TableAssignmentRole } from "../../db/types.js";

export type { TableAssignmentRole };

/**
 * Constantes centralisées du moteur de suggestion "Tables de marque"
 * (demande du club, 2026-09-28, §5/§23 : "centraliser cette constante...
 * ne disperse pas +2 hours dans le code" / "aucun +100/-20/+50 dispersé
 * dans plusieurs fichiers"). Tout poids/seuil du moteur vit ICI, jamais en
 * dur dans table-suggestion-service.ts ou les routes.
 */

/**
 * Durée d'occupation d'un match pour cette V1 (§5) : 15:00 → créneau
 * 15:00-17:00. Volontairement fixe (pas encore par compétition/catégorie)
 * — voir docs/TABLE_ASSIGNMENTS.md pour l'évolution possible.
 */
export const DEFAULT_MATCH_DURATION_MINUTES = 120;

/**
 * Temps de trajet à ajouter aux fenêtres AVANT de tester le chevauchement
 * (§15 de la demande) : VOLONTAIREMENT à 0 pour cette V1 — "un hard
 * conflict repose sur le chevauchement réel des créneaux... ne hardcode
 * pas arbitrairement +30/+60/+90 min de trajet". Le moteur est déjà
 * architecturé pour accepter cette valeur (voir `computeMatchWindow`,
 * `match-window.ts`) : le jour où `travelBufferMinutes` existera au niveau
 * club/équipe/type de match, il suffira de le passer à `computeMatchWindow`
 * au lieu de cette constante — aucun autre changement de moteur.
 */
export const DEFAULT_TRAVEL_BUFFER_MINUTES = 0;

/**
 * Catégories de priorité (§12/§13/§22 : "priority tiers + score secondaire,
 * jamais un simple candidateScore incompréhensible"). L'ORDRE de cet objet
 * EST la règle métier : un candidat ADJACENT_NEXT_HOME passe TOUJOURS avant
 * un ADJACENT_PREVIOUS_HOME, qui passe TOUJOURS avant un AVAILABLE_OTHER —
 * quelle que soit l'équité (§21 : "priorité métier avant équité").
 */
export type PriorityTier = "ADJACENT_NEXT_HOME" | "ADJACENT_PREVIOUS_HOME" | "AVAILABLE_OTHER";

export const PRIORITY_TIER_ORDER: Record<PriorityTier, number> = {
  ADJACENT_NEXT_HOME: 0,
  ADJACENT_PREVIOUS_HOME: 1,
  AVAILABLE_OTHER: 2,
};

/**
 * `eligibility` exposé au frontend (§17) : RECOMMENDED = un des 2 tiers
 * adjacents (§13, "TRÈS BIEN CLASSÉS") ; POTENTIALLY_AVAILABLE = aucun
 * conflit détecté mais aucune proximité de match particulière ; UNAVAILABLE
 * = conflit dur. "Potentiellement" est un choix de mot volontaire (§16) :
 * le moteur ne connaît pas la vie personnelle du licencié, jamais présenté
 * comme "disponible confirmé".
 */
export type SuggestionEligibility = "RECOMMENDED" | "POTENTIALLY_AVAILABLE" | "UNAVAILABLE";

/** Raisons structurées d'indisponibilité (§17/§18) — jamais juste `eligible: false`. */
export type UnavailableReasonCode = "MATCH_CONFLICT" | "TABLE_ASSIGNMENT_CONFLICT" | "ALREADY_ASSIGNED_ON_MATCH";

/** Codes des raisons POSITIVES affichées avec chaque suggestion (§19/§38). */
export type SuggestionReasonCode = "NEXT_HOME_MATCH" | "PREVIOUS_HOME_MATCH" | "SAME_VENUE" | "SEASON_DUTY_COUNT";

/**
 * Poids du score SECONDAIRE, cosmétique (§22 : "le score interne est
 * secondaire" — JAMAIS la base du tri, voir `rankCandidates` qui trie par
 * comparateur multi-clés explicite, pas par arithmétique de score). Sert
 * uniquement à afficher un nombre indicatif (§38 : `score: 92`) cohérent
 * avec l'ordre déjà déterminé par le comparateur.
 */
export const SUGGESTION_SCORE = {
  /** Score de base par tier (décroissant : le meilleur tier a le plus haut score de base). */
  TIER_BASE: { ADJACENT_NEXT_HOME: 90, ADJACENT_PREVIOUS_HOME: 75, AVAILABLE_OTHER: 50 } satisfies Record<PriorityTier, number>,
  /** Bonus même gymnase que le match adjacent retenu (§14 : "très forte recommandation"). */
  SAME_VENUE_BONUS: 8,
  /** Bonus gymnase différent mais match adjacent réel (§14 : "le bonus doit être inférieur, ne bloque pas automatiquement"). */
  DIFFERENT_VENUE_BONUS: 3,
  /** Pénalité par table déjà RÉELLEMENT affectée cette saison (§20/§21 point 5 : équité, jamais les suggestions). */
  FAIRNESS_PENALTY_PER_SEASON_ASSIGNMENT: 2,
  /** Pénalité par table déjà affectée AUJOURD'HUI (§21 point 6, plus fin que l'équité saison seule). */
  SAME_DAY_PENALTY_PER_ASSIGNMENT: 1,
} as const;
