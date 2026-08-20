// @vitest-environment node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EntryTreatment,
  LedgerEntryPayload,
  RecoveryAllocationPayload,
  SyncMutation,
} from "./types";
import {
  applyMutation,
  assertLegacyClientCompatible,
  pullChanges,
} from "./sync";

const USER_ID = "user_periodic_expense";
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

type EntryMutation = Extract<SyncMutation, { entityType: "entry" }>;
type RecoveryMutation = Extract<SyncMutation, { entityType: "recoveryAllocation" }>;

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

function entryMutation(
  id: string,
  amountMinor: number,
  treatment: EntryTreatment,
  baseVersion = 0,
): EntryMutation {
  const payload: LedgerEntryPayload = {
    id,
    amountMinor,
    note: id,
    occurredAt: NOW,
    localDateKey: "2026-08-19",
    localMonthKey: "2026-08",
    timezoneOffsetMinutes: 0,
    treatment,
    confirmationStatus: "confirmed",
    detectionRuleVersion: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    id: `mutation_${id}_${baseVersion}`,
    entityType: "entry",
    entityId: id,
    baseVersion,
    payload,
  };
}

function recoveryMutation(): RecoveryMutation {
  const payload: RecoveryAllocationPayload = {
    id: "allocation_1",
    refundEntryId: "refund_1",
    expenseEntryId: "expense_1",
    amountMinor: 800,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    id: "mutation_allocation_1",
    entityType: "recoveryAllocation",
    entityId: payload.id,
    baseVersion: 0,
    payload,
  };
}

describe("periodic expense D1 sync", () => {
  const runtimes: Miniflare[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  });

  it("backfills canonical treatments and accepts a treatment-only legacy update", async () => {
    const created = await createDatabase(11);
    runtimes.push(created.runtime);
    const database = created.database;
    await database.prepare(
      `INSERT INTO ledger_entries (
         user_id, account_generation, id, amount_minor, note, occurred_at,
         local_date_key, local_month_key, timezone_offset_minutes, treatment,
         confirmation_status, created_at, updated_at, version,
         last_mutation_id, last_mutation_hash, server_updated_at
       ) VALUES (?, ?, 'legacy_expense', -1000, 'legacy', ?, '2026-08-19',
         '2026-08', 0, 'ordinary_expense', 'confirmed', ?, ?, 1,
         'mutation_legacy_expense', ?, ?)`,
    ).bind(USER_ID, GENERATION, NOW, NOW, NOW, "1".repeat(64), NOW).run();

    await applyMigrations(database, 12, 12);
    await expect(database.prepare(
      `SELECT treatment, analysis_treatment FROM ledger_entries
       WHERE user_id = ? AND id = 'legacy_expense'`,
    ).bind(USER_ID).first()).resolves.toEqual({
      treatment: "ordinary_expense",
      analysis_treatment: "ordinary_expense",
    });

    await database.prepare(
      `INSERT INTO ledger_entries (
         user_id, account_generation, id, amount_minor, note, occurred_at,
         local_date_key, local_month_key, timezone_offset_minutes, treatment,
         confirmation_status, created_at, updated_at, version,
         last_mutation_id, last_mutation_hash, server_updated_at
       ) VALUES (?, ?, 'rollout_expense', -500, 'rollout', ?, '2026-08-19',
         '2026-08', 0, 'ordinary_expense', 'confirmed', ?, ?, 1,
         'mutation_rollout_expense', ?, ?)`,
    ).bind(USER_ID, GENERATION, NOW, NOW, NOW, "2".repeat(64), NOW).run();
    await expect(database.prepare(
      `SELECT analysis_treatment FROM ledger_entries
       WHERE user_id = ? AND id = 'rollout_expense'`,
    ).bind(USER_ID).first()).resolves.toEqual({
      analysis_treatment: "ordinary_expense",
    });

    await database.prepare(
      `UPDATE ledger_entries
       SET treatment = 'one_time_expense', version = version + 1,
           last_mutation_id = 'mutation_legacy_update'
       WHERE user_id = ? AND id = 'legacy_expense'`,
    ).bind(USER_ID).run();
    await expect(database.prepare(
      `SELECT treatment, analysis_treatment FROM ledger_entries
       WHERE user_id = ? AND id = 'legacy_expense'`,
    ).bind(USER_ID).first()).resolves.toEqual({
      treatment: "one_time_expense",
      analysis_treatment: "one_time_expense",
    });
  }, 15_000);

  it("writes periodic treatment canonically and projects the legacy shadow", async () => {
    const created = await createDatabase();
    runtimes.push(created.runtime);
    const database = created.database;
    const mutation = entryMutation("periodic_1", -12_000, "periodic_expense");

    await expect(applyMutation(database, USER_ID, GENERATION, mutation, 9))
      .resolves.toMatchObject({ status: "applied", version: 1 });
    await expect(database.prepare(
      `SELECT treatment, analysis_treatment FROM ledger_entries
       WHERE user_id = ? AND id = ?`,
    ).bind(USER_ID, mutation.entityId).first()).resolves.toEqual({
      treatment: "one_time_expense",
      analysis_treatment: "periodic_expense",
    });

    await database.prepare(
      `UPDATE sync_changes SET payload_json = '{}'
       WHERE user_id = ? AND entity_type = 'entry'`,
    ).bind(USER_ID).run();
    const current = await pullChanges(database, USER_ID, GENERATION, "0", 9);
    expect(current.changes).toEqual([
      expect.objectContaining({
        entityType: "entry",
        payload: expect.objectContaining({ treatment: "periodic_expense" }),
      }),
    ]);
    const legacyProjection = await pullChanges(database, USER_ID, GENERATION, "0", 8);
    expect(legacyProjection.changes[0]?.payload).toMatchObject({
      treatment: "one_time_expense",
    });
    await expect(assertLegacyClientCompatible(database, USER_ID, GENERATION, 8))
      .rejects.toMatchObject({ code: "upgrade_required" });
    await expect(assertLegacyClientCompatible(database, USER_ID, GENERATION, 9))
      .resolves.toBeUndefined();
  }, 15_000);

  it("keeps recovery allocations while closing into every expense treatment", async () => {
    const created = await createDatabase();
    runtimes.push(created.runtime);
    const database = created.database;
    await applyMutation(
      database,
      USER_ID,
      GENERATION,
      entryMutation("refund_1", 800, "refund_reimbursement"),
      9,
    );
    await applyMutation(
      database,
      USER_ID,
      GENERATION,
      entryMutation("expense_1", -1_000, "reimbursable_expense"),
      9,
    );
    await applyMutation(database, USER_ID, GENERATION, recoveryMutation(), 9);

    for (const [index, treatment] of [
      "one_time_expense",
      "periodic_expense",
      "ordinary_expense",
      "reimbursable_expense",
    ].entries()) {
      const mutation = entryMutation(
        "expense_1",
        -1_000,
        treatment as EntryTreatment,
        index + 1,
      );
      await expect(applyMutation(database, USER_ID, GENERATION, mutation, 9))
        .resolves.toMatchObject({ status: "applied", version: index + 2 });
    }

    await expect(database.prepare(
      `SELECT COUNT(*) AS count FROM recovery_allocations
       WHERE user_id = ? AND deleted_at IS NULL`,
    ).bind(USER_ID).first()).resolves.toEqual({ count: 1 });
  }, 15_000);
});
