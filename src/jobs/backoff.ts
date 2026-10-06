/**
 * Calendrier de retry (§27/§47 du brief FBI) : 30min / 2h / 6h / 24h, puis
 * répétition quotidienne — un match sans document e-Marque n'est PAS une
 * erreur (ex. rencontre terminée à 22h, document disponible le lendemain).
 * Après plusieurs jours, la fréquence tombe à un rythme bas (24h) plutôt que
 * de continuer à interroger FBI toutes les 30 minutes indéfiniment (§47 :
 * protection contre la boucle infinie), mais on ne renonce jamais tant que
 * le match n'a pas de document — cette planification est distincte du
 * `max_attempts` d'un job, qui gère lui les échecs (connexion FBI en panne,
 * exception inattendue), pas l'absence normale de document.
 */
const WAITING_BACKOFF_SCHEDULE_SECONDS = [30 * 60, 2 * 60 * 60, 6 * 60 * 60, 24 * 60 * 60];

export function nextWaitingBackoffSeconds(previousAttemptCount: number): number {
  const index = Math.min(previousAttemptCount, WAITING_BACKOFF_SCHEDULE_SECONDS.length - 1);
  return WAITING_BACKOFF_SCHEDULE_SECONDS[index]!;
}

/** Backoff pour un échec réel (FBI injoignable, exception) — plus court, on ne veut pas attendre 24h avant de constater qu'une panne transitoire est résolue. */
const ERROR_BACKOFF_SCHEDULE_SECONDS = [5 * 60, 15 * 60, 60 * 60, 4 * 60 * 60];

export function nextErrorBackoffSeconds(previousAttemptCount: number): number {
  const index = Math.min(previousAttemptCount, ERROR_BACKOFF_SCHEDULE_SECONDS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_SECONDS[index]!;
}

/**
 * Calendrier FIXE de vérification de la feuille e-Marque d'un match joué
 * (retour du club, 2026-10-06 : "je veux un process clair, pas au
 * hasard"). Remplace, pour `discover_emarque`, les deux calendriers
 * ci-dessus qui dépendaient du NOMBRE d'essais déjà faits (d'où un match
 * repris "du jour au lendemain" après trois essais infructueux) :
 *
 * - fenêtre ouverte à la fin du match (début + 2 h), ou à la relance
 *   manuelle (`fbi_jobs.window_start`) ;
 * - toutes les 15 min pendant 6 h, puis toutes les heures jusqu'à 48 h,
 *   puis toutes les 6 h jusqu'à 7 jours ;
 * - au-delà : `null` — plus de vérification automatique, le match passe
 *   "pas de feuille e-Marque" (relance manuelle possible).
 *
 * Une panne FBI ne change rien à ce calendrier : on réessaie au créneau
 * suivant, jamais d'abandon anticipé.
 */
export const EMARQUE_MATCH_DURATION_MS = 2 * 60 * 60 * 1000;
export const EMARQUE_CHECK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const EMARQUE_CHECK_STEPS: Array<{ untilMs: number; stepMs: number }> = [
  { untilMs: 6 * 60 * 60 * 1000, stepMs: 15 * 60 * 1000 },
  { untilMs: 48 * 60 * 60 * 1000, stepMs: 60 * 60 * 1000 },
  { untilMs: EMARQUE_CHECK_WINDOW_MS, stepMs: 6 * 60 * 60 * 1000 },
];

/** Début de la fenêtre de vérification : relance manuelle si renseignée, sinon fin du match. */
export function emarqueCheckWindowStart(matchDatetime: string | null, windowStart: string | null): Date | null {
  if (windowStart) return new Date(windowStart);
  if (!matchDatetime) return null;
  return new Date(new Date(matchDatetime).getTime() + EMARQUE_MATCH_DURATION_MS);
}

/** Prochain créneau STRICTEMENT après `now`, ou `null` si la fenêtre de 7 jours est écoulée. */
export function nextEmarqueCheckAt(windowStart: Date, now: Date = new Date()): Date | null {
  const elapsed = now.getTime() - windowStart.getTime();
  if (elapsed < 0) return windowStart;

  let segmentStart = 0;
  for (const { untilMs, stepMs } of EMARQUE_CHECK_STEPS) {
    if (elapsed < untilMs) {
      const slot = segmentStart + Math.floor((elapsed - segmentStart) / stepMs + 1) * stepMs;
      return slot <= EMARQUE_CHECK_WINDOW_MS ? new Date(windowStart.getTime() + Math.min(slot, untilMs)) : null;
    }
    segmentStart = untilMs;
  }
  return null;
}
