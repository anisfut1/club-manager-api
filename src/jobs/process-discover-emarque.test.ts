import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FbiJobRow } from "../db/types.js";
import { FbiError } from "../integrations/fbi/errors.js";

const loginMock = vi.fn();
const findEmarqueDocumentsMock = vi.fn();
const downloadDocumentMock = vi.fn();
const closeSessionMock = vi.fn();

vi.mock("../integrations/fbi/browser-client.js", () => ({
  BrowserFbiClient: class FakeBrowserFbiClient {
    login = loginMock;
    findEmarqueDocuments = findEmarqueDocumentsMock;
    downloadDocument = downloadDocumentMock;
    closeSession = closeSessionMock;
  },
}));

const closeBrowserMock = vi.fn();
const launchServerlessBrowserMock = vi.fn(async () => ({ close: closeBrowserMock }));
vi.mock("../integrations/fbi/browser-launcher.js", () => ({ launchServerlessBrowser: launchServerlessBrowserMock }));

const getFbiCredentialsMock = vi.fn();
vi.mock("../integrations/fbi/credentials-store.js", () => ({ getFbiCredentials: getFbiCredentialsMock }));

const uploadEmarqueFileMock = vi.fn();
vi.mock("../storage/emarque-storage.js", async () => {
  const actual = await vi.importActual<typeof import("../storage/emarque-storage.js")>("../storage/emarque-storage.js");
  return { ...actual, uploadEmarqueFile: uploadEmarqueFileMock };
});

const { processDiscoverEmarqueJob } = await import("./process-discover-emarque.js");

function baseJob(overrides: Partial<FbiJobRow> = {}): FbiJobRow {
  return {
    id: "job-1",
    club_id: "club-1",
    match_id: "match-1",
    type: "discover_emarque",
    status: "claimed",
    attempt_count: 1,
    max_attempts: 6,
    scheduled_at: "2026-01-01T00:00:00.000Z",
    claimed_at: "2026-01-01T00:00:00.000Z",
    claimed_by: "cron#0",
    started_at: null,
    finished_at: null,
    last_error: null,
    result: null,
    // Job créé à l'instant : fenêtre de vérification e-Marque ouverte (voir `nextEmarqueCheckAt`).
    created_at: new Date().toISOString(),
    window_start: null,
    ...overrides,
  };
}

interface Recorders {
  matchUpdates: Array<{ id: string; patch: unknown }>;
  jobUpdates: Array<{ id: string; patch: unknown }>;
  documentInserts: Array<Record<string, unknown>>;
  statusUpserts: unknown[];
  documentResets?: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }>;
}

function makeFakeSupabase(options: { match: { id: string; club_id: string; numero: string | null; match_datetime: string | null } | null; recorders: Recorders; documentInsertConflict?: boolean }) {
  const { match, recorders } = options;

  return {
    from(table: string) {
      if (table === "matches") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve(match ? { data: match, error: null } : { data: null, error: { message: "introuvable" } }),
            }),
          }),
          update: (patch: unknown) => ({
            eq: (_col: string, id: string) => {
              recorders.matchUpdates.push({ id, patch });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === "fbi_jobs") {
        return {
          update: (patch: unknown) => ({
            eq: (_col: string, id: string) => {
              recorders.jobUpdates.push({ id, patch });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === "fbi_integration_status") {
        return {
          upsert: (payload: unknown) => {
            recorders.statusUpserts.push(payload);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "match_documents") {
        return {
          insert: (row: Record<string, unknown>) => {
            if (options.documentInsertConflict) {
              return Promise.resolve({ error: { code: "23505", message: "duplicate" } });
            }
            recorders.documentInserts.push(row);
            return Promise.resolve({ error: null });
          },
          update: (patch: Record<string, unknown>) => {
            const filters: Record<string, unknown> = {};
            const chain = {
              eq: (col: string, value: unknown) => {
                filters[col] = value;
                return chain;
              },
              then: (onFulfilled: (v: { error: null }) => unknown) => {
                recorders.documentResets?.push({ patch, filters });
                return Promise.resolve({ error: null }).then(onFulfilled);
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`Table inattendue dans le fake Supabase de test : ${table}`);
    },
    storage: { from: () => ({ upload: () => Promise.resolve({ error: null }) }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processDiscoverEmarqueJob", () => {
  it("télécharge le ZIP prioritairement, dépose une ligne match_documents et marque le job réussi", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
    loginMock.mockResolvedValue({ context: {}, page: {} });
    findEmarqueDocumentsMock.mockResolvedValue({
      documents: [
        { url: "https://fbi.test/export/2813.zip", fileName: "2813.zip" },
        { url: "https://fbi.test/export/2813-feuille.pdf", fileName: "2813-feuille.pdf" },
      ],
      diagnostic: null,
    });
    downloadDocumentMock.mockResolvedValue(Buffer.from("PK\x03\x04contenu-zip-synthetique", "latin1"));

    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
    const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: "2025-09-27T19:00:00.000Z" }, recorders });

    await processDiscoverEmarqueJob(supabase, baseJob());

    expect(downloadDocumentMock).toHaveBeenCalledTimes(1);
    expect(recorders.documentInserts).toHaveLength(1);
    expect(recorders.documentInserts[0]).toMatchObject({ club_id: "club-1", match_id: "match-1", type: "emarque_zip", status: "downloaded" });
    expect(recorders.jobUpdates.at(-1)).toMatchObject({ id: "job-1", patch: expect.objectContaining({ status: "succeeded" }) });
    expect(recorders.matchUpdates.map((u) => (u.patch as { emarque_status: string }).emarque_status)).toEqual(["downloading", "downloaded"]);
    expect(closeSessionMock).toHaveBeenCalledOnce();
    expect(closeBrowserMock).toHaveBeenCalledOnce();
  });

  it("réponse FBI non-ZIP (fichier pas encore disponible) : rien d'enregistré, match en attente, nouvelle tentative — retour du club 2026-10-02", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
    loginMock.mockResolvedValue({ context: {}, page: {} });
    findEmarqueDocumentsMock.mockResolvedValue({ documents: [{ url: "https://fbi.test/telechargerFeuilleMatchEmarque.fbi?idRenc=x", fileName: "emarque_BU15MN1_6_2.zip" }], diagnostic: null });
    downloadDocumentMock.mockResolvedValue(Buffer.from("<html><body>Aucun fichier</body></html>"));

    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
    const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "6", match_datetime: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }, recorders });

    await processDiscoverEmarqueJob(supabase, baseJob());

    expect(recorders.documentInserts).toHaveLength(0);
    expect(recorders.jobUpdates.at(-1)).toMatchObject({ patch: expect.objectContaining({ status: "pending" }) });
    expect(String((recorders.jobUpdates.at(-1)!.patch as { last_error: string }).last_error)).toContain("pas renvoyé de ZIP e-Marque");
    expect(recorders.matchUpdates.at(-1)).toEqual({ id: "match-1", patch: { emarque_status: "waiting_for_emarque" } });
  });

  it("replanifie (jamais un échec) quand aucun document n'est encore disponible", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
    loginMock.mockResolvedValue({ context: {}, page: {} });
    findEmarqueDocumentsMock.mockResolvedValue({ documents: [], diagnostic: null });

    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
    const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: null }, recorders });

    await processDiscoverEmarqueJob(supabase, baseJob());

    expect(recorders.jobUpdates.at(-1)).toMatchObject({ patch: expect.objectContaining({ status: "pending" }) });
    expect(recorders.matchUpdates).toContainEqual({ id: "match-1", patch: { emarque_status: "waiting_for_emarque" } });
  });

  it("persiste le diagnostic riche dans last_error même quand ce n'est PAS une erreur (§ 'Vingt-septième déclenchement', docs/FBI.md) — consultable directement en base, sans dépendre des logs Vercel", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
    loginMock.mockResolvedValue({ context: {}, page: {} });
    findEmarqueDocumentsMock.mockResolvedValue({ documents: [], diagnostic: "[info, pas une erreur] Page confirmée pour la rencontre 2813 mais aucun document retenu après filtrage." });

    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
    const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: null }, recorders });

    await processDiscoverEmarqueJob(supabase, baseJob());

    expect(recorders.jobUpdates.at(-1)).toMatchObject({
      patch: expect.objectContaining({ status: "pending", last_error: expect.stringContaining("[info, pas une erreur]") }),
    });
  });

  it("replanifie avec l'erreur en last_error (jamais un succès silencieux) quand la page de la rencontre n'est jamais atteinte (régression 2026-09-24)", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
    loginMock.mockResolvedValue({ context: {}, page: {} });
    findEmarqueDocumentsMock.mockRejectedValue(new FbiError("Page de résultat introuvable pour la rencontre 2813", "EMARQUE_MATCH_PAGE_NOT_REACHED"));

    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
    const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: null }, recorders });

    await processDiscoverEmarqueJob(supabase, baseJob());

    expect(recorders.jobUpdates.at(-1)).toMatchObject({ patch: expect.objectContaining({ status: "pending", last_error: expect.stringContaining("2813") }) });
    // Jamais laissé "en erreur" : toujours en attente du créneau suivant (processus déterministe, 2026-10-06).
    expect(recorders.matchUpdates).toContainEqual({ id: "match-1", patch: { emarque_status: "waiting_for_emarque" } });
    expect(recorders.documentInserts).toEqual([]);
  });

  it("FBI injoignable : jamais d'abandon, prochain créneau du calendrier fixe (15 min après un match tout juste terminé)", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
    loginMock.mockRejectedValue(new FbiError("Page de connexion FBI injoignable", "LOGIN_PAGE_UNREACHABLE"));

    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
    const matchStart = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // terminé à l'instant
    const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: matchStart }, recorders });

    await processDiscoverEmarqueJob(supabase, baseJob({ attempt_count: 50 }));

    const patch = recorders.jobUpdates.at(-1)?.patch as { status: string; scheduled_at: string };
    expect(patch.status).toBe("pending");
    const delayMinutes = (new Date(patch.scheduled_at).getTime() - Date.now()) / 60000;
    expect(delayMinutes).toBeGreaterThan(10);
    expect(delayMinutes).toBeLessThanOrEqual(15.1);
  });

  it("7 jours après le match sans feuille : vérifications terminées, match « pas de feuille e-Marque »", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
    loginMock.mockResolvedValue({ context: {}, page: {} });
    findEmarqueDocumentsMock.mockResolvedValue({ documents: [], diagnostic: "[info, pas une erreur] aucun document" });

    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: tenDaysAgo }, recorders });

    await processDiscoverEmarqueJob(supabase, baseJob());

    expect(recorders.jobUpdates.at(-1)).toMatchObject({ patch: expect.objectContaining({ status: "failed", last_error: expect.stringContaining("7 jours") }) });
    expect(recorders.matchUpdates).toContainEqual({ id: "match-1", patch: { emarque_status: "not_available" } });
  });

  it("relance manuelle (window_start) : nouvelle fenêtre de 7 jours même pour un match ancien", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
    loginMock.mockResolvedValue({ context: {}, page: {} });
    findEmarqueDocumentsMock.mockResolvedValue({ documents: [], diagnostic: "[info, pas une erreur] aucun document" });

    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: tenDaysAgo }, recorders });

    await processDiscoverEmarqueJob(supabase, baseJob({ window_start: new Date().toISOString() }));

    expect(recorders.jobUpdates.at(-1)).toMatchObject({ patch: expect.objectContaining({ status: "pending" }) });
  });

  it("marque le job en échec (jamais de retry) sur des identifiants invalides", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "mauvais" });
    loginMock.mockRejectedValue(new FbiError("refusé", "LOGIN_FAILED"));

    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
    const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: null }, recorders });

    await processDiscoverEmarqueJob(supabase, baseJob());

    expect(recorders.jobUpdates.at(-1)).toMatchObject({ patch: expect.objectContaining({ status: "failed" }) });
    expect(findEmarqueDocumentsMock).not.toHaveBeenCalled();
  });

  it("ne re-crée pas de ligne en doublon quand match_documents a déjà cette ligne (idempotence sha256)", async () => {
    getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
    loginMock.mockResolvedValue({ context: {}, page: {} });
    findEmarqueDocumentsMock.mockResolvedValue({ documents: [{ url: "https://fbi.test/export/2813.zip", fileName: "2813.zip" }], diagnostic: null });
    downloadDocumentMock.mockResolvedValue(Buffer.from("PK\x03\x04contenu-zip-synthetique", "latin1"));

    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [], documentResets: [] };
    const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: null }, recorders, documentInsertConflict: true });

    await processDiscoverEmarqueJob(supabase, baseJob());

    expect(recorders.jobUpdates.at(-1)).toMatchObject({ patch: expect.objectContaining({ status: "succeeded" }) });
    expect(recorders.documentInserts).toHaveLength(0);
    // La ligne existante (souvent déjà parsée puis purgée) est remise en file de parsing.
    expect(recorders.documentResets).toHaveLength(1);
    expect(recorders.documentResets?.[0]).toMatchObject({
      patch: expect.objectContaining({ status: "downloaded", purged_at: null }),
      filters: expect.objectContaining({ club_id: "club-1", match_id: "match-1", type: "emarque_zip" }),
    });
  });

  it("échoue proprement (jamais de crash) quand le job n'a pas de match_id", async () => {
    const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
    const supabase = makeFakeSupabase({ match: null, recorders });

    await processDiscoverEmarqueJob(supabase, baseJob({ match_id: null }));

    expect(recorders.jobUpdates.at(-1)).toMatchObject({ patch: expect.objectContaining({ status: "failed" }) });
    expect(getFbiCredentialsMock).not.toHaveBeenCalled();
  });
  describe("une seule connexion FBI pour plusieurs matchs du club (2026-10-06)", () => {
    const zipBytes = Buffer.from("PK\x03\x04contenu-zip-synthetique", "latin1");

    it("se connecte UNE fois et traite les jobs suivants du club dans la même session", async () => {
      getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
      loginMock.mockResolvedValue({ context: {}, page: {} });
      findEmarqueDocumentsMock.mockResolvedValue({ documents: [{ url: "https://fbi.test/export/2813.zip", fileName: "2813.zip" }], diagnostic: null });
      downloadDocumentMock.mockResolvedValue(zipBytes);

      const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
      const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: null }, recorders });
      const queue = [baseJob({ id: "job-2" }), baseJob({ id: "job-3" })];
      const claimNextInSession = vi.fn(async () => queue.shift() ?? null);
      const sessionOutcomes: boolean[] = [];

      const firstSucceeded = await processDiscoverEmarqueJob(supabase, baseJob(), {
        claimNextInSession,
        onSessionJobDone: (ok) => sessionOutcomes.push(ok),
        pauseBetweenMatchesMs: 0,
      });

      expect(firstSucceeded).toBe(true);
      expect(sessionOutcomes).toEqual([true, true]);
      expect(loginMock).toHaveBeenCalledTimes(1);
      expect(launchServerlessBrowserMock).toHaveBeenCalledTimes(1);
      expect(findEmarqueDocumentsMock).toHaveBeenCalledTimes(3);
      expect(claimNextInSession).toHaveBeenCalledTimes(3);
      const succeededJobs = recorders.jobUpdates.filter((u) => (u.patch as { status: string }).status === "succeeded").map((u) => u.id);
      expect(succeededJobs).toEqual(["job-1", "job-2", "job-3"]);
      expect(closeSessionMock).toHaveBeenCalledOnce();
      expect(closeBrowserMock).toHaveBeenCalledOnce();
    });

    it("erreur FBI en cours de session : n'enchaîne pas d'autre match (repris au prochain passage)", async () => {
      getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
      loginMock.mockResolvedValue({ context: {}, page: {} });
      findEmarqueDocumentsMock.mockRejectedValue(new Error("Failed to fetch"));

      const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
      const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: null }, recorders });
      const claimNextInSession = vi.fn(async () => baseJob({ id: "job-2" }));

      await processDiscoverEmarqueJob(supabase, baseJob(), { claimNextInSession, pauseBetweenMatchesMs: 0 });

      expect(claimNextInSession).not.toHaveBeenCalled();
      expect(recorders.jobUpdates.at(-1)).toMatchObject({ id: "job-1", patch: expect.objectContaining({ status: "pending" }) });
    });

    it("temps de session écoulé : aucun nouveau match démarré", async () => {
      getFbiCredentialsMock.mockResolvedValue({ username: "clubxxxx", password: "correct" });
      loginMock.mockResolvedValue({ context: {}, page: {} });
      findEmarqueDocumentsMock.mockResolvedValue({ documents: [], diagnostic: null });

      const recorders: Recorders = { matchUpdates: [], jobUpdates: [], documentInserts: [], statusUpserts: [] };
      const supabase = makeFakeSupabase({ match: { id: "match-1", club_id: "club-1", numero: "2813", match_datetime: null }, recorders });
      const claimNextInSession = vi.fn(async () => baseJob({ id: "job-2" }));

      await processDiscoverEmarqueJob(supabase, baseJob(), { claimNextInSession, newJobBudgetMs: 0, pauseBetweenMatchesMs: 0 });

      expect(claimNextInSession).not.toHaveBeenCalled();
      expect(findEmarqueDocumentsMock).toHaveBeenCalledTimes(1);
    });
  });
});
