/**
 * Configuration de l'API publique FFBB (Directus), telle que documentée
 * dans docs/FFBB_ECOSYSTEM_RESEARCH.md §3 — confirmée par recoupement du
 * code source de 3 bibliothèques clientes open source indépendantes,
 * jamais testée en direct depuis cet environnement (réseau bloqué, voir
 * le même document, section méthodologie).
 */

export const FFBB_API_BASE_URL = "https://api.ffbb.app/";

export const FFBB_ENDPOINTS = {
  configuration: "items/configuration",
  organismes: "items/ffbbserver_organismes",
  engagements: "items/ffbbserver_engagements",
  competitions: "items/ffbbserver_competitions",
  poules: "items/ffbbserver_poules",
  rencontres: "items/ffbbserver_rencontres",
} as const;

/**
 * Le backend est protégé par un WAF/CDN qui bloque les clients qui ne
 * ressemblent pas à l'application mobile officielle (voir docs/
 * FFBB_ECOSYSTEM_RESEARCH.md §3.2). Reproduit ce qu'utilisent les
 * bibliothèques open source étudiées.
 */
export const FFBB_USER_AGENT = "okhttp/4.12.0";

/**
 * Fréquence de synchronisation FFBB par club (§25 du brief SaaS). Pilote
 * `clubs.ffbb_next_sync_at` : chaque club est resynchronisé à son propre
 * rythme plutôt que tous en même temps à chaque tick de cron, ce qui reste
 * simple à 2 clubs et permet de monter en charge sans changer le mécanisme
 * (voir docs/MULTI_TENANCY.md).
 */
export const FFBB_SYNC_INTERVAL_MINUTES = 15;

/**
 * Nombre maximal de clubs traités par exécution du cron (§25/§49 du brief
 * SaaS) : évite qu'un tick de cron devienne interminable à grande échelle.
 * Les clubs non traités restent dus et seront pris au tick suivant.
 */
export const FFBB_SYNC_BATCH_SIZE = 20;
