import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../api-error.js";

interface FakeClub {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  logo_url: string | null;
  accent_color: string | null;
  timezone: string;
  status: "active" | "suspended";
  ffbb_club_id: string;
  ffbb_enabled: boolean;
  ffbb_next_sync_at: string | null;
}

interface FakeMembership {
  id: string;
  club_id: string;
  user_id: string;
  status: "active" | "suspended";
}

interface FakeRoleRow {
  membership_id: string;
  role: string;
}

function buildFakeSupabase(state: { clubs: FakeClub[]; memberships: FakeMembership[]; roles: FakeRoleRow[] }) {
  return {
    from(table: string) {
      if (table === "clubs") {
        return {
          select: () => ({
            eq: (col: string, value: string) => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: state.clubs.find((c) => (col === "id" ? c.id === value : c.slug === value)) ?? null,
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "club_memberships") {
        return {
          select: () => ({
            eq: (_c1: string, clubId: string) => ({
              eq: (_c2: string, userId: string) => ({
                eq: (_c3: string, status: string) => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: state.memberships.find((m) => m.club_id === clubId && m.user_id === userId && m.status === status) ?? null,
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "membership_roles") {
        return {
          select: () => ({
            eq: (_col: string, membershipId: string) => Promise.resolve({ data: state.roles.filter((r) => r.membership_id === membershipId), error: null }),
          }),
        };
      }
      throw new Error(`Table inattendue dans le fake Supabase de test : ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

import { getClubContext, requireClubContext } from "./club-context.js";

const CLUB_A: FakeClub = {
  id: "aaaaaaaa-0000-0000-0000-000000000000",
  slug: "club-a",
  name: "Club A Basket",
  short_name: null,
  logo_url: null,
  accent_color: null,
  timezone: "Europe/Paris",
  status: "active",
  ffbb_club_id: "AAA0000001",
  ffbb_enabled: true,
  ffbb_next_sync_at: null,
};

const CLUB_B: FakeClub = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b", name: "Club B Basket", ffbb_club_id: "BBB0000002" };

let fakeSupabaseState: { clubs: FakeClub[]; memberships: FakeMembership[]; roles: FakeRoleRow[] };

beforeEach(() => {
  fakeSupabaseState = {
    clubs: [CLUB_A, CLUB_B],
    memberships: [
      { id: "membership-a1", club_id: CLUB_A.id, user_id: "user-a", status: "active" },
      { id: "membership-b1", club_id: CLUB_B.id, user_id: "user-b", status: "active" },
    ],
    roles: [
      { membership_id: "membership-a1", role: "club_admin" },
      { membership_id: "membership-b1", role: "joueur" },
    ],
  };
});

describe("getClubContext", () => {
  it("résout par UUID", async () => {
    const supabase = buildFakeSupabase(fakeSupabaseState);
    const context = await getClubContext(supabase, CLUB_A.id, "user-a");
    expect(context?.club.slug).toBe("club-a");
  });

  it("résout par slug", async () => {
    const supabase = buildFakeSupabase(fakeSupabaseState);
    const context = await getClubContext(supabase, "club-a", "user-a");
    expect(context?.club.id).toBe(CLUB_A.id);
  });

  it("renvoie null si le club n'existe pas", async () => {
    const supabase = buildFakeSupabase(fakeSupabaseState);
    expect(await getClubContext(supabase, "club-inexistant", "user-a")).toBeNull();
  });

  it("renvoie null si l'utilisateur n'est PAS membre du club (isolation cross-tenant, jamais distinguable de 'club inexistant')", async () => {
    const supabase = buildFakeSupabase(fakeSupabaseState);
    expect(await getClubContext(supabase, "club-b", "user-a")).toBeNull();
  });

  it("renvoie le contexte complet (club + rôles) pour un membre actif", async () => {
    const supabase = buildFakeSupabase(fakeSupabaseState);
    const context = await getClubContext(supabase, "club-a", "user-a");
    expect(context?.membershipId).toBe("membership-a1");
    expect(context?.roles).toEqual(["club_admin"]);
  });

  it("ne mélange jamais les rôles de deux clubs différents pour un même utilisateur", async () => {
    fakeSupabaseState.memberships.push({ id: "membership-a2", club_id: CLUB_A.id, user_id: "user-b", status: "active" });
    fakeSupabaseState.roles.push({ membership_id: "membership-a2", role: "coach" });
    const supabase = buildFakeSupabase(fakeSupabaseState);

    const contextInA = await getClubContext(supabase, "club-a", "user-b");
    const contextInB = await getClubContext(supabase, "club-b", "user-b");

    expect(contextInA?.roles).toEqual(["coach"]);
    expect(contextInB?.roles).toEqual(["joueur"]);
  });

  it("renvoie null pour un membership suspendu", async () => {
    fakeSupabaseState.memberships[0]!.status = "suspended";
    const supabase = buildFakeSupabase(fakeSupabaseState);
    expect(await getClubContext(supabase, "club-a", "user-a")).toBeNull();
  });
});

describe("requireClubContext", () => {
  it("lève une ApiError NOT_FOUND (jamais FORBIDDEN) pour un non-membre", async () => {
    const supabase = buildFakeSupabase(fakeSupabaseState);
    await expect(requireClubContext(supabase, "club-b", "user-a")).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<ApiError>);
  });

  it("renvoie le contexte pour un membre valide", async () => {
    const supabase = buildFakeSupabase(fakeSupabaseState);
    const context = await requireClubContext(supabase, "club-a", "user-a");
    expect(context.club.slug).toBe("club-a");
  });
});
