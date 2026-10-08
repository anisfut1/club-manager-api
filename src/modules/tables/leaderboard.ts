import type { DbClient } from "../../db/client.js";
import { currentSeasonStart } from "../../season.js";
import type { TableLeaderboardDto } from "../../contracts/tables.js";
import type { TableAssignmentRole } from "./suggestion-policy.js";

const ROLES: TableAssignmentRole[] = ["SCORER", "TIMEKEEPER", "CLUB_DELEGATE", "REFEREE"];

export interface LeaderboardAssignment {
  licencieId: string;
  role: TableAssignmentRole;
  matchDatetime: string;
}

export interface LeaderboardPerson {
  id: string;
  firstName: string;
  lastName: string;
  photoUrl: string | null;
}

/**
 * Classement pur (testé sans base) : tables tenues (match déjà commencé)
 * décroissantes, puis nom ; rang « olympique » (1, 1, 3). Seules les
 * personnes ayant tenu au moins une table apparaissent.
 */
export function rankTableLeaderboard(assignments: LeaderboardAssignment[], people: Map<string, LeaderboardPerson>, now: Date, seasonStart: Date): Omit<TableLeaderboardDto, "seasonStart"> {
  const nowIso = now.toISOString();
  const startIso = seasonStart.toISOString();
  const byPerson = new Map<string, { done: number; upcoming: number; roles: Map<TableAssignmentRole, number> }>();

  for (const a of assignments) {
    if (a.matchDatetime < startIso || !people.has(a.licencieId)) continue;
    const entry = byPerson.get(a.licencieId) ?? { done: 0, upcoming: 0, roles: new Map() };
    if (a.matchDatetime < nowIso) {
      entry.done += 1;
      entry.roles.set(a.role, (entry.roles.get(a.role) ?? 0) + 1);
    } else {
      entry.upcoming += 1;
    }
    byPerson.set(a.licencieId, entry);
  }

  const rows = [...byPerson.entries()]
    .filter(([, e]) => e.done > 0)
    .map(([id, e]) => ({ person: people.get(id)!, ...e }))
    .sort((a, b) => b.done - a.done || a.person.lastName.localeCompare(b.person.lastName, "fr") || a.person.firstName.localeCompare(b.person.firstName, "fr"));

  let rank = 0;
  return {
    totalDone: rows.reduce((sum, r) => sum + r.done, 0),
    entries: rows.map((r, i) => {
      if (i === 0 || r.done !== rows[i - 1]!.done) rank = i + 1;
      return {
        rank,
        licencie: { id: r.person.id, firstName: r.person.firstName, lastName: r.person.lastName, photoUrl: r.person.photoUrl },
        done: r.done,
        upcoming: r.upcoming,
        byRole: ROLES.map((role) => ({ role, count: r.roles.get(role) ?? 0 })).filter((x) => x.count > 0),
      };
    }),
  };
}

/** Lecture du classement d'UN club (filtre `clubId` sur chaque requête : client service côté public). */
export async function loadTableLeaderboard(supabase: DbClient, clubId: string, now: Date = new Date()): Promise<TableLeaderboardDto> {
  const seasonStart = currentSeasonStart(now);
  const { data: rows, error } = await supabase.from("table_assignments").select("match_id, role, licencie_id").eq("club_id", clubId);
  if (error) throw new Error(`Lecture des tables de marque échouée : ${error.message}`);

  const matchIds = [...new Set((rows ?? []).map((r) => r.match_id))];
  const licencieIds = [...new Set((rows ?? []).map((r) => r.licencie_id))];
  const [{ data: matches }, { data: licencies }] = await Promise.all([
    matchIds.length ? supabase.from("matches").select("id, match_datetime").eq("club_id", clubId).in("id", matchIds) : Promise.resolve({ data: [] as { id: string; match_datetime: string | null }[] }),
    licencieIds.length
      ? supabase.from("licencies").select("id, first_name, last_name, photo_url").eq("club_id", clubId).in("id", licencieIds)
      : Promise.resolve({ data: [] as { id: string; first_name: string; last_name: string; photo_url: string | null }[] }),
  ]);

  const dateByMatchId = new Map((matches ?? []).map((m) => [m.id, m.match_datetime as string | null]));
  const people = new Map((licencies ?? []).map((l) => [l.id, { id: l.id, firstName: l.first_name, lastName: l.last_name, photoUrl: l.photo_url ?? null }]));
  const assignments: LeaderboardAssignment[] = (rows ?? []).flatMap((r) => {
    const date = dateByMatchId.get(r.match_id);
    return date ? [{ licencieId: r.licencie_id, role: r.role as TableAssignmentRole, matchDatetime: date }] : [];
  });

  return { seasonStart: seasonStart.toISOString(), ...rankTableLeaderboard(assignments, people, now, seasonStart) };
}
