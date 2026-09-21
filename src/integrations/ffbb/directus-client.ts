import { FFBB_API_BASE_URL, FFBB_ENDPOINTS, FFBB_USER_AGENT } from "./config";

export class FfbbApiError extends Error {
  constructor(
    message: string,
    readonly code: "CONFIG_FETCH_FAILED" | "REQUEST_FAILED" | "UNEXPECTED_RESPONSE",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FfbbApiError";
  }
}

interface FfbbConfigurationResponse {
  data?: {
    api_bearer_token?: string;
    meilisearch_token?: string;
  };
}

interface CachedToken {
  token: string;
  fetchedAt: number;
}

let cachedApiToken: CachedToken | null = null;
const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Récupère le jeton public de l'API FFBB (voir docs/FFBB_ECOSYSTEM_RESEARCH.md
 * §3.2) : endpoint non authentifié, jeton mis en cache en mémoire quelques
 * minutes pour éviter un aller-retour à chaque appel dans un même run de
 * synchronisation.
 */
async function getApiToken(fetchImpl: typeof fetch): Promise<string> {
  if (cachedApiToken && Date.now() - cachedApiToken.fetchedAt < TOKEN_TTL_MS) {
    return cachedApiToken.token;
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
    );
  }

  const body = (await response.json()) as FfbbConfigurationResponse;
  const token = body.data?.api_bearer_token;

  if (!token) {
    throw new FfbbApiError("Jeton API absent de la réponse de configuration FFBB", "UNEXPECTED_RESPONSE");
  }

  cachedApiToken = { token, fetchedAt: Date.now() };
  return token;
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
    const token = await getApiToken(this.fetchImpl);
    const query = buildQuery(params);
    const url = `${FFBB_API_BASE_URL}${endpoint}${query ? `?${query}` : ""}`;

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
      throw new FfbbApiError(`Requête FFBB : réponse HTTP ${response.status} (${endpoint})`, "REQUEST_FAILED");
    }

    const body = (await response.json()) as { data?: T[] };

    if (!Array.isArray(body.data)) {
      throw new FfbbApiError(`Réponse FFBB inattendue (${endpoint})`, "UNEXPECTED_RESPONSE");
    }

    return body.data;
  }
}
