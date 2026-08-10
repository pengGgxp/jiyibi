import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppSettingsPayload, LedgerEntryPayload, SyncMutation } from "./types";
import {
  applyMutation,
  minimizeDeletedEntry,
  pullChanges,
  synchronize,
  syncMutationHash,
} from "./sync";

type SettingsMutation = Extract<SyncMutation, { entityType: "settings" }>;

function settingsMutation(overrides: Partial<SettingsMutation> = {}): SettingsMutation {
  return {
    id: "mutation_settings_1",
    entityType: "settings",
    entityId: "primary",
    baseVersion: 0,
    payload: {
      id: "primary",
      currency: "CNY",
      initialBalanceMinor: 500,
      schemaVersion: 1,
      updatedAt: "2026-07-30T12:00:00.000Z",
    },
    ...overrides,
  };
}

describe("sync mutation receipts", () => {
  beforeAll(() => vi.stubGlobal("crypto", webcrypto));
  afterAll(() => vi.unstubAllGlobals());

  it("is stable across object key order and binds the base version and payload", async () => {
    const original = settingsMutation();
    const reordered = settingsMutation({
      payload: {
        updatedAt: "2026-07-30T12:00:00.000Z",
        schemaVersion: 1,
        initialBalanceMinor: 500,
        currency: "CNY",
        id: "primary",
      },
    });

    await expect(syncMutationHash(reordered)).resolves.toBe(await syncMutationHash(original));
    await expect(syncMutationHash(settingsMutation({ baseVersion: 1 })))
      .resolves.not.toBe(await syncMutationHash(original));
    await expect(syncMutationHash(settingsMutation({
      payload: {
        ...(original.payload as AppSettingsPayload),
        initialBalanceMinor: 501,
      },
    }))).resolves.not.toBe(await syncMutationHash(original));
    await expect(syncMutationHash(settingsMutation({
      payload: {
        ...(original.payload as AppSettingsPayload),
        monthEndBalanceGoalMinor: 25_000,
      },
    }))).resolves.not.toBe(await syncMutationHash(original));
  });

  it.each([
    ["version-one payload", undefined, 1],
    ["version-two payload with a signed goal", -25_000, 2],
  ] as const)("persists the monthly goal for a %s", async (_label, goal, version) => {
    let insertQuery = "";
    let insertBindings: unknown[] = [];
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            if (query.includes("INSERT INTO ledger_settings")) {
              insertQuery = query;
              insertBindings = values;
            }
            return this;
          },
          async first() {
            return query.includes("INSERT INTO ledger_settings") ? { version: 1 } : null;
          },
        };
      },
    } as unknown as D1Database;
    const original = settingsMutation();
    const mutation = settingsMutation({
      payload: {
        ...(original.payload as AppSettingsPayload),
        ...(goal === undefined ? {} : { monthEndBalanceGoalMinor: goal }),
      },
    });

    await expect(applyMutation(db, "user_1", 3, mutation, version)).resolves.toEqual({
      id: mutation.id,
      status: "applied",
      version: 1,
    });
    expect(insertQuery).toContain("month_end_balance_goal_minor");
    expect(insertBindings.slice(0, 8)).toEqual([
      "user_1",
      3,
      500,
      goal ?? null,
      null,
      null,
      null,
      "2026-07-30T12:00:00.000Z",
    ]);
  });

  it("preserves the goal when a version-one client updates settings", async () => {
    let updateQuery = "";
    let updateBindings: unknown[] = [];
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            if (query.includes("UPDATE ledger_settings SET")) {
              updateQuery = query;
              updateBindings = values;
            }
            return this;
          },
          async first() {
            return query.includes("UPDATE ledger_settings SET") ? { version: 2 } : null;
          },
        };
      },
    } as unknown as D1Database;
    const mutation = settingsMutation({ baseVersion: 1 });

    await expect(applyMutation(db, "user_1", 3, mutation)).resolves.toMatchObject({
      status: "applied",
      version: 2,
    });
    expect(updateQuery).toContain("CASE WHEN ? = 1");
    expect(updateBindings.slice(0, 10)).toEqual([
      500,
      0,
      null,
      0,
      null,
      0,
      null,
      0,
      null,
      "2026-07-30T12:00:00.000Z",
    ]);
  });

  it("preserves the goal for a legacy queued mutation retried with version two", async () => {
    let updateBindings: unknown[] = [];
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            if (query.includes("UPDATE ledger_settings SET")) updateBindings = values;
            return this;
          },
          async first() {
            return query.includes("UPDATE ledger_settings SET") ? { version: 2 } : null;
          },
        };
      },
    } as unknown as D1Database;
    const mutation = settingsMutation({ baseVersion: 1 });

    await applyMutation(db, "user_1", 3, mutation, 2);
    expect(updateBindings.slice(0, 9)).toEqual([
      500, 0, null, 0, null, 0, null, 0, null,
    ]);
  });

  it("clears the goal when a version-two client sends an explicit null", async () => {
    let updateBindings: unknown[] = [];
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            if (query.includes("UPDATE ledger_settings SET")) updateBindings = values;
            return this;
          },
          async first() {
            return query.includes("UPDATE ledger_settings SET") ? { version: 2 } : null;
          },
        };
      },
    } as unknown as D1Database;
    const original = settingsMutation();
    const mutation = settingsMutation({
      baseVersion: 1,
      payload: {
        ...(original.payload as AppSettingsPayload),
        monthEndBalanceGoalMinor: null,
      },
    });

    await expect(applyMutation(db, "user_1", 3, mutation, 2)).resolves.toMatchObject({
      status: "applied",
      version: 2,
    });
    expect(updateBindings.slice(0, 10)).toEqual([
      500,
      1,
      null,
      0,
      null,
      0,
      null,
      0,
      null,
      "2026-07-30T12:00:00.000Z",
    ]);
  });

  it("writes and explicitly clears a version-three pay cycle", async () => {
    const updates: unknown[][] = [];
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            if (query.includes("UPDATE ledger_settings SET")) updates.push(values);
            return this;
          },
          async first() {
            return query.includes("UPDATE ledger_settings SET") ? { version: 2 } : null;
          },
        };
      },
    } as unknown as D1Database;
    const original = settingsMutation();
    const payCycle = {
      paydayDay: 10,
      monthlySalaryMinor: 800_000,
      cycleEndBalanceGoalMinor: 100_000,
    };

    await applyMutation(db, "user_1", 3, settingsMutation({
      baseVersion: 1,
      payload: { ...(original.payload as AppSettingsPayload), payCycle },
    }), 3);
    await applyMutation(db, "user_1", 3, settingsMutation({
      id: "mutation_settings_2",
      baseVersion: 1,
      payload: { ...(original.payload as AppSettingsPayload), payCycle: null },
    }), 3);

    expect(updates[0].slice(3, 9)).toEqual([
      1, 10, 1, 800_000, 1, 100_000,
    ]);
    expect(updates[1].slice(3, 9)).toEqual([
      1, null, 1, null, 1, null,
    ]);
  });

  it("hides the version-two goal from version-one pull responses", async () => {
    const row = {
      cursor: "9",
      mutation_id: "mutation_settings_1",
      entity_type: "settings",
      entity_id: "primary",
      entity_version: 2,
      mutation_hash: "hash",
      payload_json: JSON.stringify({
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        monthEndBalanceGoalMinor: 25_000,
        payCycle: {
          paydayDay: 10,
          monthlySalaryMinor: 800_000,
          cycleEndBalanceGoalMinor: 100_000,
        },
        schemaVersion: 1,
        updatedAt: "2026-07-30T12:00:00.000Z",
      }),
    };
    const db = {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [row] }; },
        };
      },
    } as unknown as D1Database;

    const legacy = await pullChanges(db, "user_1", 3, "0", 1);
    const current = await pullChanges(db, "user_1", 3, "0", 2);
    const latest = await pullChanges(db, "user_1", 3, "0", 3);
    expect(legacy.changes[0].payload).not.toHaveProperty("monthEndBalanceGoalMinor");
    expect(legacy.changes[0].payload).not.toHaveProperty("payCycle");
    expect(current.changes[0].payload).toHaveProperty("monthEndBalanceGoalMinor", 25_000);
    expect(current.changes[0].payload).not.toHaveProperty("payCycle");
    expect(latest.changes[0].payload).toHaveProperty("payCycle", {
      paydayDay: 10,
      monthlySalaryMinor: 800_000,
      cycleEndBalanceGoalMinor: 100_000,
    });
  });
});

describe("deleted entry minimization", () => {
  it("keeps only a valid deletion tombstone and removes original ledger details", () => {
    const entry: LedgerEntryPayload = {
      id: "entry_private_1",
      amountMinor: -987_654,
      note: "private merchant and memo",
      occurredAt: "2026-06-01T02:00:00.000Z",
      localDateKey: "2026-06-01",
      localMonthKey: "2026-06",
      timezoneOffsetMinutes: -480,
      attachmentId: "attachment_private_1",
      createdAt: "2026-06-01T02:00:00.000Z",
      updatedAt: "2026-07-30T12:00:00.000Z",
      deletedAt: "2026-07-30T12:00:00.000Z",
    };

    expect(minimizeDeletedEntry(entry)).toEqual({
      id: entry.id,
      amountMinor: 1,
      note: "",
      occurredAt: entry.deletedAt,
      localDateKey: "2026-07-30",
      localMonthKey: "2026-07",
      timezoneOffsetMinutes: 0,
      createdAt: entry.deletedAt,
      updatedAt: entry.deletedAt,
      deletedAt: entry.deletedAt,
    });
  });
});

describe("sync privacy cleanup", () => {
  it("compacts superseded payloads before a KV cleanup failure", async () => {
    const calls: string[] = [];
    const db = {
      prepare: (query: string) => ({
        bind() {
          return this;
        },
        async run() {
          if (query.includes("UPDATE sync_changes")) calls.push("compact");
          if (query.includes("INSERT INTO attachment_cleanup")) calls.push("enqueue");
          return { success: true };
        },
        async all() {
          if (query.includes("FROM attachment_cleanup q")) {
            return {
              results: [{
                attachment_id: "attachment_1",
                r2_key: "user/attachment_1/old.jpg",
                is_referenced: 0,
              }],
            };
          }
          return { results: [] };
        },
      }),
      async batch() {
        calls.push("remove-metadata");
        return [{ meta: { changes: 1 } }];
      },
    } as unknown as D1Database;
    const attachments = {
      async delete() {
        calls.push("delete");
        throw new Error("KV unavailable");
      },
    } as unknown as KVNamespace;

    await expect(synchronize(
      {
        DB: db,
        ATTACHMENTS: attachments,
        TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        POLICY_AUD: "test-aud",
      },
      "user_1",
      1,
      { schemaVersion: 1, cursor: "0", mutations: [] },
    )).rejects.toThrow("KV unavailable");

    expect(calls).toEqual([
      "compact",
      "enqueue",
      "remove-metadata",
      "delete",
    ]);
  });
});
