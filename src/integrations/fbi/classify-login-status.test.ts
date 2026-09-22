import { describe, expect, it } from "vitest";
import { classifyFbiLoginStatus, FbiError } from "./errors.js";

describe("classifyFbiLoginStatus", () => {
  it("renvoie CONNECTED en l'absence d'erreur", () => {
    expect(classifyFbiLoginStatus(null)).toBe("CONNECTED");
    expect(classifyFbiLoginStatus(undefined)).toBe("CONNECTED");
  });

  it("renvoie INVALID_CREDENTIALS pour LOGIN_FAILED (jamais auto-retried, §15 du brief FBI)", () => {
    expect(classifyFbiLoginStatus(new FbiError("m", "LOGIN_FAILED"))).toBe("INVALID_CREDENTIALS");
  });

  it("renvoie FBI_UNAVAILABLE pour une panne transitoire", () => {
    expect(classifyFbiLoginStatus(new FbiError("m", "LOGIN_PAGE_UNREACHABLE"))).toBe("FBI_UNAVAILABLE");
    expect(classifyFbiLoginStatus(new FbiError("m", "REQUEST_FAILED"))).toBe("FBI_UNAVAILABLE");
    expect(classifyFbiLoginStatus(new FbiError("m", "NAVIGATION_FAILED"))).toBe("FBI_UNAVAILABLE");
  });

  it("renvoie AUTH_FLOW_CHANGED quand le formulaire n'est pas reconnu", () => {
    expect(classifyFbiLoginStatus(new FbiError("m", "LOGIN_FORM_NOT_RECOGNIZED"))).toBe("AUTH_FLOW_CHANGED");
  });

  it("renvoie UNKNOWN_ERROR pour une erreur qui n'est pas une FbiError", () => {
    expect(classifyFbiLoginStatus(new Error("boom"))).toBe("UNKNOWN_ERROR");
  });
});
