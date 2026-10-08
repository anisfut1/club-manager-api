import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";
import { buildFbiLicenceXlsx, licenceRow } from "../../test-support/fbi-licence-xlsx.js";

/**
 * Import des licenciés depuis FBI (retour du club, 2026-10-08 : « un
 * système qui importe automatiquement les licenciés… pour les nuls ») —
 * dépôt du fichier Excel FBI tel quel, mise à jour depuis FBI à la demande,
 * état affiché à l'admin. Données fictives uniquement.
 */

let state: FakeClubSupabaseState;
let currentUserId = "user-admin";

vi.mock("../../auth/jwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/jwt.js")>();
  return { ...actual, verifyAccessToken: vi.fn(async () => ({ id: currentUserId, email: `${currentUserId}@example.test` })) };
});

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

const CLUB_A = {
  id: "aaaaaaaa-0000-0000-0000-000000000000",
  slug: "club-a",
  name: "Club A Basket",
  short_name: null,
  logo_url: null,
  accent_color: null,
  timezone: "Europe/Paris",
  status: "active" as const,
  ffbb_club_id: "AAA0000001",
  ffbb_enabled: true,
  ffbb_next_sync_at: null,
};
const CLUB_B = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b" };

function licencie(overrides: Partial<FakeLicencieRow>): FakeLicencieRow {
  return {
    id: `l-${Math.random().toString(36).slice(2)}`,
    club_id: CLUB_A.id,
    first_name: "Prénom",
    last_name: "NOM",
    license_number: null,
    birth_date: null,
    email: null,
    phone: null,
    photo_url: null,
    team_id: null,
    active: true,
    ffbb_licence_id: null,
    category_label: null,
    sexe: null,
    ...overrides,
  };
}

async function upload(rows: string[][], clubId = CLUB_A.id) {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(await buildFbiLicenceXlsx(rows))], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "rechercherLicence.xlsx");
  return app.request(`/v1/clubs/${clubId}/licencies/import/file`, { method: "POST", headers: { authorization: "Bearer test-jwt" }, body: form });
}

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}/licencies${path}`, { ...init, headers: { authorization: "Bearer test-jwt", ...init.headers } });
}

beforeEach(() => {
  currentUserId = "user-admin";
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    memberships: [
      { id: "membership-admin", club_id: CLUB_A.id, user_id: "user-admin", status: "active" },
      { id: "membership-coach", club_id: CLUB_A.id, user_id: "user-coach", status: "active" },
    ],
    roles: [
      { membership_id: "membership-admin", role: "club_admin" },
      { membership_id: "membership-coach", role: "coach" },
    ],
  });
});

describe("POST …/licencies/import/file — l'admin dépose le fichier Excel FBI tel quel", () => {
  it("ajoute les nouveaux, met à jour catégorie/numéro, ne touche JAMAIS aux noms, emails, équipes corrigés à la main", async () => {
    state.licencies = [
      licencie({ id: "known", ffbb_licence_id: "100", first_name: "Léa (corrigé)", last_name: "Martin", license_number: "BC000001", category_label: "U14", sexe: "F", email: "lea@example.test", team_id: "team-1" }),
      licencie({ id: "other-club", club_id: CLUB_B.id, ffbb_licence_id: "200" }),
    ];

    const res = await upload([
      licenceRow({ id: "100", numero: "BC000099", nom: "MARTIN", prenom: "Lea", categorie: "U15", sexe: "F" }),
      licenceRow({ id: "200", numero: "BC000002", nom: "NOUVEAU", prenom: "Tom", categorie: "U11", sexe: "M", naissance: "09/09/2016" }),
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 2, inserted: 1, updated: 1, reactivated: 0, unchanged: 0, notInExport: 0 });

    const known = state.licencies.find((l) => l.id === "known")!;
    expect(known).toMatchObject({ first_name: "Léa (corrigé)", last_name: "Martin", email: "lea@example.test", team_id: "team-1", category_label: "U15", license_number: "BC000099" });

    // Le N° national « 200 » d'un AUTRE club ne compte pas : nouvelle fiche dans ce club.
    const created = state.licencies.find((l) => l.club_id === CLUB_A.id && l.ffbb_licence_id === "200")!;
    expect(created).toMatchObject({ first_name: "Tom", last_name: "NOUVEAU", license_number: "BC000002", birth_date: "2016-09-09", category_label: "U11", sexe: "M" });
    expect(state.licenceImportRuns).toEqual([expect.objectContaining({ club_id: CLUB_A.id, source: "file", created_by: "user-admin", inserted: 1, updated: 1 })]);
  });

  it("rattache une fiche créée sans N° national (e-Marque, ajout manuel) par son numéro de licence, au lieu de la dupliquer", async () => {
    state.licencies = [licencie({ id: "from-emarque", license_number: "VT780264", first_name: "Jean", last_name: "DUPONT" })];
    const res = await upload([licenceRow({ id: "271056", numero: "vt780264", nom: "DUPONT", prenom: "Jean", categorie: "Seniors", sexe: "M" })]);
    expect(await res.json()).toMatchObject({ inserted: 0, updated: 1 });
    expect(state.licencies.filter((l) => l.club_id === CLUB_A.id)).toHaveLength(1);
    expect(state.licencies[0]).toMatchObject({ id: "from-emarque", ffbb_licence_id: "271056", category_label: "Seniors" });
  });

  it("réactive une fiche désactivée qui réapparaît ; compte (sans les désactiver) les joueurs absents de l'export", async () => {
    state.licencies = [licencie({ id: "back", ffbb_licence_id: "1", active: false, category_label: "U13" }), licencie({ id: "gone", ffbb_licence_id: "2", category_label: "U13" })];
    const res = await upload([licenceRow({ id: "1", numero: "BC1", nom: "A", prenom: "B", categorie: "U13" })]);
    expect(await res.json()).toEqual({ total: 1, inserted: 0, updated: 0, reactivated: 1, unchanged: 0, notInExport: 1 });
    expect(state.licencies.find((l) => l.id === "back")?.active).toBe(true);
    expect(state.licencies.find((l) => l.id === "gone")?.active).toBe(true);
  });

  it("le même fichier une deuxième fois ne change rien", async () => {
    const rows = [licenceRow({ id: "1", numero: "BC1", nom: "A", prenom: "B" }), licenceRow({ id: "2", numero: "BC2", nom: "C", prenom: "D" })];
    await upload(rows);
    const again = await upload(rows);
    expect(await again.json()).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(state.licencies.filter((l) => l.club_id === CLUB_A.id)).toHaveLength(2);
  });

  it("message clair si ce n'est pas le bon fichier ; 403 pour un non-admin", async () => {
    const form = new FormData();
    form.append("file", new Blob(["pas un excel"]), "notes.txt");
    const bad = await app.request(`/v1/clubs/${CLUB_A.id}/licencies/import/file`, { method: "POST", headers: { authorization: "Bearer test-jwt" }, body: form });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("NOT_AN_XLSX");

    currentUserId = "user-coach";
    expect((await upload([licenceRow({ id: "1", numero: "BC1", nom: "A", prenom: "B" })])).status).toBe(403);
    expect(state.licencies).toHaveLength(0);
  });
});

describe("POST …/licencies/import/fbi et GET …/import/status — « Mettre à jour depuis FBI »", () => {
  it("409 FBI_NOT_CONFIGURED sans identifiants FBI", async () => {
    const res = await request("/import/fbi", { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FBI_NOT_CONFIGURED");
  });

  it("empile UN job import_licences (un second clic réutilise le même), visible dans le statut", async () => {
    state.fbiIntegrationStatus = [{ club_id: CLUB_A.id, configured: true } as never];
    const first = await request("/import/fbi", { method: "POST" });
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as { jobId: string };
    const second = (await (await request("/import/fbi", { method: "POST" })).json()) as { jobId: string; alreadyQueued: boolean };
    expect(second).toEqual({ jobId, alreadyQueued: true });
    expect(state.fbiJobs.filter((j) => j.type === "import_licences")).toHaveLength(1);

    const status = (await (await request("/import/status")).json()) as { fbiConfigured: boolean; job: { id: string; status: string } | null; lastRun: unknown };
    expect(status.fbiConfigured).toBe(true);
    expect(status.job).toMatchObject({ id: jobId, status: "pending" });
    expect(status.lastRun).toBeNull();
  });

  it("le statut montre la dernière mise à jour (compteurs seulement)", async () => {
    await upload([licenceRow({ id: "1", numero: "BC1", nom: "A", prenom: "B" })]);
    const status = (await (await request("/import/status")).json()) as { lastRun: Record<string, unknown> };
    expect(status.lastRun).toMatchObject({ source: "file", total: 1, inserted: 1, notInExport: 0 });
  });
});
