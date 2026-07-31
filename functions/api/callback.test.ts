import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_OAUTH_NONCE_COOKIE,
  GITHUB_SESSION_COOKIE,
  sha256Hex,
} from "../lib/auth";
import type { Env } from "../lib/types";
import { onRequest } from "./callback";

const ORIGIN = "https://jiyibi.pages.dev";
const STATE = "a".repeat(43);
const NONCE = "b".repeat(43);

interface StatementCall {
  query: string;
  bindings: unknown[];
}

function callbackEnvironment(returnTo: string | null = "/settings") {
  const calls: StatementCall[] = [];
  let stateAvailable = returnTo !== null;
  const db = {
    prepare(query: string) {
      const call = { query, bindings: [] as unknown[] };
      calls.push(call);
      return {
        bind(...values: unknown[]) {
          call.bindings = values;
          return this;
        },
        async first() {
          if (!query.includes("DELETE FROM oauth_states")) {
            throw new Error(`Unexpected first query: ${query}`);
          }
          if (!stateAvailable || returnTo === null) return null;
          stateAvailable = false;
          return { return_to: returnTo };
        },
        async run() { return { success: true }; },
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
  return { env, calls };
}

function callbackRequest(extra = ""): Request {
  return new Request(`${ORIGIN}/api/callback?code=oauth-code&state=${STATE}${extra}`, {
    headers: { Cookie: `${GITHUB_OAUTH_NONCE_COOKIE}=${NONCE}` },
  });
}

function githubFetch(userId = 12345678) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "github-access-token", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: userId, login: "owner", email: null });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub OAuth callback", () => {
  it("creates only a hashed application session for the allowed GitHub ID", async () => {
    const { env, calls } = callbackEnvironment("/settings?panel=cloud#account");
    const fetcher = githubFetch();
    vi.stubGlobal("fetch", fetcher);
    const response = await onRequest({
      request: callbackRequest(),
      env,
    } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/settings?panel=cloud#account`);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const consumed = calls.find((call) => call.query.includes("DELETE FROM oauth_states"));
    expect(consumed?.bindings[0]).toBe(await sha256Hex(STATE));
    expect(consumed?.bindings[1]).toBe(await sha256Hex(NONCE));
    expect(consumed?.bindings).not.toContain(STATE);
    expect(consumed?.bindings).not.toContain(NONCE);

    const cookie = response.headers.get("Set-Cookie") ?? "";
    const sessionToken = new RegExp(`${GITHUB_SESSION_COOKIE}=([A-Za-z0-9_-]{43})`)
      .exec(cookie)?.[1] ?? "";
    expect(sessionToken).toHaveLength(43);
    expect(cookie).toContain(`${GITHUB_OAUTH_NONCE_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");

    const inserted = calls.find((call) => call.query.includes("INSERT INTO auth_sessions"));
    expect(inserted?.bindings[0]).toBe(await sha256Hex(sessionToken));
    expect(inserted?.bindings[0]).not.toBe(sessionToken);
    expect(inserted?.bindings).not.toContain("github-access-token");
    expect(inserted?.bindings[1]).toMatch(/^usr_[a-f0-9]{64}$/);
    expect(inserted?.bindings[2]).toBe("12345678");
    expect(inserted?.bindings[3]).toBe("12345678+owner@users.noreply.github.com");
  });

  it("rejects a GitHub account outside the configured allowlist", async () => {
    const { env, calls } = callbackEnvironment();
    vi.stubGlobal("fetch", githubFetch(87654321));
    const response = await onRequest({
      request: callbackRequest(),
      env,
    } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "github_account_not_allowed",
        message: "This GitHub account is not allowed",
      },
    });
    expect(calls.some((call) => call.query.includes("INSERT INTO auth_sessions"))).toBe(false);
    expect(response.headers.get("Set-Cookie")).toContain(`${GITHUB_OAUTH_NONCE_COOKIE}=`);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("rejects a missing nonce before contacting GitHub", async () => {
    const { env, calls } = callbackEnvironment();
    const fetcher = githubFetch();
    vi.stubGlobal("fetch", fetcher);
    const request = new Request(`${ORIGIN}/api/callback?code=oauth-code&state=${STATE}`);
    const response = await onRequest({ request, env } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("consumes an OAuth state only once", async () => {
    const { env } = callbackEnvironment();
    const fetcher = githubFetch();
    vi.stubGlobal("fetch", fetcher);
    const first = await onRequest({
      request: callbackRequest(),
      env,
    } as Parameters<typeof onRequest>[0]);
    const replay = await onRequest({
      request: callbackRequest(),
      env,
    } as Parameters<typeof onRequest>[0]);

    expect(first.status).toBe(302);
    expect(replay.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a stored return path that resolves outside the deployment origin", async () => {
    const { env } = callbackEnvironment("/\\attacker.example/collect");
    const fetcher = githubFetch();
    vi.stubGlobal("fetch", fetcher);
    const response = await onRequest({
      request: callbackRequest(),
      env,
    } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-GET requests", async () => {
    const response = await onRequest({
      request: new Request(`${ORIGIN}/api/callback`, { method: "POST" }),
    } as Parameters<typeof onRequest>[0]);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });
});
