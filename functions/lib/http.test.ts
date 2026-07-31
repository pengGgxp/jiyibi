import { describe, expect, it } from "vitest";
import { handleAuthenticated, jsonResponse } from "./http";
import type { Env } from "./types";

function environment(generation = 4): Env {
  const db = {
    prepare(query: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (query.includes("INSERT INTO cloud_sync_state")) {
            return {
              status: "enabled",
              generation,
              last_deleted_generation: null,
            };
          }
          if (query.includes("INSERT INTO users")) {
            return { deletion_started_at: null };
          }
          throw new Error(`Unexpected query: ${query}`);
        },
      };
    },
  } as unknown as D1Database;
  return {
    DB: db,
    ATTACHMENTS: {} as KVNamespace,
    TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    POLICY_AUD: "test-aud",
    ENVIRONMENT: "development",
    LOCAL_AUTH_EMAIL: "nobody@example.invalid",
  };
}

function context(request: Request, env = environment()) {
  return { request, env };
}

describe("handleAuthenticated generation gate", () => {
  it("rejects a missing generation header", async () => {
    const response = await handleAuthenticated(
      context(new Request("https://example.test/api/sync", { method: "POST" })),
      async () => jsonResponse({ ok: true }),
      { requireGeneration: true },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "stale_cloud_generation",
        message: "Cloud sync generation changed; explicitly enable sync on this device",
      },
    });
  });

  it("rejects a mismatched generation header", async () => {
    const response = await handleAuthenticated(
      context(new Request("https://example.test/api/sync", {
        method: "POST",
        headers: { "X-Jiyibi-Sync-Generation": "3" },
      })),
      async () => jsonResponse({ ok: true }),
      { requireGeneration: true },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "stale_cloud_generation" },
    });
  });

  it("passes the verified generation to the handler", async () => {
    const response = await handleAuthenticated(
      context(new Request("https://example.test/api/sync", {
        method: "POST",
        headers: { "X-Jiyibi-Sync-Generation": "4" },
      })),
      async (_user, syncState) => jsonResponse({ generation: syncState.generation }),
      { requireGeneration: true },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ generation: 4 });
  });

  it("maps a trigger race to the stale-generation contract", async () => {
    const response = await handleAuthenticated(
      context(new Request("https://example.test/api/sync", {
        method: "POST",
        headers: { "X-Jiyibi-Sync-Generation": "4" },
      })),
      async () => {
        throw new Error("stale_cloud_generation: SQLITE_CONSTRAINT_TRIGGER");
      },
      { requireGeneration: true },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "stale_cloud_generation" },
    });
  });
});
