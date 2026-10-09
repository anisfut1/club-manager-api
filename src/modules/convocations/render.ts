/**
 * Message de convocation personnalisé (Vie d'équipe, Lot 2) — fonction pure,
 * testable. Deux publics :
 *   GUARDIAN : parent d'un mineur (ou âge inconnu) — « Convocation pour Lina » ;
 *   ADULT    : joueur majeur — « Bonjour Anis, … Merci de confirmer ta présence. »
 * Jamais de tournure qui exige de connaître le genre (« convoqué·e ») :
 * le sexe n'est pas déduit du prénom.
 *
 * Match à l'extérieur : « Rendez-vous » et « Lieu du match » sont TOUJOURS
 * distincts. À domicile, le lieu du match n'est répété que s'il diffère du
 * lieu de rendez-vous.
 */
export type ConvocationAudience = "GUARDIAN" | "ADULT";

export interface ConvocationRenderInput {
  audience: ConvocationAudience;
  playerFirstName: string;
  teamName: string;
  opponent: string | null;
  isHome: boolean | null;
  matchStartsAt: string;
  matchVenue: { name: string | null; address: string | null };
  meetingAt: string | null;
  meetingPoint: string | null;
  coachMessage: string | null;
  timezone: string;
}

function dayAndTime(iso: string, timezone: string): string {
  const day = new Date(iso).toLocaleDateString("fr-FR", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" });
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} à ${timeOf(iso, timezone)}`;
}

export function timeOf(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
}

const same = (a: string | null, b: string | null) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

export function matchTitle(teamName: string, opponent: string | null): string {
  return opponent ? `${teamName} contre ${opponent}` : teamName;
}

/** Âge le jour du match : mineur → message au parent ; inconnu → message au parent (formulation neutre). */
export function audienceFor(birthDate: string | null, matchStartsAt: string): ConvocationAudience {
  if (!birthDate) return "GUARDIAN";
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number];
  const at = new Date(matchStartsAt);
  let age = at.getUTCFullYear() - y;
  if (at.getUTCMonth() + 1 < m || (at.getUTCMonth() + 1 === m && at.getUTCDate() < d)) age -= 1;
  return age >= 18 ? "ADULT" : "GUARDIAN";
}

export function renderConvocationMessage(input: ConvocationRenderInput): string {
  const lines: string[] = [];
  const name = input.playerFirstName;
  const venueLines = [input.matchVenue.name, input.matchVenue.address].filter((v): v is string => Boolean(v));

  if (input.audience === "GUARDIAN") {
    lines.push("Bonjour,", "", `Convocation pour ${name} avec les ${input.teamName}.`);
  } else {
    lines.push(`Bonjour ${name},`, "", "Convocation pour le match :");
  }

  lines.push("", "Match :", matchTitle(input.teamName, input.opponent), dayAndTime(input.matchStartsAt, input.timezone));
  if (input.isHome === false) lines.push("Match à l'extérieur");

  if (input.meetingAt || input.meetingPoint) {
    lines.push("", "Rendez-vous :");
    if (input.meetingAt) lines.push(timeOf(input.meetingAt, input.timezone));
    if (input.meetingPoint) lines.push(input.meetingPoint);
  }

  const showVenue = venueLines.length > 0 && (input.isHome === false || !same(input.meetingPoint, input.matchVenue.name));
  if (showVenue) lines.push("", "Lieu du match :", ...venueLines);

  if (input.coachMessage?.trim()) lines.push("", "Message du coach :", `« ${input.coachMessage.trim()} »`);

  lines.push("", input.audience === "GUARDIAN" ? `Merci de confirmer la présence de ${name}.` : "Merci de confirmer ta présence.");
  return lines.join("\n");
}
