// @vitest-environment node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  IncomeConfirmationPayload,
  LedgerEntryPayload,
  SyncMutation,
} from "./types";
import { applyMutation } from "./sync";

const USER_ID = "user_income_confirmation";
const GENERATION = 1;
const NOW = "2026-08-10T01:00:00.000Z";

type SettingsMutation = Extract<SyncMutation, { entityType: "settings" }>;

function settingsMutation(
  id: string,
  baseVersion: number,
  overrides: Partial<SettingsMutation["payload"]> = {},
): SettingsMutation {
  return {
    id,
    entityType: "settings",
    entityId: "primary",
    baseVersion,
    payload: {
      id: "primary",
      currency: "CNY",
      initialBalanceMinor: 0,
      payCycle: { paydayDay: 10 },
      schemaVersion: 1,
      updatedAt: NOW,
      ...overrides,
    },
  };
}

function confirmation(
  confirmationId: string,
  actualIncomeMinor: number,
): IncomeConfirmationPayload {
  const entry: LedgerEntryPayload | undefined = actualIncomeMinor > 0
    ? {
        id: "forecast_2026_08_10",
        amountMinor: actualIncomeMinor,
        note: "本次实际收入",
        occurredAt: NOW,
        localDateKey: "2026-08-10",
        localMonthKey: "2026-08",
        timezoneOffsetMinutes: -480,
        treatment: "ordinary_income",
        confirmationStatus: "not_needed",
        createdAt: NOW,
        updatedAt: NOW,
      }
    : undefined;
  return {
    confirmationId,
    forecastId: "forecast_2026_08_10",
    targetPaydayDateKey: "2026-08-10",
    expectedIncomeMinor: 80_000,
    actualIncomeMinor,
    confirmedAt: NOW,
    ...(entry ? { entry, entryMutationId: `entry_mutation_${confirmationId}` } : {}),
  };
}

function confirmationMutation(
  id: string,
  receipt: IncomeConfirmationPayload,
  baseVersion = 1,
): SettingsMutation {
  return settingsMutation(id, baseVersion, {
    incomeForecast: null,
    lastExpectedIncomeMinor: 80_000,
    incomeConfirmation: receipt,
  });
}

describe("income confirmation D1 transaction", () => {
  let runtime: Miniflare;
  let database: D1Database;

  beforeEach(async () => {
    runtime = new Miniflare({
      modules: true,
      compatibilityDate: "2026-07-29",
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: { DB: crypto.randomUUID() },
    });
    database = await runtime.getD1Database("DB");
    for (let version = 1; version <= 12; version += 1) {
      const prefix = String(version).padStart(4, "0");
      const migration = new URL(
        `../../migrations/${prefix}_${[
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
        ][version - 1]}.sql`,
        import.meta.url,
      );
      const sql = (await readFile(fileURLToPath(String(migration)), "utf8"))
        .replace(/^PRAGMA foreign_keys = ON;\s*/u, "")
        .replace(/--.*$/gmu, "")
        .replace(/\s+/gu, " ");
      await database.exec(sql);
    }
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
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  async function seedForecast(): Promise<void> {
    await applyMutation(database, USER_ID, GENERATION, settingsMutation("settings_forecast", 0, {
      incomeForecast: {
        id: "forecast_2026_08_10",
        targetPaydayDateKey: "2026-08-10",
        expectedIncomeMinor: 80_000,
      },
    }), 7);
  }

  async function counts(): Promise<{ receipts: number; entries: number }> {
    const receipts = await database.prepare(
      "SELECT COUNT(*) AS count FROM income_confirmations",
    ).first<{ count: number }>();
    const entries = await database.prepare(
      "SELECT COUNT(*) AS count FROM ledger_entries",
    ).first<{ count: number }>();
    return { receipts: Number(receipts?.count), entries: Number(entries?.count) };
  }

  it("applies a positive confirmation once and returns the canonical entry on retry", async () => {
    await seedForecast();
    const mutation = confirmationMutation(
      "settings_confirm_positive",
      confirmation("confirmation_positive", 75_000),
    );

    const applied = await applyMutation(database, USER_ID, GENERATION, mutation, 7);
    const retried = await applyMutation(database, USER_ID, GENERATION, mutation, 7);

    expect(applied).toMatchObject({
      status: "applied",
      version: 2,
      incomeConfirmation: {
        forecastId: "forecast_2026_08_10",
        actualIncomeMinor: 75_000,
        entryVersion: 1,
        entry: { amountMinor: 75_000 },
      },
    });
    expect(retried).toMatchObject({ status: "duplicate", incomeConfirmation: { actualIncomeMinor: 75_000 } });
    await expect(counts()).resolves.toEqual({ receipts: 1, entries: 1 });
  });

  it("stores a delayed actual income date while preserving the original forecast date", async () => {
    await applyMutation(database, USER_ID, GENERATION, settingsMutation(
      "settings_forecast_delayed",
      0,
      {
        incomeForecast: {
          id: "forecast_2026_08_15",
          targetPaydayDateKey: "2026-08-15",
          expectedIncomeMinor: 80_000,
        },
      },
    ), 7);
    const delayed = confirmation("confirmation_delayed", 75_000);
    delayed.forecastId = "forecast_2026_08_15";
    delayed.targetPaydayDateKey = "2026-08-15";
    delayed.confirmedAt = "2026-08-18T02:00:00.000Z";
    if (!delayed.entry) throw new Error("Expected a positive income entry");
    delayed.entry.id = "forecast_2026_08_15";
    delayed.entry.occurredAt = "2026-08-18T01:00:00.000Z";
    delayed.entry.localDateKey = "2026-08-18";
    delayed.entry.localMonthKey = "2026-08";
    delayed.entry.createdAt = "2026-08-18T01:00:00.000Z";
    delayed.entry.updatedAt = "2026-08-18T01:00:00.000Z";
    const delayedMutation = confirmationMutation("settings_confirm_delayed", delayed);
    delayedMutation.payload.updatedAt = delayed.confirmedAt;

    const applied = await applyMutation(
      database,
      USER_ID,
      GENERATION,
      delayedMutation,
      7,
    );

    expect(applied).toMatchObject({
      status: "applied",
      incomeConfirmation: {
        forecastId: "forecast_2026_08_15",
        actualIncomeMinor: 75_000,
        entry: {
          occurredAt: "2026-08-18T01:00:00.000Z",
          localDateKey: "2026-08-18",
        },
      },
    });
    await expect(database.prepare(
      `SELECT target_payday_date_key, confirmed_at
       FROM income_confirmations
       WHERE user_id = ? AND account_generation = ? AND forecast_id = ?`,
    ).bind(USER_ID, GENERATION, delayed.forecastId).first()).resolves.toMatchObject({
      target_payday_date_key: "2026-08-15",
      confirmed_at: "2026-08-18T02:00:00.000Z",
    });
    await expect(counts()).resolves.toEqual({ receipts: 1, entries: 1 });
  });

  it("atomically confirms a forecast that was created and consumed while offline", async () => {
    await applyMutation(
      database,
      USER_ID,
      GENERATION,
      settingsMutation("settings_without_forecast", 0),
      7,
    );

    const applied = await applyMutation(
      database,
      USER_ID,
      GENERATION,
      confirmationMutation(
        "settings_confirm_offline_forecast",
        confirmation("confirmation_offline_forecast", 75_000),
      ),
      7,
    );

    expect(applied).toMatchObject({
      status: "applied",
      version: 2,
      incomeConfirmation: {
        actualIncomeMinor: 75_000,
        entry: { amountMinor: 75_000 },
      },
    });
    await expect(counts()).resolves.toEqual({ receipts: 1, entries: 1 });
  });

  it("keeps the first amount when two devices confirm different positive amounts", async () => {
    await seedForecast();
    await applyMutation(
      database,
      USER_ID,
      GENERATION,
      confirmationMutation("settings_confirm_a", confirmation("confirmation_a", 75_000)),
      7,
    );
    const second = await applyMutation(
      database,
      USER_ID,
      GENERATION,
      confirmationMutation("settings_confirm_b", confirmation("confirmation_b", 76_000)),
      7,
    );

    expect(second).toMatchObject({
      status: "duplicate",
      incomeConfirmation: {
        actualIncomeMinor: 75_000,
        entry: { amountMinor: 75_000 },
      },
    });
    await expect(counts()).resolves.toEqual({ receipts: 1, entries: 1 });
  });

  it("returns the current edited entry when an old device repeats confirmation", async () => {
    await seedForecast();
    const firstConfirmation = confirmation("confirmation_original", 75_000);
    await applyMutation(
      database,
      USER_ID,
      GENERATION,
      confirmationMutation("settings_confirm_original", firstConfirmation),
      7,
    );
    const originalEntry = firstConfirmation.entry;
    if (!originalEntry) throw new Error("Expected a positive income entry");
    await applyMutation(database, USER_ID, GENERATION, {
      id: "entry_edit_after_confirmation",
      entityType: "entry",
      entityId: originalEntry.id,
      baseVersion: 1,
      payload: {
        ...originalEntry,
        amountMinor: 70_000,
        note: "corrected income",
        updatedAt: "2026-08-10T02:00:00.000Z",
      },
    }, 7);
    await applyMutation(
      database,
      USER_ID,
      GENERATION,
      settingsMutation("settings_after_confirmation", 2, {
        lastExpectedIncomeMinor: 123,
      }),
      7,
    );

    const repeated = await applyMutation(
      database,
      USER_ID,
      GENERATION,
      confirmationMutation("settings_confirm_old_device", confirmation("confirmation_old_device", 76_000)),
      7,
    );

    expect(repeated).toMatchObject({
      status: "duplicate",
      // The receipt only rebases its own atomic settings write. The later
      // settings version must still arrive through the normal change feed.
      version: 2,
      incomeConfirmation: {
        forecastId: originalEntry.id,
        actualIncomeMinor: 75_000,
        entryVersion: 2,
        entry: {
          amountMinor: 70_000,
          note: "corrected income",
        },
      },
    });
    await expect(counts()).resolves.toEqual({ receipts: 1, entries: 1 });
  });

  it("does not create an entry when a zero confirmation wins the race", async () => {
    await seedForecast();
    await applyMutation(
      database,
      USER_ID,
      GENERATION,
      confirmationMutation("settings_confirm_zero", confirmation("confirmation_zero", 0)),
      7,
    );
    const stalePositive = await applyMutation(
      database,
      USER_ID,
      GENERATION,
      confirmationMutation("settings_confirm_stale", confirmation("confirmation_stale", 75_000)),
      7,
    );

    expect(stalePositive).toMatchObject({
      status: "duplicate",
      incomeConfirmation: { actualIncomeMinor: 0 },
    });
    expect(stalePositive).not.toHaveProperty("incomeConfirmation.entry");
    await expect(counts()).resolves.toEqual({ receipts: 1, entries: 0 });
  });

  it("writes neither receipt nor entry when the settings version is stale", async () => {
    await seedForecast();
    await applyMutation(
      database,
      USER_ID,
      GENERATION,
      settingsMutation("settings_other_change", 1, {
        incomeForecast: {
          id: "forecast_2026_08_10",
          targetPaydayDateKey: "2026-08-10",
          expectedIncomeMinor: 80_000,
        },
        initialBalanceMinor: 1,
      }),
      7,
    );
    const stale = await applyMutation(
      database,
      USER_ID,
      GENERATION,
      confirmationMutation("settings_stale_confirmation", confirmation("confirmation_stale_version", 75_000)),
      7,
    );

    expect(stale.status).toBe("conflict");
    await expect(counts()).resolves.toEqual({ receipts: 0, entries: 0 });
    const settings = await database.prepare(
      "SELECT income_forecast_id, initial_balance_minor FROM ledger_settings",
    ).first<{ income_forecast_id: string; initial_balance_minor: number }>();
    expect(settings).toEqual({
      income_forecast_id: "forecast_2026_08_10",
      initial_balance_minor: 1,
    });
  });

  it("lets a version-four client explicitly clear a compatible pay cycle", async () => {
    await seedForecast();

    await expect(applyMutation(
      database,
      USER_ID,
      GENERATION,
      settingsMutation("settings_clear_v4", 1, {
        payCycle: null,
        incomeForecast: null,
      }),
      4,
    )).resolves.toMatchObject({ status: "applied", version: 2 });

    const settings = await database.prepare(
      `SELECT payday_day, default_savings_target_minor,
              income_forecast_id, expected_income_minor
       FROM ledger_settings`,
    ).first<{
      payday_day: number | null;
      default_savings_target_minor: number | null;
      income_forecast_id: string | null;
      expected_income_minor: number | null;
    }>();
    expect(settings).toEqual({
      payday_day: null,
      default_savings_target_minor: null,
      income_forecast_id: null,
      expected_income_minor: null,
    });
  });
});
