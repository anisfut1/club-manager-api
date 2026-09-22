import { FFBB_API_BASE_URL, FFBB_ENDPOINTS, FFBB_USER_AGENT } from "./config.js";
import { logInfo } from "../../logger.js";

export class FfbbApiError extends Error {
  constructor(
    message: string,
    readonly code: "CONFIG_FETCH_FAILED" | "REQUEST_FAILED" | "UNEXPECTED_RESPONSE",
    readonly cause?: unknown,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FfbbApiError";
  }
}

interface FfbbConfigurationResponse {
  data?: unknown;
}

interface CachedConfig {
  data: Record<string, unknown>;
  fetchedAt: number;
}

interface CachedAuth {
  fieldName: string;
  token: string;
  fetchedAt: number;
}

let cachedConfig: CachedConfig | null = null;
let cachedAuth: CachedAuth | null = null;
const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * `items/configuration` ne renvoie AUCUN champ nommé "...token..." en
 * réalité (constaté en production le 2026-09-22 — voir docs/FFBB.md, la
 * forme supposée dans docs/FFBB_ECOSYSTEM_RESEARCH.md §3.2, déduite par
 * recoupement de bibliothèques clientes tierces, ne correspond pas). Les
 * champs réellement présents : `key_dh` (probablement "Data Hub", le terme
 * employé dans FFBB_ECOSYSTEM_RESEARCH.md §2), `key_directus_website`,
 * `key_directus_competitions`, `key_ms` (Meilisearch, recherche
 * uniquement — hors périmètre `items/*`). Comme aucun n'est confirmé,
 * chaque candidat est essayé dans cet ordre CONTRE LE VRAI ENDPOINT
 * demandé (voir `FfbbDirectusClient.listItems`) jusqu'à ce qu'un renvoie
 * un succès HTTP — c'est l'API elle-même qui tranche, jamais une nouvelle
 * supposition. Le nom du champ gagnant est loggé pour ne plus jamais avoir
 * à re-deviner.
 */
const CANDIDATE_TOKEN_FIELDS = ["key_directus_competitions", "key_dh", "key_directus_website", "key_ms"] as const;

function describeShape(value: unknown): string {
  if (Array.isArray(value)) return `tableau de ${value.length} élément(s)`;
  if (value && typeof value === "object") return `objet avec clés [${Object.keys(value).join(", ")}]`;
  return `type ${typeof value}`;
}

function isAuthError(error: unknown): error is FfbbApiError {
  return error instanceof FfbbApiError && error.code === "REQUEST_FAILED" && (error.status === 401 || error.status === 403);
}

/**
 * Récupère et met en cache le contenu de `items/configuration` (endpoint
 * public, non authentifié — voir docs/FFBB_ECOSYSTEM_RESEARCH.md §3.2).
 */
async function getConfigurationData(fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  if (cachedConfig && Date.now() - cachedConfig.fetchedAt < TOKEN_TTL_MS) {
    return cachedConfig.data;
  }

  const url = `${FFBB_API_BASE_URL}${FFBB_ENDPOINTS.configuration}`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { "user-agent": FFBB_USER_AGENT } });
  } catch (error) {
    throw new FfbbApiError("Impossible de joindre l'endpoint de configuration FFBB", "CONFIG_FETCH_FAILED", error);
  }

  if (!response.ok) {
    throw new FfbbApiError(
      `Endpoint de configuration FFBB : réponse HTTP ${response.status}`,
      "CONFIG_FETCH_FAILED",
      undefined,
      response.status,
    );
  }

  const rawText = await response.text();
  let parsed: FfbbConfigurationResponse;
  try {
    parsed = JSON.parse(rawText) as FfbbConfigurationResponse;
  } catch {
    // Corps non-JSON le plus probable en production : une page de blocage WAF/CDN
    // (voir docs/FFBB_ECOSYSTEM_RESEARCH.md §3.2 et §10 sur BunnyCDN) — le
    // content-type et un extrait permettent de le distinguer d'un vrai souci de schéma.
    throw new FfbbApiError(
      `Réponse de configuration FFBB non-JSON (content-type: ${response.headers.get("content-type") ?? "?"}) : ${rawText.slice(0, 300)}`,
      "UNEXPECTED_RESPONSE",
    );
  }

  const data = parsed.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new FfbbApiError(
      `Réponse de configuration FFBB inattendue (data = ${describeShape(data)})`,
      "UNEXPECTED_RESPONSE",
    );
  }

  cachedConfig = { data: data as Record<string, unknown>, fetchedAt: Date.now() };
  return cachedConfig.data;
}

export interface DirectusListParams {
  fields?: string[];
  filter?: unknown;
  sort?: string[];
  limit?: number;
  offset?: number;
}

function buildQuery(params: DirectusListParams): string {
  const search = new URLSearchParams();

  if (params.fields?.length) search.set("fields", params.fields.join(","));
  if (params.filter) search.set("filter", JSON.stringify(params.filter));
  if (params.sort?.length) params.sort.forEach((s) => search.append("sort[]", s));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));

  return search.toString();
}

export interface DirectusClientOptions {
  /** Injection pour les tests — jamais utilisé en production. */
  fetchImpl?: typeof fetch;
}

/**
 * Client bas niveau pour l'API Directus publique FFBB. Ne connaît que la
 * mécanique HTTP (jeton, en-têtes, pagination) — la normalisation des
 * données vit dans public-provider.ts.
 */
export class FfbbDirectusClient {
  private readonly fetchImpl: typeof fetch;

  constructor(options: DirectusClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listItems<T>(endpoint: string, params: DirectusListParams = {}): Promise<T[]> {
    const query = buildQuery(params);
    const url = `${FFBB_API_BASE_URL}${endpoint}${query ? `?${query}` : ""}`;

    if (cachedAuth && Date.now() - cachedAuth.fetchedAt < TOKEN_TTL_MS) {
      try {
        return await this.request<T>(url, endpoint, cachedAuth.token);
      } catch (error) {
        if (!isAuthError(error)) throw error;
        // Le jeton mis en cache a cessé de fonctionner (rotation côté FFBB) — on
        // retente une découverte complète plutôt que d'échouer immédiatement.
        cachedAuth = null;
      }
    }

    const data = await getConfigurationData(this.fetchImpl);
    const candidates: Array<[string, string]> = [];
    for (const field of CANDIDATE_TOKEN_FIELDS) {
      const value = data[field];
      if (typeof value === "string" && value.length > 0) {
        candidates.push([field, value]);
      }
    }

    if (candidates.length === 0) {
      throw new FfbbApiError(
        `Aucun champ candidat pour le jeton API dans la configuration FFBB (data = ${describeShape(data)})`,
        "UNEXPECTED_RESPONSE",
      );
    }

    let lastAuthError: FfbbApiError | undefined;
    for (const [fieldName, token] of candidates) {
      try {
        const items = await this.request<T>(url, endpoint, token);
        cachedAuth = { fieldName, token, fetchedAt: Date.now() };
        logInfo("Jeton API FFBB confirmé", { fieldName });
        return items;
      } catch (error) {
        if (isAuthError(error)) {
          lastAuthError = error;
          continue;
        }
        throw error;
      }
    }

    throw (
      lastAuthError ??
      new FfbbApiError(`Tous les jetons candidats de la configuration FFBB ont échoué (${endpoint})`, "REQUEST_FAILED")
    );
  }

  private async request<T>(url: string, endpoint: string, token: string): Promise<T[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          "user-agent": FFBB_USER_AGENT,
          authorization: `Bearer ${token}`,
        },
      });
    } catch (error) {
      throw new FfbbApiError(`Requête FFBB échouée : ${endpoint}`, "REQUEST_FAILED", error);
    }

    if (!response.ok) {
      throw new FfbbApiError(
        `Requête FFBB : réponse HTTP ${response.status} (${endpoint})`,
        "REQUEST_FAILED",
        undefined,
        response.status,
      );
    }

    const body = (await response.json()) as { data?: T[] };

    if (!Array.isArray(body.data)) {
      throw new FfbbApiError(`Réponse FFBB inattendue (${endpoint})`, "UNEXPECTED_RESPONSE");
    }

    return body.data;
  }
}
