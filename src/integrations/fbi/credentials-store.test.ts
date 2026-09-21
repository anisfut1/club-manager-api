import { beforeEach, describe, expect, it } from "vitest";
import { getFbiCredentials, getFbiUsername, saveFbiCredentials } from "./credentials-store";

interface FakeRow {
  club_id: string;
  username: string;
  password_ciphertext: string;
  password_iv: string;
  password_auth_tag: string;
}

function makeFakeSupabase(rows: Map<string, FakeRow>) {
  return {
    from(table: string) {
      if (table === "fbi_integration_status") {
        return { upsert: () => Promise.resolve({ error: null }) };
      }
      if (table !== "fbi_credentials") throw new Error(`Table inattendue : ${table}`);
      return {
        upsert: (row: Record<string, unknown>) => {
          rows.set(row.club_id as string, row as unknown as FakeRow);
          return Promise.resolve({ error: null });
        },
        select: () => ({
          eq: (_col: string, clubId: string) => ({
            maybeSingle: () => Promise.resolve({ data: rows.get(clubId) ?? null, error: null }),
          }),
        }),
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("saveFbiCredentials / getFbiCredentials", () => {
  let rows: Map<string, FakeRow>;

  beforeEach(() => {
    rows = new Map();
  });

  it("round-trip : déchiffre exactement le mot de passe enregistré", async () => {
    const supabase = makeFakeSupabase(rows);
    await saveFbiCredentials(supabase, "club-a", { username: "clubA-fbi", password: "s3cret" }, "user-1");

    const credentials = await getFbiCredentials(supabase, "club-a");
    expect(credentials).toEqual({ username: "clubA-fbi", password: "s3cret" });
  });

  it("renvoie null quand aucun identifiant n'est enregistré (FBI facultatif)", async () => {
    const supabase = makeFakeSupabase(rows);
    expect(await getFbiCredentials(supabase, "club-sans-fbi")).toBeNull();
  });

  it("isole strictement deux clubs : jamais de fuite de mot de passe entre clubs (AAD=club_id)", async () => {
    const supabase = makeFakeSupabase(rows);
    await saveFbiCredentials(supabase, "club-a", { username: "clubA", password: "secretA" }, "user-1");
    await saveFbiCredentials(supabase, "club-b", { username: "clubB", password: "secretB" }, "user-2");

    expect(await getFbiCredentials(supabase, "club-a")).toEqual({ username: "clubA", password: "secretA" });
    expect(await getFbiCredentials(supabase, "club-b")).toEqual({ username: "clubB", password: "secretB" });
  });

  it("le ciphertext stocké ne contient jamais le mot de passe en clair", async () => {
    const supabase = makeFakeSupabase(rows);
    await saveFbiCredentials(supabase, "club-a", { username: "clubA", password: "mot-de-passe-tres-secret" }, "user-1");

    expect(rows.get("club-a")!.password_ciphertext).not.toContain("mot-de-passe-tres-secret");
  });
});

describe("getFbiUsername", () => {
  it("renvoie l'identifiant sans jamais exposer le mot de passe", async () => {
    const rows = new Map<string, FakeRow>();
    const supabase = makeFakeSupabase(rows);
    await saveFbiCredentials(supabase, "club-a", { username: "clubA-fbi", password: "secret" }, "user-1");

    expect(await getFbiUsername(supabase, "club-a")).toBe("clubA-fbi");
  });

  it("renvoie null quand aucun identifiant n'est enregistré", async () => {
    const supabase = makeFakeSupabase(new Map());
    expect(await getFbiUsername(supabase, "club-a")).toBeNull();
  });
});
