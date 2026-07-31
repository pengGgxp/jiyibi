import { describe, expect, it } from "vitest";
import { GITHUB_SESSION_COOKIE, sha256Hex } from "../lib/auth";
import type { Env } from "../lib/types";
import { onRequest } from "./logout";

const ORIGIN = "https://jiyibi.pages.dev";
const TOKEN = "z".repeat(43);

function logoutEnvironment() {
  let bindings: unknown[] = [];
  const env = {
    DB: {
      prepare(query: string) {
        expect(query).toContain("DELETE FROM auth_sessions");
        return {
          bind(...values: unknown[]) {
            bindings = values;
            return this;
          },
          async run() { return { success: true }; },
        };
      },
    } as unknown as D1Database,
  } as Env;
  return { env, bindings: () => bindings };
}

describe("logout endpoint", () => {
  it("revokes the hashed session and clears its secure cookie", async () => {
    const { env, bindings } = logoutEnvironment();
    const request = new Request(`${ORIGIN}/api/logout?returnTo=%2Fsettings%3Fpanel%3Dcloud`, {
      headers: { Cookie: `${GITHUB_SESSION_COOKIE}=${TOKEN}` },
    });
    const response = await onRequest({ request, env } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/settings?panel=cloud`);
    expect(bindings()[0]).toBe(await sha256Hex(TOKEN));
    expect(bindings()[0]).not.toBe(TOKEN);
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`${GITHUB_SESSION_COOKIE}=`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=0");
  });

  it("keeps the legacy Cloudflare Access logout path", async () => {
    const { env } = logoutEnvironment();
    const request = new Request(`${ORIGIN}/api/logout?returnTo=%2F`, {
      headers: {
        Cookie: `${GITHUB_SESSION_COOKIE}=${TOKEN}`,
        "Cf-Access-Jwt-Assertion": "legacy-token",
      },
    });
    const response = await onRequest({ request, env } as Parameters<typeof onRequest>[0]);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.pathname).toBe("/cdn-cgi/access/logout");
    expect(location.searchParams.get("returnTo")).toBe(`${ORIGIN}/`);
  });

  it("rejects non-GET requests", async () => {
    const response = await onRequest({
      request: new Request(`${ORIGIN}/api/logout`, { method: "POST" }),
    } as Parameters<typeof onRequest>[0]);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });
});
