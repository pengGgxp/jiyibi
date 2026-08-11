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
    expect(insertBindings.slice(0, 12)).toEqual([
      "user_1",
      3,
      500,
      goal ?? null,
      null,
      null,
      null,
      null,
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
    expect(updateBindings.slice(0, 20)).toEqual([
      500, 0, null, 0, null, 0, null, 0, null, 0,
      null, 0, null, 0, null, 0, null, 0, null,
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
    expect(updateBindings.slice(0, 19)).toEqual([
      500, 0, null, 0, null, 0, null, 0, null, 0,
      null, 0, null, 0, null, 0, null, 0, null,
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
    expect(updateBindings.slice(0, 20)).toEqual([
      500, 1, null, 0, null, 0, null, 0, null, 0,
      null, 0, null, 0, null, 0, null, 0, null,
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

    expect(updates[0].slice(3, 12)).toEqual([
      0, 10, 1, 800_000, 0, 800_000, 0, 100_000, 0,
    ]);
    expect(updates[1].slice(3, 12)).toEqual([
      0, null, 1, null, 0, null, 0, null, 0,
    ]);
  });

  it("allows a version-three client to create its legacy pay cycle", async () => {
    let insertBindings: unknown[] = [];
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            if (query.includes("INSERT INTO ledger_settings")) insertBindings = values;
            return this;
          },
          async first() {
            return query.includes("INSERT INTO ledger_settings") ? { version: 1 } : null;
          },
        };
      },
    } as unknown as D1Database;
    const mutation = settingsMutation({
      payload: {
        ...settingsMutation().payload,
        payCycle: {
          paydayDay: 10,
          monthlySalaryMinor: 800_000,
          cycleEndBalanceGoalMinor: 100_000,
        },
      },
    });

    await expect(applyMutation(db, "user_1", 3, mutation, 3)).resolves.toMatchObject({
      status: "applied",
      version: 1,
    });
    expect(insertBindings.slice(0, 12)).toEqual([
      "user_1", 3, 500, null, 10, 800_000, 100_000,
      null, null, null, null, "2026-07-30T12:00:00.000Z",
    ]);
  });

  it("writes and explicitly clears version-four income planning", async () => {
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
    const payCycle = { paydayDay: 10, cycleEndBalanceGoalMinor: 100_000 };
    const incomeForecast = {
      id: "forecast_2026_08_10",
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 600_000,
      expectedIncomeMinor: 800_000,
    };

    await applyMutation(db, "user_1", 3, settingsMutation({
      baseVersion: 1,
      payload: { ...(original.payload as AppSettingsPayload), payCycle, incomeForecast },
    }), 4);
    await applyMutation(db, "user_1", 3, settingsMutation({
      id: "mutation_settings_2",
      baseVersion: 1,
      payload: {
        ...(original.payload as AppSettingsPayload),
        payCycle: null,
        incomeForecast: null,
      },
    }), 4);

    expect(updates[0].slice(3, 19)).toEqual([
      1, 10, 1, 800_000, 1, 800_000, 1, 100_000,
      1, incomeForecast.id,
      1, incomeForecast.targetPaydayDateKey,
      1, incomeForecast.minimumIncomeMinor,
      1, incomeForecast.expectedIncomeMinor,
    ]);
    expect(updates[1].slice(3, 19)).toEqual([
      1, null, 1, null, 0, null, 1, null,
      1, null, 1, null, 1, null, 1, null,
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
    const canonical = await pullChanges(db, "user_1", 3, "0", 4);
    expect(legacy.changes[0].payload).not.toHaveProperty("monthEndBalanceGoalMinor");
    expect(legacy.changes[0].payload).not.toHaveProperty("payCycle");
    expect(current.changes[0].payload).toHaveProperty("monthEndBalanceGoalMinor", 25_000);
    expect(current.changes[0].payload).not.toHaveProperty("payCycle");
    expect(latest.changes[0].payload).toHaveProperty("payCycle", {
      paydayDay: 10,
      monthlySalaryMinor: 800_000,
      cycleEndBalanceGoalMinor: 100_000,
    });
    expect(canonical.changes[0].payload).toHaveProperty("payCycle", {
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 100_000,
    });
    expect(canonical.changes[0].payload).not.toHaveProperty("incomeForecast");
  });

  it("projects the v4 expected income to v3 without leaking internal fields", async () => {
    const incomeForecast = {
      id: "forecast_2026_08_10",
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 600_000,
      expectedIncomeMinor: 800_000,
    };
    const row = {
      cursor: "10",
      mutation_id: "mutation_settings_2",
      entity_type: "settings",
      entity_id: "primary",
      entity_version: 3,
      mutation_hash: "hash",
      payload_json: JSON.stringify({
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        payCycle: { paydayDay: 10, cycleEndBalanceGoalMinor: 100_000 },
        incomeForecast,
        _legacyMonthlySalaryMinor: 800_000,
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

    const versionThree = await pullChanges(db, "user_1", 3, "0", 3);
    const versionFour = await pullChanges(db, "user_1", 3, "0", 4);
    expect(versionThree.changes[0].payload).toHaveProperty("payCycle", {
      paydayDay: 10,
      monthlySalaryMinor: 800_000,
      cycleEndBalanceGoalMinor: 100_000,
    });
    expect(versionThree.changes[0].payload).not.toHaveProperty("incomeForecast");
    expect(versionFour.changes[0].payload).toHaveProperty(
      "incomeForecast",
      incomeForecast,
    );
    expect(versionFour.changes[0].payload).not.toHaveProperty(
      "_legacyMonthlySalaryMinor",
    );
  });

  it("projects the current settings row and exposes a legacy claim hint", async () => {
    let query = "";
    const row = {
      cursor: "11",
      mutation_id: "mutation_settings_3",
      entity_type: "settings" as const,
      entity_id: "primary",
      entity_version: 4,
      mutation_hash: "hash",
      payload_json: "{}",
      settings_id: "primary",
      settings_currency: "CNY",
      settings_initial_balance_minor: 500,
      settings_month_end_balance_goal_minor: null,
      settings_payday_day: 10,
      settings_monthly_salary_minor: 700_000,
      settings_cycle_end_balance_goal_minor: 100_000,
      settings_income_forecast_id: null,
      settings_income_forecast_target_payday_date_key: null,
      settings_minimum_income_minor: null,
      settings_expected_income_minor: null,
      settings_schema_version: 1,
      settings_updated_at: "2026-07-30T12:00:00.000Z",
    };
    const db = {
      prepare(statement: string) {
        query = statement;
        return {
          bind() { return this; },
          async all() { return { results: [row] }; },
        };
      },
    } as unknown as D1Database;

    const v4 = await pullChanges(db, "user_1", 3, "0", 4);
    expect(query).toContain("LEFT JOIN ledger_settings");
    expect(query).toContain("current_settings.expected_income_minor");
    expect(v4.changes[0].payload).toMatchObject({
      payCycle: { paydayDay: 10, cycleEndBalanceGoalMinor: 100_000 },
      _legacyMonthlySalaryMinor: 700_000,
    });

    const v3 = await pullChanges(db, "user_1", 3, "0", 3);
    expect(v3.changes[0].payload).toMatchObject({
      payCycle: {
        paydayDay: 10,
        monthlySalaryMinor: 700_000,
        cycleEndBalanceGoalMinor: 100_000,
      },
    });
  });

  it("does not downgrade a zero expected income to a v3 salary", async () => {
    const row = {
      cursor: "12",
      mutation_id: "mutation_settings_4",
      entity_type: "settings" as const,
      entity_id: "primary",
      entity_version: 4,
      mutation_hash: "hash",
      payload_json: "{}",
      settings_id: "primary",
      settings_currency: "CNY",
      settings_initial_balance_minor: 500,
      settings_month_end_balance_goal_minor: null,
      settings_payday_day: 10,
      settings_monthly_salary_minor: null,
      settings_cycle_end_balance_goal_minor: 100_000,
      settings_income_forecast_id: "forecast_zero",
      settings_income_forecast_target_payday_date_key: "2026-08-10",
      settings_minimum_income_minor: 0,
      settings_expected_income_minor: 0,
      settings_schema_version: 1,
      settings_updated_at: "2026-07-30T12:00:00.000Z",
    };
    const db = {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [row] }; },
        };
      },
    } as unknown as D1Database;

    const v3 = await pullChanges(db, "user_1", 3, "0", 3);
    const v4 = await pullChanges(db, "user_1", 3, "0", 4);
    expect(v3.changes[0].payload).not.toHaveProperty("payCycle");
    expect(v4.changes[0].payload).toHaveProperty("incomeForecast", {
      id: "forecast_zero",
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 0,
      expectedIncomeMinor: 0,
    });
    expect(v4.changes[0].payload).not.toHaveProperty("_legacyMonthlySalaryMinor");
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
