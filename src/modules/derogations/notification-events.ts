import { isDerogationActionRequired } from "./action-required.js";
import type { FbiDerogationEvent } from "../derogation-requests/notify.js";

/**
 * Ce qui mérite un email au coordinateur après une vérification FBI (retour
 * du club, 2026-10-08) — fonction pure :
 * - `incoming` : dérogation « En Cours » demandée par le club ADVERSE
 *   (même règle que le badge « Action requise ») ;
 * - `outcome` : une dérogation connue « En Cours » a changé d'état (acceptée,
 *   refusée…) depuis la dernière vérification. Jamais au premier passage
 *   (une dérogation déjà tranchée avant la mise en service ne prévient pas).
 * La clé (`refKey`) garantit un seul email par événement.
 */
export interface DerogationSnapshot {
  fbiRowKey: string;
  etat: string | null;
  previousEtat: string | null | undefined;
  demandeur: string | null;
  isHome: boolean | null;
  domicile: string | null;
  visiteur: string | null;
  dateRencontre: string | null;
  heure: string | null;
  dateRencontreDemandee: string | null;
  heureDemandee: string | null;
  salleDemandee: string | null;
  motif: string | null;
}

function teams(d: DerogationSnapshot): string {
  return [d.domicile, d.visiteur].filter(Boolean).join(" – ") || "Rencontre";
}

function slot(date: string | null, heure: string | null): string | null {
  const parts = [date, heure].filter(Boolean);
  return parts.length > 0 ? parts.join(" à ") : null;
}

export function derogationNotificationEvents(rows: readonly DerogationSnapshot[]): FbiDerogationEvent[] {
  const events: FbiDerogationEvent[] = [];
  for (const d of rows) {
    if (isDerogationActionRequired({ etat: d.etat, demandeur: d.demandeur, isHome: d.isHome })) {
      const from = slot(d.dateRencontre, d.heure);
      const to = slot(d.dateRencontreDemandee, d.heureDemandee);
      const details = [from ? `prévu ${from}` : null, to ? `demandé ${to}` : null, d.salleDemandee ? `salle : ${d.salleDemandee}` : null, d.motif ? `motif : ${d.motif}` : null].filter(Boolean);
      events.push({ kind: "incoming", refKey: d.fbiRowKey, line: `${teams(d)}${details.length ? ` — ${details.join(", ")}` : ""}` });
      continue;
    }
    if (d.previousEtat === "En Cours" && d.etat && d.etat !== "En Cours") {
      const to = slot(d.dateRencontreDemandee, d.heureDemandee);
      events.push({ kind: "outcome", refKey: `${d.fbiRowKey}:${d.etat}`, line: `${teams(d)} : ${d.etat}${to ? ` (créneau demandé ${to})` : ""}` });
    }
  }
  return events;
}
