import { FFBB_ENDPOINTS } from "./config.js";
import { FfbbApiError, FfbbDirectusClient, type DirectusClientOptions } from "./directus-client.js";
import type {
  FfbbClubSnapshot,
  NormalizedCompetition,
  NormalizedMatch,
  NormalizedMatchStatus,
  NormalizedOrganisme,
  NormalizedPool,
  NormalizedTeamEngagement,
  NormalizedVenue,
} from "./types.js";

const FFBB_REQUEST_SPACING_MS = 200;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Formes brutes attendues côté Directus (voir docs/FFBB_ECOSYSTEM_RESEARCH.md
// §3.3/§3.4). Champs optionnels par prudence : cette API n'est pas
// officiellement documentée et peut évoluer sans préavis (voir le même
// document, §10).
interface RawOrganisme {
  id: number | string;
  code?: string;
  nom?: string;
}

interface RawCategorie {
  code?: string;
  libelle?: string;
}

interface RawCompetition {
  id: number | string;
  nom?: string;
  code?: string;
  sexe?: string;
  typeCompetition?: string;
  phase_code?: string;
  liveStat?: boolean;
  emarqueV2?: boolean;
  publicationInternet?: boolean;
  saison?: number | string;
  competition_origine?: number | string | null;
  categorie?: RawCategorie;
}

interface RawPool {
  id: number | string;
  nom?: string;
  id_competition?: number | string;
}

interface RawEngagement {
  id: number | string;
  nom?: string;
  nomEquipe?: string;
  numeroEquipe?: string;
  idCompetition?: number | string;
  idPoule?: number | string;
  idOrganisme?: number | string;
}

interface RawSalle {
  id?: number | string;
  nom?: string;
  commune?: { libelle?: string };
}

interface RawRencontre {
  id: number | string;
  uniqueKey?: string;
  gsId?: string;
  numero?: string;
  numeroJournee?: string;
  date_rencontre?: string;
  horaire?: string;
  nomEquipe1?: string;
  nomEquipe2?: string;
  resultatEquipe1?: number | null;
  resultatEquipe2?: number | null;
  joue?: boolean;
  status?: string;
  forfaitEquipe1?: boolean;
  forfaitEquipe2?: boolean;
  defautEquipe1?: boolean;
  defautEquipe2?: boolean;
  competitionId?: number | string;
  idEngagementEquipe1?: number | string;
  idEngagementEquipe2?: number | string;
  idOrganismeEquipe1?: number | string;
  idOrganismeEquipe2?: number | string;
  idPoule?: number | string;
  salle?: RawSalle | number | string | null;
}

const RENCONTRE_FIELDS = [
  "id",
  "uniqueKey",
  "gsId",
  "numero",
  "numeroJournee",
  "date_rencontre",
  "horaire",
  "nomEquipe1",
  "nomEquipe2",
  "resultatEquipe1",
  "resultatEquipe2",
  "joue",
  "status",
  "forfaitEquipe1",
  "forfaitEquipe2",
  "defautEquipe1",
  "defautEquipe2",
  "competitionId",
  "idEngagementEquipe1",
  "idEngagementEquipe2",
  "idOrganismeEquipe1",
  "idOrganismeEquipe2",
  "idPoule",
  "salle.id",
  "salle.nom",
  "salle.commune.libelle",
];

function toIdString(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function requireIdString(value: number | string): string {
  return String(value);
}

function normalizeMatchStatus(raw: RawRencontre): NormalizedMatchStatus {
  if (raw.forfaitEquipe1 || raw.forfaitEquipe2) return "forfeit";
  if (raw.defautEquipe1 || raw.defautEquipe2) return "cancelled";
  if (raw.joue) return "played";
  if (raw.status?.toLowerCase().includes("report")) return "postponed";
  return "scheduled";
}

function normalizeVenue(salle: RawRencontre["salle"]): NormalizedVenue | null {
  if (salle === null || salle === undefined) return null;

  if (typeof salle === "object") {
    return {
      ffbbId: toIdString(salle.id),
      name: salle.nom ?? null,
      commune: salle.commune?.libelle ?? null,
      raw: salle,
    };
  }

  // Cas où la relation n'a pas pu être résolue par l'API (id brut seulement).
  return { ffbbId: toIdString(salle), name: null, commune: null, raw: salle };
}

export type FfbbPublicProviderOptions = DirectusClientOptions;

/**
 * FFBBProvider — implémentation "API publique" (Directus). Voir
 * ARCHITECTURE.md §8.1 : le reste de l'application ne connaît que les DTO
 * normalisés retournés ici, jamais le format brut FFBB.
 *
 * Statut : PREPARED — jamais exécuté contre le vrai api.ffbb.app depuis cet
 * environnement (réseau bloqué, voir docs/FFBB_ECOSYSTEM_RESEARCH.md). Les
 * noms de champs et endpoints sont ceux confirmés par recoupement de 3
 * bibliothèques clientes indépendantes dans ce même document.
 */
export class FfbbPublicProvider {
  private readonly client: FfbbDirectusClient;

  constructor(options: FfbbPublicProviderOptions = {}) {
    this.client = new FfbbDirectusClient(options);
  }

  async findOrganismeByCode(clubCode: string): Promise<NormalizedOrganisme> {
    const rows = await this.client.listItems<RawOrganisme>(FFBB_ENDPOINTS.organismes, {
      fields: ["id", "code", "nom"],
      filter: { code: { _eq: clubCode } },
      limit: 1,
    });

    const organisme = rows[0];
    if (!organisme) {
      throw new FfbbApiError(`Aucun organisme FFBB trouvé pour le code "${clubCode}"`, "UNEXPECTED_RESPONSE");
    }

    return {
      ffbbId: requireIdString(organisme.id),
      code: organisme.code ?? clubCode,
      name: organisme.nom ?? clubCode,
    };
  }

  async listEngagements(organismeFfbbId: string): Promise<NormalizedTeamEngagement[]> {
    const rows = await this.client.listItems<RawEngagement>(FFBB_ENDPOINTS.engagements, {
      fields: ["id", "nom", "nomEquipe", "numeroEquipe", "idCompetition", "idPoule", "idOrganisme"],
      filter: { idOrganisme: { _eq: organismeFfbbId } },
    });

    return rows.map((row) => ({
      ffbbId: requireIdString(row.id),
      name: row.nom ?? null,
      numeroEquipe: row.numeroEquipe ?? null,
      competitionFfbbId: toIdString(row.idCompetition) ?? "",
      poolFfbbId: toIdString(row.idPoule),
      organismeFfbbId,
      raw: row,
    }));
  }

  async listCompetitions(competitionFfbbIds: string[]): Promise<NormalizedCompetition[]> {
    if (competitionFfbbIds.length === 0) return [];

    const rows = await this.client.listItems<RawCompetition>(FFBB_ENDPOINTS.competitions, {
      fields: [
        "id",
        "nom",
        "code",
        "sexe",
        "typeCompetition",
        "phase_code",
        "liveStat",
        "emarqueV2",
        "publicationInternet",
        "saison",
        "competition_origine",
        "categorie.code",
        "categorie.libelle",
      ],
      filter: { id: { _in: competitionFfbbIds } },
    });

    return rows.map((row) => ({
      ffbbId: requireIdString(row.id),
      name: row.nom ?? "Compétition",
      code: row.code ?? null,
      sexe: row.sexe ?? null,
      typeCompetition: row.typeCompetition ?? null,
      categoryCode: row.categorie?.code ?? null,
      categoryLabel: row.categorie?.libelle ?? null,
      phaseCode: row.phase_code ?? null,
      liveStat: Boolean(row.liveStat),
      emarqueV2: Boolean(row.emarqueV2),
      publicationInternet: row.publicationInternet ?? true,
      season: toIdString(row.saison),
      parentCompetitionFfbbId: toIdString(row.competition_origine),
      raw: row,
    }));
  }

  async listPools(poolFfbbIds: string[]): Promise<NormalizedPool[]> {
    if (poolFfbbIds.length === 0) return [];

    const rows = await this.client.listItems<RawPool>(FFBB_ENDPOINTS.poules, {
      fields: ["id", "nom", "id_competition"],
      filter: { id: { _in: poolFfbbIds } },
    });

    return rows.map((row) => ({
      ffbbId: requireIdString(row.id),
      competitionFfbbId: toIdString(row.id_competition) ?? "",
      name: row.nom ?? "Poule",
      raw: row,
    }));
  }

  async listMatchesForOrganisme(organismeFfbbId: string): Promise<NormalizedMatch[]> {
    const rows = await this.client.listItems<RawRencontre>(FFBB_ENDPOINTS.rencontres, {
      fields: RENCONTRE_FIELDS,
      filter: {
        _or: [{ idOrganismeEquipe1: { _eq: organismeFfbbId } }, { idOrganismeEquipe2: { _eq: organismeFfbbId } }],
      },
      sort: ["date_rencontre"],
    });

    return rows.map((row) => {
      const isHome = toIdString(row.idOrganismeEquipe1) === organismeFfbbId;
      const ourEngagementFfbbId = toIdString(isHome ? row.idEngagementEquipe1 : row.idEngagementEquipe2) ?? "";
      const opponentName = isHome ? (row.nomEquipe2 ?? null) : (row.nomEquipe1 ?? null);
      const opponentOrganismeFfbbId = toIdString(isHome ? row.idOrganismeEquipe2 : row.idOrganismeEquipe1);
      const scoreHome = row.resultatEquipe1 ?? null;
      const scoreAway = row.resultatEquipe2 ?? null;

      return {
        ffbbId: requireIdString(row.id),
        uniqueKey: row.uniqueKey ?? null,
        gsId: row.gsId ?? null,
        numero: row.numero ?? null,
        numeroJournee: row.numeroJournee ?? null,
        competitionFfbbId: toIdString(row.competitionId),
        poolFfbbId: toIdString(row.idPoule),
        ourEngagementFfbbId,
        isHome,
        opponentName,
        opponentOrganismeFfbbId,
        matchDateTime: row.date_rencontre ?? null,
        scoreHome,
        scoreAway,
        status: normalizeMatchStatus(row),
        venue: normalizeVenue(row.salle),
        raw: row,
      };
    });
  }

  /**
   * Appels strictement séquentiels, jamais en parallèle (`Promise.all`
   * supprimé — voir docs/FFBB.md, constat du 2026-09-22) : une rafale de
   * requêtes concurrentes juste après l'authentification a fait échouer
   * `items/ffbbserver_rencontres` avec 401 sur TOUS les jetons candidats,
   * alors qu'un seul de ces jetons venait de fonctionner à l'instant pour
   * `items/ffbbserver_organismes` — signature typique d'un throttling
   * passager (WAF/CDN, voir docs/FFBB_ECOSYSTEM_RESEARCH.md §10 : "aucune
   * documentation de rate-limit trouvée ; à traiter défensivement") plutôt
   * que d'un vrai jeton invalide. `FFBB_REQUEST_SPACING_MS` espace même les
   * appels séquentiels rapides.
   */
  async fetchClubSnapshot(clubCode: string): Promise<FfbbClubSnapshot> {
    const organisme = await this.findOrganismeByCode(clubCode);
    await sleep(FFBB_REQUEST_SPACING_MS);
    const engagements = await this.listEngagements(organisme.ffbbId);
    await sleep(FFBB_REQUEST_SPACING_MS);
    const matches = await this.listMatchesForOrganisme(organisme.ffbbId);

    const competitionIds = [
      ...new Set([
        ...engagements.map((e) => e.competitionFfbbId).filter(Boolean),
        ...matches.map((m) => m.competitionFfbbId).filter((id): id is string => Boolean(id)),
      ]),
    ];
    const poolIds = [
      ...new Set([
        ...engagements.map((e) => e.poolFfbbId).filter((id): id is string => Boolean(id)),
        ...matches.map((m) => m.poolFfbbId).filter((id): id is string => Boolean(id)),
      ]),
    ];

    await sleep(FFBB_REQUEST_SPACING_MS);
    const competitions = await this.listCompetitions(competitionIds);
    await sleep(FFBB_REQUEST_SPACING_MS);
    const pools = await this.listPools(poolIds);

    return { organisme, engagements, competitions, pools, matches };
  }
}
