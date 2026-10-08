import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let users: { id: string; email: string; last_sign_in_at: string | null }[] = [];
let links: { type: string; email: string }[] = [];
let sent: { to: string[]; subject: string; text: string }[] = [];

const fakeDb = {
  auth: {
    admin: {
      listUsers: async () => ({ data: { users }, error: null }),
      generateLink: async ({ type, email }: { type: string; email: string }) => {
        links.push({ type, email });
        return { data: { user: users.find((u) => u.email === email) ?? { id: "new", email }, properties: { hashed_token: `hash-${type}`, verification_type: type } }, error: null };
      },
    },
  },
};

vi.mock("../../db/client.js", () => ({
  createServiceSupabaseClient: () => fakeDb,
  createUserSupabaseClient: () => fakeDb,
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");
const { resetEnvCacheForTests } = await import("../../config/env.js");
const { provisionClubAccount } = await import("../../auth/account-invites.js");

function reset(email: string) {
  return app.request("/v1/account/password-reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_not_real";
  process.env.PUBLIC_APP_URL = "https://www.app.test";
  resetEnvCacheForTests();
  users = [{ id: "u1", email: "lea@club.test", last_sign_in_at: "2026-10-01T10:00:00Z" }];
  links = [];
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "e" }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  delete process.env.PUBLIC_APP_URL;
  resetEnvCacheForTests();
});

describe("POST /v1/account/password-reset", () => {
  it("envoie un email Ball Manager vers /bienvenue (type recovery)", async () => {
    const res = await reset("Lea@Club.test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(links).toEqual([{ type: "recovery", email: "lea@club.test" }]);
    expect(sent[0]!.subject).toBe("Ton nouveau mot de passe Ball Manager");
    expect(sent[0]!.text).toContain("https://www.app.test/bienvenue?token_hash=hash-recovery&type=recovery&next=%2F");
  });

  it("même réponse sans compte, et rien n'est envoyé", async () => {
    const res = await reset("inconnu@club.test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(links).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("une seule demande par minute et par adresse", async () => {
    await reset("anti-rafale@club.test");
    users.push({ id: "u2", email: "anti-rafale@club.test", last_sign_in_at: null });
    await reset("anti-rafale@club.test");
    expect(links).toEqual([]);
  });

  it("400 sur une adresse invalide", async () => {
    expect((await reset("pas-un-email")).status).toBe(400);
  });
});

describe("provisionClubAccount", () => {
  const club = { slug: "club-a", name: "Club A", logoUrl: null, accentColor: null };

  it("compte jamais utilisé : nouvelle invitation (lien à usage unique), pas un « connecte-toi »", async () => {
    users.push({ id: "u3", email: "jamais@club.test", last_sign_in_at: null });
    const account = await provisionClubAccount(fakeDb as never, { email: "jamais@club.test", club, roles: ["coach"] });
    expect(account).toMatchObject({ userId: "u3", emailKind: "invite" });
    expect(links).toEqual([{ type: "magiclink", email: "jamais@club.test" }]);
    expect(sent).toEqual([]); // rien ne part avant l'enregistrement du rattachement
    await account.sendEmail();
    expect(sent[0]!.text).toContain("en tant que coach");
  });
});
