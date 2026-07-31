import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import {
  deleteCloudAccountData,
  validateAccountDeletionRequest,
  validateCloudSyncEnableRequest,
} from "./account";
import { attachmentGenerationPrefix, createAttachmentKey } from "./attachment-store";
import type { Env } from "./types";

interface FakeState {
  userExists: boolean;
  userGeneration: number;
  deletionStarted: boolean;
  deletionQuietSince: string | null;
  syncStatus: "disabled" | "enabled" | "deleting";
  generation: number;
  lastDeletedGeneration: number | null;
  attachments: Set<string>;
  cleanup: Set<string>;
  durableCleanup: Set<string>;
  storedObjects: Set<string>;
  activeUploadLeases: number;
}

interface FakeOptions {
  completeConcurrentlyBeforeDisable?: boolean;
  injectDurableCleanupBeforeUserDelete?: boolean;
  enforceQuietWindow?: boolean;
  kvListPages?: Array<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

class FakeStatement {
  private bindings: unknown[] = [];

  constructor(
    readonly query: string,
    private readonly state: FakeState,
    private readonly events: string[],
    private readonly options: FakeOptions,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.bindings = values;
    return this as unknown as D1PreparedStatement;
  }

  async run(): Promise<D1Result> {
    if (this.query.includes("SET deletion_quiet_since = NULL")) {
      this.state.deletionQuietSince = null;
      return this.result(this.state.userExists ? 1 : 0);
    }
    if (
      this.query.includes("UPDATE cloud_sync_state") &&
      this.query.includes("status = 'disabled'")
    ) {
      const expectedGeneration = Number(this.bindings[3]);
      if (
        this.state.syncStatus !== "deleting" ||
        this.state.generation !== expectedGeneration ||
        this.state.durableCleanup.size > 0 ||
        this.state.activeUploadLeases > 0
      ) {
        return this.result(0);
      }
      this.events.push("disable-sync");
      this.state.syncStatus = "disabled";
      this.state.lastDeletedGeneration = expectedGeneration;
      this.state.generation += 1;
      return this.result(1);
    }
    if (
      this.query.includes("UPDATE cloud_sync_state") &&
      this.query.includes("status = 'deleting'")
    ) {
      const expectedGeneration = Number(this.bindings[2]);
      const expectedStatus = this.bindings[3];
      if (
        this.state.generation !== expectedGeneration ||
        this.state.syncStatus !== expectedStatus
      ) {
        return this.result(0);
      }
      this.events.push("mark-deletion");
      this.state.syncStatus = "deleting";
      return this.result(1);
    }
    if (this.query.includes("UPDATE users")) {
      const expectedGeneration = Number(this.bindings[3]);
      const changed = this.state.userExists &&
        this.state.userGeneration === expectedGeneration &&
        !this.state.deletionStarted;
      if (changed) {
        this.events.push("mark-user-deletion");
        this.state.deletionStarted = true;
        this.state.deletionQuietSince = null;
      }
      return this.result(changed ? 1 : 0);
    }
    if (this.query.startsWith("DELETE FROM attachments")) {
      for (const r2Key of this.bindings.slice(2)) {
        this.state.attachments.delete(String(r2Key));
      }
      return this.result(1);
    }
    if (this.query.startsWith("DELETE FROM attachment_cleanup")) {
      for (const r2Key of this.bindings.slice(2)) {
        this.state.cleanup.delete(String(r2Key));
      }
      return this.result(1);
    }
    if (this.query.startsWith("DELETE FROM cloud_attachment_cleanup")) {
      for (const r2Key of this.bindings.slice(2)) {
        this.state.durableCleanup.delete(String(r2Key));
      }
      return this.result(1);
    }
    if (this.query.includes("DELETE FROM users")) {
      this.events.push("delete-user");
      if (this.options.completeConcurrentlyBeforeDisable) {
        this.options.completeConcurrentlyBeforeDisable = false;
        this.state.userExists = false;
        this.state.syncStatus = "disabled";
        this.state.lastDeletedGeneration = this.state.generation;
        this.state.generation += 1;
        return this.result(0);
      }
      if (this.options.injectDurableCleanupBeforeUserDelete) {
        this.options.injectDurableCleanupBeforeUserDelete = false;
        this.state.durableCleanup.add("user/g1/attachment_late/file.jpg");
      }
      const expectedGeneration = Number(this.bindings[1]);
      if (
        this.state.userExists &&
        this.state.userGeneration === expectedGeneration &&
        this.state.deletionStarted &&
        this.state.attachments.size === 0 &&
        this.state.cleanup.size === 0 &&
        this.state.durableCleanup.size === 0 &&
        this.state.activeUploadLeases === 0
      ) {
        this.state.userExists = false;
        return this.result(1);
      }
      return this.result(0);
    }
    throw new Error(`Unexpected run query: ${this.query}`);
  }

  async all<T>(): Promise<D1Result<T>> {
    if (!this.query.includes("ORDER BY r2_key")) {
      throw new Error(`Unexpected all query: ${this.query}`);
    }
    const keys = [...new Set([
      ...this.state.attachments,
      ...this.state.cleanup,
      ...this.state.durableCleanup,
    ])].sort().slice(0, Number(this.bindings.at(-1)));
    return { results: keys.map((r2_key) => ({ r2_key })) } as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("SET deletion_quiet_since = COALESCE")) {
      if (!this.state.userExists || !this.state.deletionStarted) return null;
      if (this.state.deletionQuietSince === null) {
        const now = String(this.bindings[0]);
        this.state.deletionQuietSince = this.options.enforceQuietWindow
          ? now
          : new Date(Date.parse(now) - 60_001).toISOString();
      }
      return { deletion_quiet_since: this.state.deletionQuietSince } as T;
    }
    if (this.query.includes("SELECT status, generation, last_deleted_generation")) {
      return {
        status: this.state.syncStatus,
        generation: this.state.generation,
        last_deleted_generation: this.state.lastDeletedGeneration,
      } as T;
    }
    if (
      this.query.includes("COUNT(*) AS remaining") &&
      this.query.includes("FROM cloud_upload_leases")
    ) {
      return { remaining: this.state.activeUploadLeases } as T;
    }
    if (this.query.includes("COUNT(*) AS remaining")) {
      return {
        remaining: new Set([
          ...this.state.attachments,
          ...this.state.cleanup,
          ...this.state.durableCleanup,
        ]).size,
      } as T;
    }
    if (this.query.includes("SELECT generation, deletion_started_at FROM users")) {
      return this.state.userExists
        ? {
            generation: this.state.userGeneration,
            deletion_started_at: this.state.deletionStarted ? "started" : null,
          } as T
        : null;
    }
    throw new Error(`Unexpected first query: ${this.query}`);
  }

  private result(changes: number): D1Result {
    return {
      success: true,
      meta: { changes },
      results: [],
    } as unknown as D1Result;
  }
}

function createEnvironment(
  state: FakeState,
  events: string[],
  shouldFailStorage: () => boolean = () => false,
  options: FakeOptions = {},
): Env {
  const db = {
    prepare(query: string) {
      return new FakeStatement(query.trim(), state, events, options);
    },
    async batch(statements: D1PreparedStatement[]) {
      const fakeStatements = statements.map((statement) =>
        statement as unknown as FakeStatement
      );
      if (fakeStatements.every((statement) => statement.query.startsWith("DELETE FROM"))) {
        events.push("delete-metadata");
      }
      const results: D1Result[] = [];
      for (const statement of fakeStatements) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;
  const attachments = {
    async delete(key: string) {
      events.push("delete-kv");
      if (shouldFailStorage()) throw new Error("KV unavailable");
      state.storedObjects.delete(key);
    },
    async list(listOptions: { prefix?: string; limit?: number; cursor?: string }) {
      const mocked = options.kvListPages?.shift();
      if (mocked) return mocked;
      const keys = [...state.storedObjects]
        .filter((key) => key.startsWith(listOptions.prefix ?? ""))
        .sort()
        .slice(0, listOptions.limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
  return {
    DB: db,
    ATTACHMENTS: attachments,
    TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    POLICY_AUD: "test-aud",
  };
}

function fakeState(keys: string[] = []): FakeState {
  return {
    userExists: true,
    userGeneration: 1,
    deletionStarted: false,
    deletionQuietSince: null,
    syncStatus: "enabled",
    generation: 1,
    lastDeletedGeneration: null,
    attachments: new Set(keys),
    cleanup: new Set(),
    durableCleanup: new Set(),
    storedObjects: new Set(keys),
    activeUploadLeases: 0,
  };
}

describe("account deletion confirmation", () => {
  it("accepts only the exact explicit confirmation object", () => {
    expect(validateAccountDeletionRequest({ confirmation: "DELETE", generation: 1 })).toBe(1);
    for (const value of [
      null,
      {},
      { confirmation: "DELETE" },
      { confirmation: "delete", generation: 1 },
      { confirmation: "DELETE", generation: 1, extra: true },
      { confirmation: "DELETE", generation: -1 },
      ["DELETE", 1],
    ]) {
      expect(() => validateAccountDeletionRequest(value)).toThrowError(ApiError);
    }
  });

  it("requires a separate exact confirmation before enabling sync", () => {
    expect(validateCloudSyncEnableRequest({ confirmation: "ENABLE", generation: 0 })).toBe(0);
    expect(() => validateCloudSyncEnableRequest({ confirmation: "enable", generation: 0 }))
      .toThrowError(ApiError);
    expect(() => validateCloudSyncEnableRequest({ confirmation: "ENABLE", generation: 0, extra: true }))
      .toThrowError(ApiError);
  });
});

describe("KV attachment generation key contract", () => {
  it("places each attachment under its user and generation prefix", () => {
    expect(attachmentGenerationPrefix("usr_abc", 12)).toBe("usr_abc/g12/");
    expect(createAttachmentKey("usr_abc", 12, "attachment_1"))
      .toMatch(/^usr_abc\/g12\/attachment_1\/[0-9a-f-]+\.jpg$/);
  });
});

describe("deleteCloudAccountData", () => {
  it("keeps D1 references when KV deletion fails, then succeeds on retry", async () => {
    const state = fakeState(["user/g1/attachment_a/a.jpg"]);
    state.cleanup.add("user/g1/attachment_a/a.jpg");
    state.cleanup.add("user/g1/attachment_b/b.jpg");
    state.storedObjects.add("user/g1/attachment_b/b.jpg");
    const events: string[] = [];
    let failStorage = true;
    const env = createEnvironment(state, events, () => failStorage);

    await expect(deleteCloudAccountData(env, "user", 1)).rejects.toMatchObject({
      status: 503,
      code: "cloud_deletion_retry_required",
    });
    expect(state.attachments.size).toBe(1);
    expect(state.cleanup.size).toBe(2);
    expect(state.userExists).toBe(true);
    expect(events).toEqual([
      "mark-deletion",
      "mark-user-deletion",
      "delete-kv",
      "delete-kv",
    ]);

    failStorage = false;
    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: false,
      deletedObjects: 2,
      remainingObjects: 1,
    });
    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: true,
      deletedObjects: 0,
      remainingObjects: 0,
    });
    expect(state.userExists).toBe(false);
    expect(events.slice(-5)).toEqual([
      "delete-kv",
      "delete-kv",
      "delete-metadata",
      "delete-user",
      "disable-sync",
    ]);
  });

  it("deletes at most one batch and reports a retry signal", async () => {
    const keys = Array.from(
      { length: 51 },
      (_, index) => `user/g1/attachment_${String(index).padStart(2, "0")}/file.jpg`,
    );
    const state = fakeState(keys);
    const env = createEnvironment(state, []);

    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: false,
      deletedObjects: 50,
      remainingObjects: 1,
    });
    expect(state.userExists).toBe(true);
    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: false,
      deletedObjects: 1,
      remainingObjects: 1,
    });
    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: true,
      deletedObjects: 0,
      remainingObjects: 0,
    });
    expect(state.userExists).toBe(false);
  });

  it("finds generation-prefixed KV orphans without D1 pointers", async () => {
    const state = fakeState();
    state.storedObjects.add("user/g1/attachment_orphan/file.jpg");

    const env = createEnvironment(state, []);
    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: false,
      deletedObjects: 1,
      remainingObjects: 1,
    });
    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: true,
      deletedObjects: 0,
      remainingObjects: 0,
    });
    expect(state.storedObjects.size).toBe(0);
  });

  it("deletes the user immediately when no cloud attachment references remain", async () => {
    const state = fakeState();
    const events: string[] = [];

    await expect(deleteCloudAccountData(createEnvironment(state, events), "user", 1))
      .resolves.toEqual({ complete: true, deletedObjects: 0, remainingObjects: 0 });
    expect(events).toEqual([
      "mark-deletion",
      "mark-user-deletion",
      "delete-user",
      "disable-sync",
    ]);
    expect(state.syncStatus).toBe("disabled");
    expect(state.generation).toBe(2);
    expect(state.lastDeletedGeneration).toBe(1);
  });

  it("supports an idempotent retry when the successful response was lost", async () => {
    const state = fakeState();
    const env = createEnvironment(state, []);
    await deleteCloudAccountData(env, "user", 1);

    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: true,
      deletedObjects: 0,
      remainingObjects: 0,
    });
    expect(state.syncStatus).toBe("disabled");
    expect(state.generation).toBe(2);
  });

  it("accepts a concurrent successful finalization as idempotent", async () => {
    const state = fakeState();
    const options = { completeConcurrentlyBeforeDisable: true };

    await expect(deleteCloudAccountData(
      createEnvironment(state, [], () => false, options),
      "user",
      1,
    )).resolves.toEqual({
      complete: true,
      deletedObjects: 0,
      remainingObjects: 0,
    });
    expect(state.syncStatus).toBe("disabled");
    expect(state.lastDeletedGeneration).toBe(1);
  });

  it("retries when durable cleanup appears during finalization", async () => {
    const state = fakeState();
    const options = { injectDurableCleanupBeforeUserDelete: true };
    const env = createEnvironment(state, [], () => false, options);

    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: false,
      deletedObjects: 0,
      remainingObjects: 1,
    });
    expect(state.syncStatus).toBe("deleting");
    expect(state.userExists).toBe(true);

    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: false,
      deletedObjects: 1,
      remainingObjects: 1,
    });
    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: true,
      deletedObjects: 0,
      remainingObjects: 0,
    });
  });

  it("does not finish while an authenticated attachment upload holds a lease", async () => {
    const state = fakeState();
    state.activeUploadLeases = 1;
    const env = createEnvironment(state, []);

    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: false,
      deletedObjects: 0,
      remainingObjects: 1,
    });
    expect(state.syncStatus).toBe("deleting");
    expect(state.userExists).toBe(true);

    state.activeUploadLeases = 0;
    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: true,
      deletedObjects: 0,
      remainingObjects: 0,
    });
  });

  it("waits for a full quiet propagation window before finalizing deletion", async () => {
    const state = fakeState();
    const env = createEnvironment(state, [], () => false, { enforceQuietWindow: true });

    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: false,
      deletedObjects: 0,
      remainingObjects: 1,
    });
    expect(state.userExists).toBe(true);

    state.deletionQuietSince = new Date(Date.now() - 60_001).toISOString();
    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: true,
      deletedObjects: 0,
      remainingObjects: 0,
    });
  });

  it("continues through an empty incomplete KV page before deleting a later key", async () => {
    const state = fakeState();
    const lateKey = "user/g1/attachment_late/file.jpg";
    state.storedObjects.add(lateKey);
    const env = createEnvironment(state, [], () => false, {
      kvListPages: [
        { keys: [], list_complete: false, cursor: "after-tombstones" },
        { keys: [{ name: lateKey }], list_complete: true },
        { keys: [], list_complete: true },
        { keys: [], list_complete: true },
        { keys: [], list_complete: true },
      ],
    });

    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: false,
      deletedObjects: 1,
      remainingObjects: 1,
    });
    expect(state.storedObjects).not.toContain(lateKey);
    await expect(deleteCloudAccountData(env, "user", 1)).resolves.toEqual({
      complete: true,
      deletedObjects: 0,
      remainingObjects: 0,
    });
  });

  it("rejects a delayed old delete after a new generation is enabled", async () => {
    const state = fakeState();
    state.generation = 3;
    state.userGeneration = 3;
    state.lastDeletedGeneration = 1;
    state.storedObjects.add("user/g3/attachment_new/file.jpg");
    const events: string[] = [];

    await expect(deleteCloudAccountData(createEnvironment(state, events), "user", 1))
      .rejects.toMatchObject({ status: 409, code: "stale_cloud_generation" });
    expect(state.storedObjects).toEqual(new Set(["user/g3/attachment_new/file.jpg"]));
    expect(events).toEqual([]);
  });
});
