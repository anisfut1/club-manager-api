import { describe, expect, it } from "vitest";
import { SimpleCookieJar } from "./cookie-jar";

function headersWithSetCookie(values: string[]): Headers {
  const headers = new Headers();
  for (const value of values) headers.append("set-cookie", value);
  return headers;
}

describe("SimpleCookieJar", () => {
  it("capture un cookie de session simple", () => {
    const jar = new SimpleCookieJar();
    jar.applySetCookieHeaders(headersWithSetCookie(["JSESSIONID=abc123; Path=/fbi; HttpOnly"]));

    expect(jar.has("JSESSIONID")).toBe(true);
    expect(jar.cookieHeader).toBe("JSESSIONID=abc123");
  });

  it("accumule plusieurs cookies au fil des réponses", () => {
    const jar = new SimpleCookieJar();
    jar.applySetCookieHeaders(headersWithSetCookie(["JSESSIONID=abc123; Path=/"]));
    jar.applySetCookieHeaders(headersWithSetCookie(["CSRF=xyz; Path=/"]));

    expect(jar.size).toBe(2);
    expect(jar.cookieHeader).toContain("JSESSIONID=abc123");
    expect(jar.cookieHeader).toContain("CSRF=xyz");
  });

  it("remplace la valeur d'un cookie déjà connu", () => {
    const jar = new SimpleCookieJar();
    jar.applySetCookieHeaders(headersWithSetCookie(["JSESSIONID=old"]));
    jar.applySetCookieHeaders(headersWithSetCookie(["JSESSIONID=new"]));

    expect(jar.size).toBe(1);
    expect(jar.cookieHeader).toBe("JSESSIONID=new");
  });

  it("ignore une réponse sans Set-Cookie", () => {
    const jar = new SimpleCookieJar();
    jar.applySetCookieHeaders(new Headers());
    expect(jar.size).toBe(0);
    expect(jar.cookieHeader).toBe("");
  });
});
