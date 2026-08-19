import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, RecoveryAllocation, SavingsEvent } from "../domain/types";
import {
  INDEXED_DB_VERSION,
  LedgerDatabase,
  applyRemoteChanges,
  clearSavingsGoal,
  createDefaultSettings,
  getSettings,
  migrateSavingsGoalSettings,
  markPushResults,
  recordActualIncome,
  reserveSavings,
  resolveSyncConflict,
  setIncomeForecast,
  setInitialBalance,
  setPayCyclePlan,
  setSavingsGoal,
  updateEntry,
} from "./database";

async function pendingIncomeConfirmation(database: LedgerDatabase) {
  return (await database.syncOutbox.toArray())
    .find((record) => record.incomeConfirmation !== undefined);
}

describe("v6 savings goal data layer", () => {
  let database: LedgerDatabase;

  beforeEach(async () => {
    database = new LedgerDatabase(`jiyibi-goal-${crypto.randomUUID()}`);
    await database.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    database.close();
    await database.delete();
  });

  it("migrates v5 settings, outbox and conflicts without changing savings events", async () => {
    database.close();
    await database.delete();
    const name = `jiyibi-goal-v5-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(5).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt, treatment, confirmationStatus",
      attachments: "id, entryId, createdAt",
      settings: "id",
      recoveryAllocations: "id, refundEntryId, expenseEntryId, deletedAt, createdAt",
      savingsEvents: "id, kind, occurredAt, localDateKey, localMonthKey, deletedAt, linkedExpenseEntryId, cycleStartDateKey, &[kind+cycleStartDateKey]",
      syncState: "id, accountId",
      entitySyncState: "id, [entityType+entityId], status",
      syncOutbox: "entityKey, &id, [entityType+entityId], createdAt",
      syncConflicts: "id, [entityType+entityId], createdAt",
    });
    await legacy.open();
    const nowIso = "2026-08-01T00:00:00.000Z";
    const oldSettings: AppSettings = {
      ...createDefaultSettings(new Date(nowIso)),
      payCycle: { paydayDay: 31, defaultSavingsTargetMinor: 50_000 },
      savingsTargetOverride: {
        targetPaydayDateKey: "2026-08-31",
        targetMinor: 60_000,
      },
      incomeForecast: {
        id: "forecast-1",
        targetPaydayDateKey: "2026-08-31",
        minimumIncomeMinor: 40_000,
        expectedIncomeMinor: 80_000,
      },
    };
    const historicalSettlement: SavingsEvent = {
      id: "savings-settlement-2026-07-31",
      kind: "cycle_settlement",
      amountMinor: 20_000,
      note: "legacy",
      occurredAt: nowIso,
      localDateKey: "2026-08-01",
      localMonthKey: "2026-08",
      timezoneOffsetMinutes: -480,
      cycleStartDateKey: "2026-07-01",
      cycleEndDateKey: "2026-07-31",
      goalMinorSnapshot: 50_000,
      openingRetainedMinor: 0,
      closingRetainedMinor: 20_000,
      netGrowthMinor: 20_000,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await legacy.table("settings").put(oldSettings);
    await legacy.table("savingsEvents").put(historicalSettlement);
    await legacy.table("syncOutbox").put({
      entityKey: "settings:primary",
      id: "mutation-1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 1,
      payload: oldSettings,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await legacy.table("syncConflicts").put({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      localPayload: oldSettings,
      remotePayload: oldSettings,
      remoteVersion: 2,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    legacy.close();

    const upgraded = new LedgerDatabase(name, new Date(2026, 7, 19, 12));
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(INDEXED_DB_VERSION);
      expect(await upgraded.settings.get("primary")).toMatchObject({
        payCycle: { paydayDay: 31 },
        savingsGoalNeedsSetup: true,
        lastExpectedIncomeMinor: 80_000,
        incomeForecast: {
          targetPaydayDateKey: "2026-08-31",
          expectedIncomeMinor: 80_000,
        },
      });
      expect(await upgraded.settings.get("primary")).not.toHaveProperty(
        "incomeForecast.minimumIncomeMinor",
      );
      expect(await upgraded.settings.get("primary")).not.toHaveProperty(
        "savingsTargetOverride",
      );
      expect(await upgraded.syncOutbox.get("settings:primary")).toMatchObject({
        payload: {
          payCycle: { paydayDay: 31 },
          savingsGoalNeedsSetup: true,
          lastExpectedIncomeMinor: 80_000,
        },
      });
      expect(await upgraded.syncConflicts.get("settings:primary")).toMatchObject({
        localPayload: { payCycle: { paydayDay: 31 }, savingsGoalNeedsSetup: true },
        remotePayload: { payCycle: { paydayDay: 31 }, savingsGoalNeedsSetup: true },
      });
      await expect(upgraded.savingsEvents.get(historicalSettlement.id)).resolves.toEqual(
        historicalSettlement,
      );
    } finally {
      upgraded.close();
      await upgraded.delete();
      database = new LedgerDatabase(`jiyibi-goal-${crypto.randomUUID()}`);
      await database.open();
    }
  });

  it("is idempotent and does not invent a cumulative goal", () => {
    const source: AppSettings = {
      ...createDefaultSettings(new Date(2026, 7, 1)),
      payCycle: { paydayDay: 10, defaultSavingsTargetMinor: 5_000 },
    };
    const first = migrateSavingsGoalSettings(source, new Date(2026, 7, 19));
    const second = migrateSavingsGoalSettings(first, new Date(2026, 7, 20));
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      payCycle: { paydayDay: 10 },
      savingsGoalNeedsSetup: true,
    });
    expect(first.savingsGoal).toBeUndefined();
  });

  it("sets and clears a goal without deleting retained-money records", async () => {
    await setInitialBalance(100_000, database);
    await reserveSavings({ amountMinor: 20_000 }, database, new Date(2026, 7, 1, 9));
    const saved = await setSavingsGoal(
      { targetDateKey: "2026-12-31", targetMinor: 100_000 },
      database,
      new Date(2026, 7, 19, 12),
    );
    expect(saved.savingsGoal).toEqual({
      targetDateKey: "2026-12-31",
      targetMinor: 100_000,
    });
    expect(saved.savingsGoalNeedsSetup).toBeUndefined();

    const cleared = await clearSavingsGoal(database, new Date(2026, 7, 20, 12));
    expect(cleared.savingsGoal).toBeUndefined();
    await expect(database.savingsEvents.count()).resolves.toBe(1);
    await expect(setSavingsGoal(
      { targetDateKey: "bad-date", targetMinor: 1 },
      database,
    )).rejects.toMatchObject({ code: "invalid-settings" });
  });

  it("keeps an explicit goal clear while later settings edits coalesce", async () => {
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: "2026-08-01T00:00:00.000Z",
    });
    await setSavingsGoal(
      { targetDateKey: "2026-12-31", targetMinor: 100_000 },
      database,
    );
    expect(await database.syncOutbox.get("settings:primary")).not.toHaveProperty(
      "clearSavingsGoal",
    );

    await clearSavingsGoal(database);
    await setInitialBalance(1_234, database);
    const cleared = await database.syncOutbox.get("settings:primary");
    expect(cleared?.clearSavingsGoal).toBe(true);
    expect(cleared?.payload).not.toHaveProperty("savingsGoal");

    await setSavingsGoal(
      { targetDateKey: "2027-01-31", targetMinor: 120_000 },
      database,
    );
    const reset = await database.syncOutbox.get("settings:primary");
    expect(reset).not.toHaveProperty("clearSavingsGoal");
    expect(reset?.payload).toHaveProperty("savingsGoal", {
      targetDateKey: "2027-01-31",
      targetMinor: 120_000,
    });
  });

  it("keeps every v7 settings clear when a conflict keeps the local version", async () => {
    const nowIso = "2026-08-19T04:00:00.000Z";
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: nowIso,
    });
    const local = await getSettings(database);
    const remote: AppSettings = {
      ...local,
      savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 100_000 },
      lastExpectedIncomeMinor: 80_000,
      updatedAt: nowIso,
    };
    await database.syncConflicts.put({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      localPayload: local,
      remotePayload: remote,
      remoteVersion: 4,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    await resolveSyncConflict(
      "settings",
      "primary",
      "keep-local",
      database,
      new Date(nowIso),
    );

    expect(await database.syncOutbox.get("settings:primary")).toMatchObject({
      baseVersion: 4,
      clearSavingsGoal: true,
      clearLastExpectedIncomeMinor: true,
      clearSavingsGoalNeedsSetup: true,
    });
  });

  it("stores one expected income and confirms it without a settlement", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    const planned = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    expect(planned.incomeForecast).toEqual(expect.objectContaining({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }));
    expect(planned.incomeForecast).not.toHaveProperty("minimumIncomeMinor");
    expect(planned.lastExpectedIncomeMinor).toBe(80_000);

    const result = await recordActualIncome(
      75_000,
      database,
      new Date(2026, 7, 10, 9),
    );
    expect(result.entry).toMatchObject({
      amountMinor: 75_000,
      localDateKey: "2026-08-10",
    });
    expect(result.settlement).toBeUndefined();
    expect(result.settings.incomeForecast).toBeUndefined();
    expect(result.settings.lastExpectedIncomeMinor).toBe(80_000);
    await expect(database.savingsEvents.count()).resolves.toBe(0);
  });

  it("keeps a pending income confirmation through later settings edits and rebasing", async () => {
    const setup = new Date(2026, 7, 9, 10);
    const nowIso = "2026-08-10T01:00:00.000Z";
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: nowIso,
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    const pending = await pendingIncomeConfirmation(database);
    expect(pending?.incomeConfirmation).toMatchObject({
      actualIncomeMinor: 75_000,
      entry: { amountMinor: 75_000 },
    });

    await setSavingsGoal(
      { targetDateKey: "2026-12-31", targetMinor: 100_000 },
      database,
      new Date(2026, 7, 10, 9, 1),
    );
    expect((await pendingIncomeConfirmation(database))?.incomeConfirmation)
      .toEqual(pending?.incomeConfirmation);

    const local = await getSettings(database);
    await database.syncConflicts.put({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      localPayload: local,
      remotePayload: { ...local, initialBalanceMinor: 1, updatedAt: nowIso },
      remoteVersion: 4,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await resolveSyncConflict(
      "settings",
      "primary",
      "keep-local",
      database,
      new Date(nowIso),
    );
    const rebasedSettings = await database.syncOutbox.get("settings:primary");
    expect(rebasedSettings).toMatchObject({ baseVersion: 4 });
    expect(await pendingIncomeConfirmation(database)).toMatchObject({
      baseVersion: 4,
      incomeConfirmation: pending?.incomeConfirmation,
    });
    expect(await pendingIncomeConfirmation(database))
      .not.toHaveProperty("absorbedSettingsMutationId");
  });

  it("removes a provisional income when a settings conflict uses the cloud version", async () => {
    const setup = new Date(2026, 7, 9, 10);
    const nowIso = "2026-08-10T01:00:00.000Z";
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: nowIso,
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const confirmed = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    const local = await getSettings(database);
    await database.syncConflicts.put({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      localPayload: local,
      remotePayload: { ...local, initialBalanceMinor: 1, updatedAt: nowIso },
      remoteVersion: 4,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    await resolveSyncConflict(
      "settings",
      "primary",
      "use-cloud",
      database,
      new Date(nowIso),
    );

    await expect(database.entries.get(confirmed.entry!.id)).resolves.toBeUndefined();
    await expect(database.syncOutbox.get("settings:primary")).resolves.toBeUndefined();
  });

  it("converges a provisional positive income to a canonical zero confirmation", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: "2026-08-09T02:00:00.000Z",
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const local = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    const sent = (await pendingIncomeConfirmation(database))!;

    await markPushResults([sent], [{
      id: sent.id,
      status: "duplicate",
      version: 2,
      incomeConfirmation: {
        confirmationId: "remote-zero-confirmation",
        forecastId: local.entry!.id,
        actualIncomeMinor: 0,
      },
    }], database);

    await expect(database.entries.get(local.entry!.id)).resolves.toBeUndefined();
    await expect(pendingIncomeConfirmation(database)).resolves.toBeUndefined();
    await expect(database.syncOutbox.get("settings:primary")).resolves.toMatchObject({
      baseVersion: 0,
    });
  });

  it("installs the canonical positive income when a local zero confirmation loses", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: "2026-08-09T02:00:00.000Z",
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    const planned = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    await recordActualIncome(0, database, new Date(2026, 7, 10, 9));
    const sent = (await pendingIncomeConfirmation(database))!;
    const forecastId = planned.incomeForecast!.id;
    const canonical = {
      id: forecastId,
      amountMinor: 75_000,
      note: "本次实际收入",
      occurredAt: "2026-08-10T01:00:00.000Z",
      localDateKey: "2026-08-10",
      localMonthKey: "2026-08",
      timezoneOffsetMinutes: -480,
      treatment: "ordinary_income" as const,
      confirmationStatus: "not_needed" as const,
      createdAt: "2026-08-10T01:00:00.000Z",
      updatedAt: "2026-08-10T01:00:00.000Z",
    };

    await markPushResults([sent], [{
      id: sent.id,
      status: "duplicate",
      version: 2,
      incomeConfirmation: {
        confirmationId: "remote-positive-confirmation",
        forecastId,
        actualIncomeMinor: 75_000,
        entryVersion: 1,
        entry: canonical,
      },
    }], database);

    await expect(database.entries.get(forecastId)).resolves.toEqual(canonical);
    await expect(database.entitySyncState.get(`entry:${forecastId}`)).resolves.toMatchObject({
      serverVersion: 1,
      status: "clean",
    });
  });

  it("keeps settings changed after confirmation and rebases them after the receipt", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: setup.toISOString(),
    });
    await database.entitySyncState.put({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      serverVersion: 1,
      status: "clean",
      updatedAt: setup.toISOString(),
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const local = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    const sent = (await pendingIncomeConfirmation(database))!;

    await setSavingsGoal(
      { targetDateKey: "2026-12-31", targetMinor: 100_000 },
      database,
      new Date(2026, 7, 10, 9, 2),
    );
    const laterSettings = (await database.syncOutbox.get("settings:primary"))!;
    expect(laterSettings.id).not.toBe(sent.absorbedSettingsMutationId);

    await markPushResults([sent], [{
      id: sent.id,
      status: "applied",
      version: 2,
      incomeConfirmation: {
        confirmationId: sent.incomeConfirmation!.confirmationId,
        forecastId: local.entry!.id,
        actualIncomeMinor: 75_000,
        entryVersion: 1,
        entry: local.entry!,
      },
    }], database);

    expect(await database.syncOutbox.get("settings:primary")).toMatchObject({
      baseVersion: 2,
      payload: {
        initialBalanceMinor: 0,
        savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 100_000 },
      },
    });
    await expect(pendingIncomeConfirmation(database)).resolves.toBeUndefined();
  });

  it("keeps an edited confirmed income pending on top of the canonical entry", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: setup.toISOString(),
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const local = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    const sent = (await pendingIncomeConfirmation(database))!;
    const edited = await updateEntry(local.entry!.id, {
      kind: "income",
      amount: "700.00",
      note: "corrected income",
      occurredAtLocal: "2026-08-10T09:00",
    }, database, new Date(2026, 7, 10, 9, 1));
    const editMutation = (await database.syncOutbox.get(`entry:${edited.id}`))!;

    await markPushResults([sent], [{
      id: sent.id,
      status: "applied",
      version: 2,
      incomeConfirmation: {
        confirmationId: sent.incomeConfirmation!.confirmationId,
        forecastId: local.entry!.id,
        actualIncomeMinor: 75_000,
        entryVersion: 1,
        entry: local.entry!,
      },
    }], database);

    await expect(database.entries.get(edited.id)).resolves.toEqual(edited);
    expect(await database.syncOutbox.get(`entry:${edited.id}`)).toMatchObject({
      baseVersion: 1,
      payload: edited,
    });
    expect((await database.syncOutbox.get(`entry:${edited.id}`))?.id)
      .not.toBe(editMutation.id);
  });

  it("records an entry conflict when another confirmation wins over a local edit", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: setup.toISOString(),
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const local = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    const sent = (await pendingIncomeConfirmation(database))!;
    const edited = await updateEntry(local.entry!.id, {
      kind: "income",
      amount: "700.00",
      note: "local correction",
      occurredAtLocal: "2026-08-10T09:00",
    }, database, new Date(2026, 7, 10, 9, 1));
    const editMutation = (await database.syncOutbox.get(`entry:${edited.id}`))!;
    const remoteEntry = { ...local.entry!, amountMinor: 76_000, note: "remote income" };

    await markPushResults([sent], [{
      id: sent.id,
      status: "duplicate",
      version: 2,
      incomeConfirmation: {
        confirmationId: "remote-positive-confirmation",
        forecastId: local.entry!.id,
        actualIncomeMinor: 76_000,
        entryVersion: 1,
        entry: remoteEntry,
      },
    }], database);

    await expect(database.entries.get(edited.id)).resolves.toEqual(edited);
    await expect(database.syncOutbox.get(`entry:${edited.id}`)).resolves.toEqual(editMutation);
    await expect(database.syncConflicts.get(`entry:${edited.id}`)).resolves.toMatchObject({
      localPayload: edited,
      remotePayload: remoteEntry,
      remoteVersion: 1,
    });
  });

  it("records an entry conflict when the same confirmed income changed remotely first", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: setup.toISOString(),
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const local = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    const sent = (await pendingIncomeConfirmation(database))!;
    const edited = await updateEntry(local.entry!.id, {
      kind: "income",
      amount: "700.00",
      note: "local correction",
      occurredAtLocal: "2026-08-10T09:00",
    }, database, new Date(2026, 7, 10, 9, 1));
    const remoteEntry = {
      ...local.entry!,
      amountMinor: 72_000,
      note: "remote correction",
      updatedAt: "2026-08-10T01:02:00.000Z",
    };

    await markPushResults([sent], [{
      id: sent.id,
      status: "duplicate",
      version: 2,
      incomeConfirmation: {
        confirmationId: sent.incomeConfirmation!.confirmationId,
        forecastId: local.entry!.id,
        actualIncomeMinor: 75_000,
        entryVersion: 2,
        entry: remoteEntry,
      },
    }], database);

    await expect(database.syncConflicts.get(`entry:${edited.id}`)).resolves.toMatchObject({
      localPayload: edited,
      remotePayload: remoteEntry,
      remoteVersion: 2,
    });
  });

  it("lets another device's settings confirmation enter the normal conflict flow", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: setup.toISOString(),
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const local = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    const sent = (await pendingIncomeConfirmation(database))!;
    await setSavingsGoal(
      { targetDateKey: "2026-12-31", targetMinor: 100_000 },
      database,
      new Date(2026, 7, 10, 9, 1),
    );
    const pendingSettings = (await database.syncOutbox.get("settings:primary"))!;

    await markPushResults([sent], [{
      id: sent.id,
      status: "duplicate",
      version: 2,
      incomeConfirmation: {
        confirmationId: "remote-positive-confirmation",
        forecastId: local.entry!.id,
        actualIncomeMinor: 75_000,
        entryVersion: 1,
        entry: local.entry!,
      },
    }], database);
    await expect(database.syncOutbox.get("settings:primary")).resolves.toEqual(pendingSettings);

    const remoteSettings: AppSettings = {
      ...(await getSettings(database)),
      savingsGoal: { targetDateKey: "2027-06-30", targetMinor: 200_000 },
      lastExpectedIncomeMinor: 80_000,
      updatedAt: "2026-08-10T01:00:00.000Z",
    };
    delete remoteSettings.incomeForecast;
    await applyRemoteChanges([{
      seq: "1",
      entityType: "settings",
      entityId: "primary",
      version: 2,
      payload: remoteSettings,
    }], "1", database);

    await expect(database.syncConflicts.get("settings:primary")).resolves.toMatchObject({
      localPayload: { savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 100_000 } },
      remotePayload: { savingsGoal: { targetDateKey: "2027-06-30", targetMinor: 200_000 } },
      remoteVersion: 2,
    });
  });

  it("removes an edited provisional income when a zero confirmation won elsewhere", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: setup.toISOString(),
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const local = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    const sent = (await pendingIncomeConfirmation(database))!;
    await updateEntry(local.entry!.id, {
      kind: "income",
      amount: "700.00",
      note: "corrected income",
      occurredAtLocal: "2026-08-10T09:00",
    }, database, new Date(2026, 7, 10, 9, 1));

    await markPushResults([sent], [{
      id: sent.id,
      status: "duplicate",
      version: 2,
      incomeConfirmation: {
        confirmationId: "remote-zero-confirmation",
        forecastId: local.entry!.id,
        actualIncomeMinor: 0,
      },
    }], database);

    await expect(database.entries.get(local.entry!.id)).resolves.toBeUndefined();
    await expect(database.syncOutbox.get(`entry:${local.entry!.id}`)).resolves.toBeUndefined();
    await expect(database.entitySyncState.get(`entry:${local.entry!.id}`)).resolves.toBeUndefined();
  });

  it("removes the full provisional income graph when a zero confirmation wins", async () => {
    const setup = new Date(2026, 7, 9, 10);
    const nowIso = "2026-08-10T01:01:00.000Z";
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 7,
      uploadApproved: true,
      linkedAt: setup.toISOString(),
    });
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const local = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    const sent = (await pendingIncomeConfirmation(database))!;
    const blob = new Blob(["receipt"], { type: "image/jpeg" });
    const edited = await updateEntry(local.entry!.id, {
      kind: "expense",
      amount: "10.00",
      note: "temporary expense",
      occurredAtLocal: "2026-08-10T09:00",
      image: { blob, mimeType: blob.type, size: blob.size, width: 20, height: 10 },
    }, database, new Date(nowIso));
    const allocation: RecoveryAllocation = {
      id: "allocation-provisional",
      refundEntryId: "refund-entry",
      expenseEntryId: edited.id,
      amountMinor: 100,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const release: SavingsEvent = {
      id: "release-provisional",
      kind: "release",
      amountMinor: 100,
      note: "temporary release",
      occurredAt: nowIso,
      localDateKey: "2026-08-10",
      localMonthKey: "2026-08",
      timezoneOffsetMinutes: -480,
      linkedExpenseEntryId: edited.id,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await database.recoveryAllocations.put(allocation);
    await database.savingsEvents.put(release);
    for (const [entityType, entityId, payload] of [
      ["recoveryAllocation", allocation.id, allocation],
      ["savingsEvent", release.id, release],
    ] as const) {
      const key = `${entityType}:${entityId}`;
      await database.syncOutbox.put({
        entityKey: key,
        id: `mutation-${entityId}`,
        entityType,
        entityId,
        baseVersion: 0,
        payload,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      await database.entitySyncState.put({
        id: key,
        entityType,
        entityId,
        serverVersion: 0,
        status: "pending",
        updatedAt: nowIso,
      });
    }
    await database.syncConflicts.put({
      id: `recoveryAllocation:${allocation.id}`,
      entityType: "recoveryAllocation",
      entityId: allocation.id,
      localPayload: allocation,
      remotePayload: allocation,
      remoteVersion: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    await markPushResults([sent], [{
      id: sent.id,
      status: "duplicate",
      version: 2,
      incomeConfirmation: {
        confirmationId: "remote-zero-confirmation",
        forecastId: local.entry!.id,
        actualIncomeMinor: 0,
      },
    }], database);

    await expect(database.entries.get(edited.id)).resolves.toBeUndefined();
    await expect(database.attachments.get(edited.attachmentId!)).resolves.toBeUndefined();
    await expect(database.recoveryAllocations.get(allocation.id)).resolves.toBeUndefined();
    await expect(database.savingsEvents.get(release.id)).resolves.toBeUndefined();
    for (const key of [
      `entry:${edited.id}`,
      `recoveryAllocation:${allocation.id}`,
      `savingsEvent:${release.id}`,
    ]) {
      await expect(database.syncOutbox.get(key)).resolves.toBeUndefined();
      await expect(database.syncConflicts.get(key)).resolves.toBeUndefined();
      await expect(database.entitySyncState.get(key)).resolves.toBeUndefined();
    }
  });

  it("confirms zero income without creating a zero ledger entry", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 0,
    }, database, setup);
    const result = await recordActualIncome(0, database, new Date(2026, 7, 10, 9));
    expect(result.entry).toBeUndefined();
    expect((await getSettings(database)).incomeForecast).toBeUndefined();
    await expect(database.entries.count()).resolves.toBe(0);
  });

  it("reuses the confirmed ledger row when the same forecast is confirmed again", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    const planned = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const forecast = planned.incomeForecast!;

    const first = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    await database.settings.update("primary", { incomeForecast: forecast });
    const repeated = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 10));

    expect(repeated.entry?.id).toBe(first.entry?.id);
    expect(repeated.entry?.id).toBe(forecast.id);
    await expect(database.entries.count()).resolves.toBe(1);
    expect((await getSettings(database)).incomeForecast).toBeUndefined();
  });

  it("keeps the forecast when another device confirmed a different amount", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    const planned = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const forecast = planned.incomeForecast!;

    await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    await database.settings.update("primary", { incomeForecast: forecast });

    await expect(
      recordActualIncome(76_000, database, new Date(2026, 7, 10, 10)),
    ).rejects.toMatchObject({ code: "sync-conflict" });
    await expect(database.entries.count()).resolves.toBe(1);
    expect((await getSettings(database)).incomeForecast).toEqual(forecast);
  });
});
