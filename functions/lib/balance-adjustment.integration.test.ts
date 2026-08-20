// @vitest-environment node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import type { BalanceAdjustmentPayload, SyncMutation } from "./types";
import {
  applyMutation,
  assertLegacyClientCompatible,
  pullChanges,
} from "./sync";

const USER_ID = "user_balance_adjustment";
const GENERATION = 1;
const NOW = "2026-08-19T02:00:00.000Z";
const MIGRATION_NAMES = [
  "cloud_sync",
  "github_oauth",
  "deletion_quiet_window",
  "month_end_balance_goal",
  "pay_cycle_plan",
  "income_forecast",
  "entry_treatment_recovery_allocations",
  "savings_events",
  "savings_goal",
  "savings_goal_compatibility_fix",
  "balance_adjustments",
  "periodic_expense",
] as const;

type SettingsMutation = Extract<SyncMutation, { entityType: "settings" }>;
type AdjustmentMutation = Extract<SyncMutation, { entityType: "balanceAdjustment" }>;

async function applyMigrations(
  database: D1Database,
  through = 12,
  from = 1,
): Promise<void> {
  for (let version = from; version <= through; version += 1) {
    const prefix = String(version).padStart(4, "0");
    const migration = new URL(
      `../../migrations/${prefix}_${MIGRATION_NAMES[version - 1]}.sql`,
      import.meta.url,
    );
    const sql = (await readFile(fileURLToPath(String(migration)), "utf8"))
      .replace(/^PRAGMA foreign_keys = ON;\s*/u, "")
      .replace(/--.*$/gmu, "")
      .replace(/\s+/gu, " ");
    await database.exec(sql);
  }
}

async function createDatabase(through = 12): Promise<{
  runtime: Miniflare;
  database: D1Database;
}> {
  const runtime = new Miniflare({
    modules: true,
    compatibilityDate: "2026-07-29",
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: crypto.randomUUID() },
  });
  const database = await runtime.getD1Database("DB");
  await applyMigrations(database, through);
  await database.batch([
    database.prepare(
      `INSERT INTO cloud_sync_state (user_id, status, generation, updated_at)
       VALUES (?, 'enabled', ?, ?)`,
    ).bind(USER_ID, GENERATION, NOW),
    database.prepare(
      `INSERT INTO users (id, issuer, subject, email, generation, created_at, updated_at)
       VALUES (?, 'test', 'subject', 'owner@example.test', ?, ?, ?)`,
    ).bind(USER_ID, GENERATION, NOW, NOW),
  ]);
  return { runtime, database };
}

function settingsMutation(
  id: string,
  baseVersion: number,
  initialBalanceMinor = 1_000,
): SettingsMutation {
  return {
    id,
    entityType: "settings",
    entityId: "primary",
    baseVersion,
    payload: {
      id: "primary",
      currency: "CNY",
      initialBalanceMinor,
      schemaVersion: 1,
      updatedAt: NOW,
    },
  };
}

function reconciliation(
  overrides: Partial<BalanceAdjustmentPayload> = {},
): AdjustmentMutation {
  const payload: BalanceAdjustmentPayload = {
    id: "adjustment_1",
    kind: "reconciliation",
    amountMinor: -250,
    balanceBeforeMinor: 1_000,
    observedBalanceMinor: 750,
    note: "cash check",
    occurredAt: NOW,
    localDateKey: "2026-08-19",
    localMonthKey: "2026-08",
    timezoneOffsetMinutes: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as BalanceAdjustmentPayload;
  return {
    id: "mutation_adjustment_1",
    entityType: "balanceAdjustment",
    entityId: payload.id,
    baseVersion: 0,
    payload,
  };
}

describe("balance adjustment D1 sync", () => {
  const runtimes: Miniflare[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  });

  async function readyDatabase(): Promise<D1Database> {
    const created = await createDatabase();
    runtimes.push(created.runtime);
    await applyMutation(
      created.database,
      USER_ID,
      GENERATION,
      settingsMutation("mutation_settings_1", 0),
      8,
    );
    return created.database;
  }

  it("applies an adjustment once, locks the opening balance, and fully projects it", async () => {
    const database = await readyDatabase();
    const mutation = reconciliation();

    await expect(applyMutation(database, USER_ID, GENERATION, mutation, 8))
      .resolves.toMatchObject({ status: "applied", version: 1 });
    await expect(applyMutation(database, USER_ID, GENERATION, mutation, 8))
      .resolves.toMatchObject({ status: "duplicate", version: 1 });
    await expect(assertLegacyClientCompatible(database, USER_ID, GENERATION, 8))
      .resolves.toBeUndefined();

    await database.prepare(
      `UPDATE sync_changes SET payload_json = '{}'
       WHERE user_id = ? AND entity_type = 'balanceAdjustment'`,
    ).bind(USER_ID).run();
    const pulled = await pullChanges(database, USER_ID, GENERATION, "0", 8);
    expect(pulled.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: "settings",
        payload: expect.objectContaining({ initialBalanceLockedAt: NOW }),
      }),
      expect.objectContaining({
        entityType: "balanceAdjustment",
        payload: expect.objectContaining({
          id: "adjustment_1",
          amountMinor: -250,
          balanceBeforeMinor: 1_000,
          observedBalanceMinor: 750,
        }),
      }),
    ]));
    for (const protocolVersion of [1, 2, 3, 4, 5, 6, 7] as const) {
      const legacy = await pullChanges(
        database,
        USER_ID,
        GENERATION,
        "0",
        protocolVersion,
      );
      expect(legacy.changes).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ entityType: "balanceAdjustment" }),
      ]));
      expect(legacy.changes.find((change) => change.entityType === "settings")?.payload)
        .not.toHaveProperty("initialBalanceLockedAt");
    }
  }, 15_000);

  it("rejects opening-balance changes and blocks pre-v8 clients for an active adjustment", async () => {
    const database = await readyDatabase();
    await database.prepare(
      `UPDATE ledger_settings
       SET savings_goal_target_date_key = '2026-12-31',
           savings_goal_target_minor = 100000
       WHERE user_id = ?`,
    ).bind(USER_ID).run();
    await expect(assertLegacyClientCompatible(database, USER_ID, GENERATION, 7))
      .resolves.toBeUndefined();
    await applyMutation(database, USER_ID, GENERATION, reconciliation(), 8);
    const olderFactTime = "2026-08-18T02:00:00.000Z";
    const older = reconciliation({
      id: "adjustment_older",
      occurredAt: olderFactTime,
      localDateKey: "2026-08-18",
      createdAt: olderFactTime,
      updatedAt: olderFactTime,
    });
    older.id = "mutation_adjustment_older";
    await applyMutation(database, USER_ID, GENERATION, older, 8);
    await expect(database.prepare(
      "SELECT initial_balance_locked_at FROM ledger_settings WHERE user_id = ?",
    ).bind(USER_ID).first()).resolves.toEqual({
      initial_balance_locked_at: olderFactTime,
    });

    await expect(applyMutation(
      database,
      USER_ID,
      GENERATION,
      settingsMutation("mutation_settings_changed", 1, 1_001),
      8,
    )).rejects.toMatchObject({ code: "initial_balance_locked", status: 409 });
    for (const version of [1, 2, 3, 4, 5, 6, 7] as const) {
      await expect(assertLegacyClientCompatible(
        database,
        USER_ID,
        GENERATION,
        version,
      )).rejects.toMatchObject({ code: "upgrade_required" });
    }
  }, 15_000);

  it("keeps legacy sync available after an adjustment is voided but still protects the opening balance", async () => {
    const database = await readyDatabase();
    await applyMutation(database, USER_ID, GENERATION, reconciliation(), 8);
    const deletedAt = "2026-08-19T02:00:07.000Z";
    const tombstone = reconciliation({ updatedAt: deletedAt, deletedAt });
    tombstone.id = "mutation_adjustment_delete_for_legacy";
    tombstone.baseVersion = 1;
    await applyMutation(database, USER_ID, GENERATION, tombstone, 8);

    await expect(assertLegacyClientCompatible(database, USER_ID, GENERATION, 7))
      .resolves.toBeUndefined();
    await expect(applyMutation(
      database,
      USER_ID,
      GENERATION,
      settingsMutation("mutation_settings_legacy_same", 1),
      7,
    )).resolves.toMatchObject({ status: "applied", version: 2 });
    await expect(applyMutation(
      database,
      USER_ID,
      GENERATION,
      settingsMutation("mutation_settings_legacy_changed", 2, 1_001),
      7,
    )).rejects.toMatchObject({ code: "initial_balance_locked", status: 409 });
  }, 15_000);

  it("allows only tombstone changes and returns a canonical conflict to a stale device", async () => {
    const database = await readyDatabase();
    await applyMutation(database, USER_ID, GENERATION, reconciliation(), 8);
    const deletedAt = "2026-08-19T02:00:07.000Z";
    const tombstone = reconciliation({ updatedAt: deletedAt, deletedAt });
    tombstone.id = "mutation_adjustment_delete";
    tombstone.baseVersion = 1;
    await expect(applyMutation(database, USER_ID, GENERATION, tombstone, 8))
      .resolves.toMatchObject({ status: "applied", version: 2 });

    const stale = reconciliation({ note: "changed audit", updatedAt: deletedAt });
    stale.id = "mutation_adjustment_stale";
    stale.baseVersion = 1;
    await expect(applyMutation(database, USER_ID, GENERATION, stale, 8))
      .resolves.toMatchObject({
        status: "conflict",
        remote: {
          entityType: "balanceAdjustment",
          version: 2,
          payload: { deletedAt },
        },
      });
    await expect(database.prepare(
      "UPDATE balance_adjustments SET note = 'tampered' WHERE user_id = ? AND id = ?",
    ).bind(USER_ID, "adjustment_1").run()).rejects.toThrow(/immutable_balance_adjustment/);
    await expect(database.prepare(
      `UPDATE balance_adjustments
       SET deleted_at = NULL, updated_at = ?, last_mutation_id = ?
       WHERE user_id = ? AND id = ?`,
    ).bind(NOW, "mutation_adjustment_resurrect_direct", USER_ID, "adjustment_1").run())
      .rejects.toThrow(/immutable_balance_adjustment/);

    const resurrected = reconciliation({ updatedAt: "2026-08-19T02:00:08.000Z" });
    resurrected.id = "mutation_adjustment_resurrect";
    resurrected.baseVersion = 2;
    await expect(applyMutation(database, USER_ID, GENERATION, resurrected, 8))
      .resolves.toMatchObject({
        status: "conflict",
        remote: { version: 2, payload: { deletedAt } },
      });
  }, 15_000);

  it("enforces the eight-second void window in D1", async () => {
    const database = await readyDatabase();
    await applyMutation(database, USER_ID, GENERATION, reconciliation(), 8);
    const late = reconciliation({
      updatedAt: "2026-08-19T02:00:09.000Z",
      deletedAt: "2026-08-19T02:00:09.000Z",
    });
    late.id = "mutation_adjustment_late_delete";
    late.baseVersion = 1;

    await expect(applyMutation(database, USER_ID, GENERATION, late, 8))
      .rejects.toThrow(/CHECK constraint failed/);
    await expect(database.prepare(
      "SELECT deleted_at, version FROM balance_adjustments WHERE user_id = ? AND id = ?",
    ).bind(USER_ID, "adjustment_1").first()).resolves.toEqual({
      deleted_at: null,
      version: 1,
    });
  }, 15_000);

  it("backfills locks from deleted historical facts and cascades adjustments on account deletion", async () => {
    const created = await createDatabase(10);
    runtimes.push(created.runtime);
    const database = created.database;
    await database.prepare(
      `INSERT INTO ledger_settings (
         user_id, account_generation, id, currency, initial_balance_minor,
         schema_version, updated_at, version, last_mutation_id,
         last_mutation_hash, server_updated_at
       ) VALUES (?, ?, 'primary', 'CNY', 1000, 1, ?, 1,
         'mutation_settings_legacy', ?, ?)`,
    ).bind(USER_ID, GENERATION, NOW, "1".repeat(64), NOW).run();
    await database.prepare(
      `INSERT INTO ledger_entries (
         user_id, account_generation, id, amount_minor, note, occurred_at,
         local_date_key, local_month_key, timezone_offset_minutes, treatment,
         confirmation_status, created_at, updated_at, deleted_at, version,
         last_mutation_id, last_mutation_hash, server_updated_at
       ) VALUES (?, ?, 'entry_old', -100, '', ?, '2026-08-18', '2026-08', 0,
         'ordinary_expense', 'not_needed', ?, ?, ?, 1, 'mutation_entry_old', ?, ?)`,
    ).bind(
      USER_ID,
      GENERATION,
      "2026-08-18T01:00:00.000Z",
      "2026-08-18T01:00:00.000Z",
      "2026-08-18T02:00:00.000Z",
      "2026-08-18T02:00:00.000Z",
      "0".repeat(64),
      "2026-08-18T02:00:00.000Z",
    ).run();
    await applyMigrations(database, 11, 11);
    await expect(database.prepare(
      "SELECT initial_balance_locked_at FROM ledger_settings WHERE user_id = ?",
    ).bind(USER_ID).first()).resolves.toEqual({
      initial_balance_locked_at: "2026-08-18T01:00:00.000Z",
    });

    await applyMutation(database, USER_ID, GENERATION, reconciliation(), 8);
    await database.prepare("DELETE FROM users WHERE id = ?").bind(USER_ID).run();
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM balance_adjustments WHERE user_id = ?",
    ).bind(USER_ID).first()).resolves.toEqual({ count: 0 });
  }, 15_000);
});
