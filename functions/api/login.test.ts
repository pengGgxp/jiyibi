import { describe, expect, it } from "vitest";
import { GITHUB_OAUTH_NONCE_COOKIE, sha256Hex } from "../lib/auth";
import type { Env } from "../lib/types";
import { onRequest, safeReturnUrl } from "./login";

const ORIGIN = "https://jiyibi.pages.dev";

function loginRequest(returnTo: string): Request {
  const url = new URL("/api/login", ORIGIN);
  url.searchParams.set("returnTo", returnTo);
  return new Request(url);
}

function loginEnvironment() {
  const statements: Array<{ query: string; bindings: unknown[] }> = [];
  const db = {
    prepare(query: string) {
      const statement = { query, bindings: [] as unknown[] };
      statements.push(statement);
      return {
        bind(...values: unknown[]) {
          statement.bindings = values;
          return this;
        },
        async run() {
          return { success: true };
        },
      };
    },
  } as unknown as D1Database;
  const env = {
    DB: db,
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    GITHUB_ALLOWED_USER_ID: "12345678",
    ENVIRONMENT: "production",
  } as Env;
  return { env, statements };
}

describe("safeReturnUrl", () => {
  it("allows a same-origin root-relative path with its query and fragment", () => {
    expect(safeReturnUrl(loginRequest("/settings?panel=backup#restore")).toString())
      .toBe(`${ORIGIN}/settings?panel=backup#restore`);
  });

  it.each([
    "https://attacker.example/collect",
    "//attacker.example/collect",
    "/\\attacker.example/collect",
  ])("rejects an external return URL: %s", (returnTo) => {
    expect(safeReturnUrl(loginRequest(returnTo)).toString()).toBe(`${ORIGIN}/`);
  });

  it("rejects an oversized return path", () => {
    expect(safeReturnUrl(loginRequest(`/${"x".repeat(2048)}`)).toString())
      .toBe(`${ORIGIN}/`);
  });

  it.each([
    "/api",
    "/api/",
    "/api/sync?cursor=0",
  ])("rejects an API return path: %s", (returnTo) => {
    expect(safeReturnUrl(loginRequest(returnTo)).toString()).toBe(`${ORIGIN}/`);
  });
});

describe("login endpoint", () => {
  it("rejects non-GET requests before authentication", async () => {
    const request = new Request(`${ORIGIN}/api/login`, { method: "POST" });
    const response = await onRequest({ request } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    await expect(response.json()).resolves.toEqual({
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });
  });

  it("stores hashed state and nonce before redirecting to GitHub", async () => {
    const { env, statements } = loginEnvironment();
    const request = loginRequest("/settings?panel=cloud#account");
    const response = await onRequest({ request, env } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/callback`);
    expect(location.searchParams.get("allow_signup")).toBe("false");
    const state = location.searchParams.get("state") ?? "";
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cookie = response.headers.get("Set-Cookie") ?? "";
    const nonce = new RegExp(`${GITHUB_OAUTH_NONCE_COOKIE}=([A-Za-z0-9_-]{43})`)
      .exec(cookie)?.[1] ?? "";
    expect(nonce).toHaveLength(43);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");

    const insert = statements.find((statement) => statement.query.includes("INSERT INTO oauth_states"));
    expect(insert?.bindings[0]).toBe(await sha256Hex(state));
    expect(insert?.bindings[1]).toBe(await sha256Hex(nonce));
    expect(insert?.bindings[0]).not.toBe(state);
    expect(insert?.bindings[1]).not.toBe(nonce);
    expect(insert?.bindings[2]).toBe("/settings?panel=cloud#account");
  });

  it("rejects an incomplete production GitHub configuration", async () => {
    const { env, statements } = loginEnvironment();
    env.GITHUB_ALLOWED_USER_ID = "";
    const response = await onRequest({
      request: loginRequest("/"),
      env,
    } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "auth_not_configured", message: "Authentication is not configured" },
    });
    expect(statements).toHaveLength(0);
  });

  it("keeps the local development authentication path", async () => {
    const { env } = loginEnvironment();
    env.ENVIRONMENT = "development";
    env.LOCAL_AUTH_EMAIL = "developer@example.com";
    const state = { status: "disabled", generation: 0, last_deleted_generation: null };
    env.DB = {
      prepare: () => ({
        bind() { return this; },
        async first() { return state; },
      }),
    } as unknown as D1Database;

    const response = await onRequest({
      request: loginRequest("/settings"),
      env,
    } as Parameters<typeof onRequest>[0]);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/settings`);
  });
});
