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
