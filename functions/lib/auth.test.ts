import { describe, expect, it } from "vitest";
import { authenticate, enableCloudSync, ensureUser, sha256Hex } from "./auth";
import type { AuthenticatedUser, CloudSyncStatus, Env } from "./types";

const USER: AuthenticatedUser = {
  id: "user_1",
  email: "owner@example.com",
  issuer: "https://example.cloudflareaccess.com",
  subject: "subject_1",
};

function userDatabase(
  status: CloudSyncStatus,
  generation = 3,
  lastDeletedGeneration: number | null = 1,
  deletionStartedAt: string | null = null,
): D1Database {
  return {
    prepare: (query: string) => ({
      bind() {
        return this;
      },
      async first() {
        return query.includes("cloud_sync_state")
          ? {
              status,
              generation,
              last_deleted_generation: lastDeletedGeneration,
            }
          : { deletion_started_at: deletionStartedAt };
      },
    }),
  } as unknown as D1Database;
}

describe("ensureUser deletion gate", () => {
  it("returns a conflict while cloud deletion is in progress", async () => {
    await expect(ensureUser(userDatabase("deleting"), USER)).rejects.toMatchObject({
      status: 409,
      code: "account_deletion_in_progress",
    });
  });

  it("allows the account endpoint to resume a deletion", async () => {
    await expect(ensureUser(
      userDatabase("deleting"),
      USER,
      { allowDeletionInProgress: true },
    )).resolves.toEqual({
      status: "deleting",
      generation: 3,
      lastDeletedGeneration: 1,
    });
  });

  it("requires an explicit enable call before provisioning an account", async () => {
    await expect(ensureUser(userDatabase("disabled"), USER)).rejects.toMatchObject({
      status: 409,
      code: "cloud_sync_disabled",
    });
    await expect(ensureUser(
      userDatabase("disabled"),
      USER,
      { allowSyncDisabled: true },
    )).resolves.toEqual({
      status: "disabled",
      generation: 3,
      lastDeletedGeneration: 1,
    });
  });

  it("provisions the user for the active generation", async () => {
    await expect(ensureUser(userDatabase("enabled"), USER)).resolves.toEqual({
      status: "enabled",
      generation: 3,
      lastDeletedGeneration: 1,
    });
  });
});

interface EnableState {
  status: CloudSyncStatus;
  generation: number;
  lastDeletedGeneration: number | null;
  userUpserts: number;
}

function enableDatabase(
  initialStatus: CloudSyncStatus,
  initialGeneration: number,
  lastDeletedGeneration: number | null = null,
): { db: D1Database; state: EnableState } {
  const state: EnableState = {
    status: initialStatus,
    generation: initialGeneration,
    lastDeletedGeneration,
    userUpserts: 0,
  };
  const db = {
    prepare(query: string) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async first() {
          if (query.includes("INSERT INTO cloud_sync_state")) {
            return {
              status: state.status,
              generation: state.generation,
              last_deleted_generation: state.lastDeletedGeneration,
            };
          }
          if (query.includes("UPDATE cloud_sync_state")) {
            const expectedGeneration = Number(bindings[2]);
            if (
              state.status !== "disabled" ||
              state.generation !== expectedGeneration
            ) {
              return null;
            }
            state.status = "enabled";
            state.generation += 1;
            return {
              status: state.status,
              generation: state.generation,
              last_deleted_generation: state.lastDeletedGeneration,
            };
          }
          if (query.includes("INSERT INTO users")) {
            const generation = Number(bindings[4]);
            if (state.status !== "enabled" || generation !== state.generation) {
              return null;
            }
            state.userUpserts += 1;
            return { deletion_started_at: null };
          }
          throw new Error(`Unexpected query: ${query}`);
        },
      };
    },
  } as unknown as D1Database;
  return { db, state };
}

describe("enableCloudSync", () => {
  it("increments a disabled generation before provisioning its user row", async () => {
    const { db, state } = enableDatabase("disabled", 0);

    await expect(enableCloudSync(db, USER, 0)).resolves.toBe(1);
    expect(state).toEqual({
      status: "enabled",
      generation: 1,
      lastDeletedGeneration: null,
      userUpserts: 1,
    });
  });

  it("treats retrying the just-completed enable generation as idempotent", async () => {
    const { db, state } = enableDatabase("enabled", 3, 1);

    await expect(enableCloudSync(db, USER, 2)).resolves.toBe(3);
    expect(state.userUpserts).toBe(1);
    expect(state.generation).toBe(3);
  });

  it("cannot interrupt an account deletion", async () => {
    const { db, state } = enableDatabase("deleting", 3, 1);

    await expect(enableCloudSync(db, USER, 3)).rejects.toMatchObject({
      status: 409,
      code: "account_deletion_in_progress",
    });
    expect(state.userUpserts).toBe(0);
  });

  it("rejects an enable request from an older completed generation", async () => {
    const { db, state } = enableDatabase("disabled", 4, 3);

    await expect(enableCloudSync(db, USER, 0)).rejects.toMatchObject({
      status: 409,
      code: "stale_cloud_generation",
    });
    expect(state).toEqual({
      status: "disabled",
      generation: 4,
      lastDeletedGeneration: 3,
      userUpserts: 0,
    });
  });
});

describe("authenticate GitHub session", () => {
  const token = "s".repeat(43);

  function sessionEnvironment(row: unknown, allowedUserId = "12345678") {
    let bindings: unknown[] = [];
    const env = {
      DB: {
        prepare(query: string) {
          expect(query).toContain("FROM auth_sessions");
          return {
            bind(...values: unknown[]) {
              bindings = values;
              return this;
            },
            async first() { return row; },
          };
        },
      } as unknown as D1Database,
      GITHUB_ALLOWED_USER_ID: allowedUserId,
      ENVIRONMENT: "production",
    } as Env;
    return { env, bindings: () => bindings };
  }

  it("authenticates from a hashed server-side session", async () => {
    const userId = `usr_${"c".repeat(64)}`;
    const { env, bindings } = sessionEnvironment({
      user_id: userId,
      github_user_id: "12345678",
      email: "12345678+owner@users.noreply.github.com",
    });
    const request = new Request("https://jiyibi.pages.dev/api/session", {
      headers: { Cookie: `__Host-jiyibi-session=${token}` },
    });

    await expect(authenticate(request, env)).resolves.toEqual({
      id: userId,
      email: "12345678+owner@users.noreply.github.com",
      issuer: "https://github.com",
      subject: "12345678",
    });
    expect(bindings()[0]).toBe(await sha256Hex(token));
    expect(bindings()[0]).not.toBe(token);
    expect(bindings()[1]).toBe("12345678");
  });

  it("rejects an unknown or expired session", async () => {
    const { env } = sessionEnvironment(null);
    const request = new Request("https://jiyibi.pages.dev/api/session", {
      headers: { Cookie: `__Host-jiyibi-session=${token}` },
    });
    await expect(authenticate(request, env)).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });
  });

  it("fails closed in production when the allowed GitHub ID is empty", async () => {
    const { env } = sessionEnvironment(null, "");
    const request = new Request("https://jiyibi.pages.dev/api/session", {
      headers: { Cookie: `__Host-jiyibi-session=${token}` },
    });
    await expect(authenticate(request, env)).rejects.toMatchObject({
      status: 500,
      code: "auth_not_configured",
    });
  });
});
