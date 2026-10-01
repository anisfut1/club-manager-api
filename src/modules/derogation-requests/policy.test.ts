import { describe, expect, it } from "vitest";
import { availableActions, canCreateForTeam, canPerformAction, canPropose, canReadRequest, nextStatus, type Actor, type RequestRef } from "./policy.js";

const COACH_U15: Actor = { userId: "coach-u15", roles: [{ role: "coach", scopeTeamId: "team-u15" }] };
const COACH_U18: Actor = { userId: "coach-u18", roles: [{ role: "coach", scopeTeamId: "team-u18" }] };
const COORDINATOR: Actor = { userId: "coord", roles: [{ role: "correspondant_club", scopeTeamId: null }] };
const ADMIN: Actor = { userId: "admin", roles: [{ role: "club_admin", scopeTeamId: null }] };
const PLAYER: Actor = { userId: "player", roles: [{ role: "joueur", scopeTeamId: null }] };

const request = (overrides: Partial<RequestRef> = {}): RequestRef => ({ teamId: "team-u15", createdByUserId: "coach-u15", status: "REQUESTED", ...overrides });

describe("création (§67, §101)", () => {
  it("coach U15 → match U15 OK ; match U18 refusé ; joueur refusé ; admin OK", () => {
    expect(canCreateForTeam(COACH_U15, "team-u15")).toBe(true);
    expect(canCreateForTeam(COACH_U15, "team-u18")).toBe(false);
    expect(canCreateForTeam(PLAYER, "team-u15")).toBe(false);
    expect(canCreateForTeam(ADMIN, "team-u18")).toBe(true);
  });

  it("un coach à portée club entière encadre toutes les équipes", () => {
    expect(canCreateForTeam({ userId: "c", roles: [{ role: "coach", scopeTeamId: null }] }, "team-u18")).toBe(true);
  });
});

describe("lecture du fil (§68, §102)", () => {
  it("coach sans rapport → refusé ; demandeur → OK ; coordinateur → OK", () => {
    expect(canReadRequest(COACH_U18, request())).toBe(false);
    expect(canReadRequest(COACH_U15, request())).toBe(true);
    expect(canReadRequest(COORDINATOR, request())).toBe(true);
    expect(canReadRequest(ADMIN, request())).toBe(true);
    expect(canReadRequest(PLAYER, request())).toBe(false);
  });
});

describe("transitions (§103)", () => {
  it.each([
    ["TAKE_IN_CHARGE", "REQUESTED", "IN_PROGRESS"],
    ["REQUEST_CHANGE", "REQUESTED", "NEEDS_CHANGE"],
    ["TAKE_IN_CHARGE", "NEEDS_CHANGE", "IN_PROGRESS"],
    ["COMPLETE", "IN_PROGRESS", "COMPLETED"],
    ["CANCEL", "IN_PROGRESS", "CANCELLED"],
  ] as const)("%s depuis %s → %s", (action, from, to) => {
    expect(nextStatus(action, from)).toBe(to);
  });

  it.each([
    ["COMPLETE", "REQUESTED"],
    ["TAKE_IN_CHARGE", "COMPLETED"],
    ["CANCEL", "COMPLETED"],
    ["CANCEL", "CANCELLED"],
    ["REQUEST_CHANGE", "NEEDS_CHANGE"],
  ] as const)("%s depuis %s refusé", (action, from) => {
    expect(nextStatus(action, from)).toBeNull();
  });

  it("seul le coordinateur/admin traite ; le coach peut annuler sa demande", () => {
    expect(canPerformAction(COACH_U15, request(), "TAKE_IN_CHARGE")).toBe(false);
    expect(canPerformAction(COORDINATOR, request(), "TAKE_IN_CHARGE")).toBe(true);
    expect(canPerformAction(COACH_U15, request(), "CANCEL")).toBe(true);
    expect(canPerformAction(COACH_U18, request(), "CANCEL")).toBe(false);
    expect(availableActions(COORDINATOR, request({ status: "IN_PROGRESS" }))).toEqual(["REQUEST_CHANGE", "COMPLETE", "CANCEL"]);
    expect(availableActions(COACH_U15, request({ status: "NEEDS_CHANGE" }))).toEqual(["CANCEL"]);
  });

  it("le coach repropose un créneau après « Nouveau créneau demandé », jamais une fois en cours de traitement", () => {
    expect(canPropose(COACH_U15, request({ status: "NEEDS_CHANGE" }))).toBe(true);
    expect(canPropose(COACH_U15, request({ status: "IN_PROGRESS" }))).toBe(false);
    expect(canPropose(COACH_U18, request({ status: "NEEDS_CHANGE" }))).toBe(false);
  });
});
