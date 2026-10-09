import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";
import { resetEnvCacheForTests } from "../../config/env.js";
import { notifyFbiDerogationEvents } from "./notify.js";
import type { DbClient } from "../../db/client.js";

const CLUB = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "A1", ffbb_enabled: true, ffbb_next_sync_at: null };

let state: FakeClubSupabaseState;
let sent: { to: string[]; subject: string; text: string }[];

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_not_real";
  resetEnvCacheForTests();
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "e" }), { status: 200 });
    }),
  );
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB }],
    licencies: [
      { id: "c1", club_id: CLUB.id, first_name: "Claire", last_name: "C", license_number: null, birth_date: null, email: "claire@club-a.test", phone: null, photo_url: null, active: true, public_coordinator: true },
      { id: "c2", club_id: CLUB.id, first_name: "Sans", last_name: "Mail", license_number: null, birth_date: null, email: null, phone: null, photo_url: null, active: true, public_coordinator: true },
    ],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  resetEnvCacheForTests();
});

describe("notifyFbiDerogationEvents — un email récapitulatif, une seule fois par événement", () => {
  const db = () => buildFakeClubSupabase(state) as unknown as DbClient;
  const incoming = { kind: "incoming" as const, refKey: "d1", line: "CLUB A – ADVERSAIRE — demandé 12/10/2026 à 10:30" };

  it("envoie aux coordinateurs ayant un email, avec le lien vers les dérogations de l'espace public", async () => {
    expect(await notifyFbiDerogationEvents(db(), CLUB.id, [incoming, { kind: "outcome", refKey: "d2:Refusée", line: "CLUB A – AUTRE : Refusée" }])).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["claire@club-a.test"]);
    expect(sent[0]!.subject).toBe("FBI : 1 dérogation à traiter, 1 réponse reçue — Club A");
    expect(sent[0]!.text).toContain("CLUB A – ADVERSAIRE — demandé 12/10/2026 à 10:30");
    expect(sent[0]!.text).toContain("/public/club-a/derogations");
  });

  it("la vérification du lendemain ne renvoie rien pour un événement déjà signalé", async () => {
    await notifyFbiDerogationEvents(db(), CLUB.id, [incoming]);
    expect(await notifyFbiDerogationEvents(db(), CLUB.id, [incoming])).toBe(0);
    expect(sent).toHaveLength(1);
    expect(state.derogationNotifications).toHaveLength(1);
  });
});
