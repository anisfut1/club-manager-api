import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";

let state: FakeClubSupabaseState;
let authUsers: { id: string; email: string; last_sign_in_at?: string | null }[] = [];
let invited: string[] = [];
let sentEmails: { to: string[]; subject: string; html: string; text: string; from: string }[] = [];

vi.mock("../../auth/jwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/jwt.js")>();
  return { ...actual, verifyAccessToken: vi.fn(async () => ({ id: "platform", email: "platform@example.test" })) };
});

function fakeWithAuth() {
  return Object.assign(buildFakeClubSupabase(state), {
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: authUsers }, error: null }),
        getUserById: async (id: string) => ({ data: { user: authUsers.find((u) => u.id === id) ?? null }, error: null }),
        generateLink: async ({ type, email }: { type: string; email: string }) => {
          let user = authUsers.find((u) => u.email === email);
          if (type === "invite") {
            invited.push(email);
            user = { id: `invited-${invited.length}`, email, last_sign_in_at: null };
            authUsers.push(user);
          }
          return { data: { user, properties: { hashed_token: `hash-${type}`, verification_type: type } }, error: null };
        },
      },
    },
  });
}

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => fakeWithAuth(),
  createServiceSupabaseClient: () => fakeWithAuth(),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");
const { resetEnvCacheForTests } = await import("../../config/env.js");

const CLUB_A = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "A1", ffbb_enabled: true, ffbb_next_sync_at: null };
const M_ADMIN = "44444444-4444-4444-8444-00000000000a";
const M_COACH = "44444444-4444-4444-8444-00000000000b";

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`/v1/platform/clubs/${CLUB_A.id}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: "Bearer test-jwt", "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_not_real";
  process.env.PUBLIC_APP_URL = "https://www.app.test";
  resetEnvCacheForTests();
  sentEmails = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sentEmails.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    }),
  );
  authUsers = [
    { id: "admin", email: "admin@club-a.test", last_sign_in_at: "2026-10-01T10:00:00Z" },
    { id: "coach", email: "coach@club-a.test", last_sign_in_at: "2026-10-01T10:00:00Z" },
  ];
  invited = [];
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }],
    memberships: [
      { id: M_ADMIN, club_id: CLUB_A.id, user_id: "admin", status: "active" },
      { id: M_COACH, club_id: CLUB_A.id, user_id: "coach", status: "active" },
    ],
    roles: [
      { membership_id: M_ADMIN, role: "club_admin", scope_team_id: null },
      { membership_id: M_COACH, role: "coach", scope_team_id: null },
    ],
    isPlatformAdmin: true,
  });
});

const adminsOf = (body: { members: { email: string | null; roles: { role: string }[] }[] }) =>
  body.members.filter((m) => m.roles.some((r) => r.role === "club_admin")).map((m) => m.email);

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  delete process.env.PUBLIC_APP_URL;
  resetEnvCacheForTests();
});

describe("platform_admin : administrateurs d'un club", () => {
  it("liste les membres et leurs rôles, sans être membre du club", async () => {
    const res = await request("/members");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.club).toEqual({ id: CLUB_A.id, slug: "club-a", name: "Club A" });
    expect(adminsOf(body)).toEqual(["admin@club-a.test"]);
  });

  it("nomme un membre existant administrateur en gardant ses autres rôles", async () => {
    const res = await request("/admins", { method: "POST", body: { email: "Coach@Club-A.test" } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(adminsOf(body).sort()).toEqual(["admin@club-a.test", "coach@club-a.test"]);
    expect(body.members.find((m: { email: string }) => m.email === "coach@club-a.test").roles.map((r: { role: string }) => r.role).sort()).toEqual(["club_admin", "coach"]);
    expect(invited).toEqual([]);
    // Compte déjà utilisé : email Ball Manager « nouvel accès », jamais une invitation Supabase.
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toEqual(["coach@club-a.test"]);
    expect(sentEmails[0]!.subject).toBe("Nouvel accès : Club A");
    expect(sentEmails[0]!.html).toContain("https://www.app.test/c/club-a/dashboard");
  });

  it("invite un compte inconnu puis le nomme administrateur", async () => {
    const res = await request("/admins", { method: "POST", body: { email: "nouveau@club-a.test" } });
    expect(res.status).toBe(201);
    expect(invited).toEqual(["nouveau@club-a.test"]);
    expect(adminsOf(await res.json())).toContain("nouveau@club-a.test");
    expect(sentEmails[0]!.subject).toBe("Invitation : Club A sur Ball Manager");
    expect(sentEmails[0]!.text).toContain("https://www.app.test/bienvenue?token_hash=hash-invite&type=invite&next=%2Fc%2Fclub-a%2Fdashboard");
    expect(sentEmails[0]!.from).toContain("Ball Manager");
  });

  it("retire le rôle administrateur, jamais au dernier", async () => {
    const last = await request(`/admins/${M_ADMIN}`, { method: "DELETE" });
    expect(last.status).toBe(409);
    expect((await last.json()).error.code).toBe("LAST_CLUB_ADMIN");

    await request("/admins", { method: "POST", body: { email: "coach@club-a.test" } });
    const res = await request(`/admins/${M_ADMIN}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(adminsOf(await res.json())).toEqual(["coach@club-a.test"]);
  });

  it("réservé au platform_admin ; club inconnu = 404", async () => {
    state.isPlatformAdmin = false;
    expect((await request("/members")).status).toBe(403);
    state.isPlatformAdmin = true;
    expect((await app.request("/v1/platform/clubs/pas-un-uuid/members", { headers: { authorization: "Bearer test-jwt" } })).status).toBe(404);
  });
});
