import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateRetainedSavingsSummary } from "../domain/stats";
import type { EntryDraft, SavingsEvent } from "../domain/types";
import {
  INDEXED_DB_VERSION,
  LedgerDatabase,
  createDefaultSettings,
  createSavingsFundedExpense,
  getLedgerSummary,
  listActiveSavingsEvents,
  purgeDeletedSavingsEvent,
  recordActualIncome,
  recordActualIncomeWithSavings,
  releaseSavings,
  reserveSavings,
  setIncomeForecast,
  setInitialBalance,
  setOpeningSavings,
  setPayCyclePlan,
  setSavingsTargetOverride,
  settleSavingsCycle,
  softDeleteSavingsEvent,
  softDeleteEntry,
  undoDeleteEntry,
  updateEntry,
  updateSavingsEvent,
} from "./database";

function expenseDraft(amount = "12.00", occurredAtLocal = "2026-08-08T12:30"): EntryDraft {
  return {
    kind: "expense",
    amount,
    note: "funded purchase",
    occurredAtLocal,
  };
}

describe("savings data layer", () => {
  let database: LedgerDatabase;

  beforeEach(async () => {
    database = new LedgerDatabase(`jiyibi-savings-${crypto.randomUUID()}`);
    await database.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    database.close();
    await database.delete();
  });

  it("migrates v4 targets, outbox and conflicts without inventing savings history", async () => {
    database.close();
    await database.delete();
    const name = `jiyibi-v4-savings-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(4).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt, treatment, confirmationStatus",
      attachments: "id, entryId, createdAt",
      settings: "id",
      recoveryAllocations: "id, refundEntryId, expenseEntryId, deletedAt, createdAt",
      syncState: "id, accountId",
      entitySyncState: "id, [entityType+entityId], status",
      syncOutbox: "entityKey, &id, [entityType+entityId], createdAt",
      syncConflicts: "id, [entityType+entityId], createdAt",
    });
    await legacy.open();
    const positiveSettings = {
      ...createDefaultSettings(new Date("2026-08-01T00:00:00.000Z")),
      payCycle: { paydayDay: 10, cycleEndBalanceGoalMinor: 50_000 },
    };
    const negativeSettings = {
      ...positiveSettings,
      payCycle: { paydayDay: 10, cycleEndBalanceGoalMinor: -100 },
    };
    await legacy.table("settings").add(negativeSettings);
    await legacy.table("syncOutbox").add({
      entityKey: "settings:primary",
      id: "migration-1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 1,
      payload: positiveSettings,
      createdAt: positiveSettings.updatedAt,
      updatedAt: positiveSettings.updatedAt,
    });
    await legacy.table("syncConflicts").add({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      localPayload: positiveSettings,
      remotePayload: negativeSettings,
      remoteVersion: 2,
      createdAt: positiveSettings.updatedAt,
      updatedAt: positiveSettings.updatedAt,
    });
    legacy.close();

    const upgraded = new LedgerDatabase(name, new Date(2026, 7, 18, 12));
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(INDEXED_DB_VERSION);
      expect(await upgraded.settings.get("primary")).toMatchObject({
        payCycle: { paydayDay: 10 },
      });
      expect(await upgraded.settings.get("primary")).not.toHaveProperty(
        "payCycle.cycleEndBalanceGoalMinor",
      );
      expect(await upgraded.syncOutbox.get("settings:primary")).toMatchObject({
        payload: { payCycle: { paydayDay: 10 }, savingsGoalNeedsSetup: true },
      });
      expect(await upgraded.syncConflicts.get("settings:primary")).toMatchObject({
        localPayload: { payCycle: { paydayDay: 10 }, savingsGoalNeedsSetup: true },
        remotePayload: {
          payCycle: { paydayDay: 10 },
        },
      });
      await expect(upgraded.savingsEvents.count()).resolves.toBe(0);
    } finally {
      upgraded.close();
      await upgraded.delete();
      database = new LedgerDatabase(`jiyibi-savings-${crypto.randomUUID()}`);
      await database.open();
    }
  });

  it("sets opening savings and enforces reserve/release against available funds", async () => {
    await setInitialBalance(1_000, database);
    await expect(setOpeningSavings(1_001, database)).rejects.toMatchObject({
      code: "invalid-settings",
    });
    await setOpeningSavings(300, database, new Date(2026, 6, 1, 9));
    await reserveSavings({ amountMinor: 400, note: "extra" }, database);
    await expect(reserveSavings({ amountMinor: 301 }, database)).rejects.toMatchObject({
      code: "invalid-settings",
    });

    const balanceBeforeRelease = (await getLedgerSummary("2026-08", database)).balanceMinor;
    const retainedBeforeRelease = calculateRetainedSavingsSummary(
      await listActiveSavingsEvents(database),
    ).totalRetainedMinor;
    expect(balanceBeforeRelease).toBe(1_000);
    expect(retainedBeforeRelease).toBe(700n);
    expect(BigInt(balanceBeforeRelease) - retainedBeforeRelease).toBe(300n);

    await releaseSavings({ amountMinor: 200, note: "use" }, database);
    await expect(releaseSavings({ amountMinor: 501 }, database)).rejects.toMatchObject({
      code: "invalid-settings",
    });

    const summary = calculateRetainedSavingsSummary(await listActiveSavingsEvents(database));
    expect(summary.totalRetainedMinor).toBe(500n);
    const balanceAfterRelease = (await getLedgerSummary("2026-08", database)).balanceMinor;
    expect(balanceAfterRelease).toBe(1_000);
    expect(BigInt(balanceAfterRelease) - summary.totalRetainedMinor).toBe(500n);
    expect(await database.entries.count()).toBe(0);
  });

  it("edits and permanently clears a soft-deleted savings event", async () => {
    await setInitialBalance(1_000, database);
    await setOpeningSavings(300, database, new Date(2026, 6, 1, 9));
    const reserve = await reserveSavings({ amountMinor: 200, note: "first" }, database);
    const updated = await updateSavingsEvent(
      reserve.id,
      { amountMinor: 250, note: "corrected" },
      database,
    );
    expect(updated).toMatchObject({ amountMinor: 250, note: "corrected" });
    expect(calculateRetainedSavingsSummary(await listActiveSavingsEvents(database)).totalRetainedMinor)
      .toBe(550n);

    await softDeleteSavingsEvent(reserve.id, database);
    await purgeDeletedSavingsEvent(reserve.id, database);
    expect(await database.savingsEvents.get(reserve.id)).toBeUndefined();
  });

  it("keeps a savings-funded expense and its release linked through edit/delete/undo", async () => {
    await setInitialBalance(5_000, database);
    await setOpeningSavings(1_000, database, new Date(2026, 6, 1, 9));
    const result = await createSavingsFundedExpense(
      expenseDraft(),
      600,
      database,
      new Date(2026, 7, 8, 12, 30),
    );
    expect(result.entry).toMatchObject({ amountMinor: -1_200, treatment: "one_time_expense" });
    expect(result.savingsEvent).toMatchObject({
      kind: "release",
      linkedExpenseEntryId: result.entry.id,
      amountMinor: 600,
    });
    expect(calculateRetainedSavingsSummary(await listActiveSavingsEvents(database)).totalRetainedMinor)
      .toBe(400n);

    await expect(
      updateEntry(result.entry.id, expenseDraft("5.00"), database),
    ).rejects.toMatchObject({ code: "invalid-settings" });
    await updateEntry(
      result.entry.id,
      expenseDraft("10.00", "2026-08-09T08:00"),
      database,
    );
    expect(await database.savingsEvents.get(result.savingsEvent.id)).toMatchObject({
      localDateKey: "2026-08-09",
    });

    const deleted = await softDeleteEntry(result.entry.id, database, new Date("2026-08-10T00:00:00Z"));
    expect((await database.savingsEvents.get(result.savingsEvent.id))?.deletedAt).toBe(deleted.deletedAt);
    expect(calculateRetainedSavingsSummary(await listActiveSavingsEvents(database)).totalRetainedMinor)
      .toBe(1_000n);

    await undoDeleteEntry(result.entry.id, database, new Date("2026-08-10T00:00:01Z"));
    expect((await database.savingsEvents.get(result.savingsEvent.id))?.deletedAt).toBeUndefined();
    expect(calculateRetainedSavingsSummary(await listActiveSavingsEvents(database)).totalRetainedMinor)
      .toBe(400n);
  });

  it("limits all active releases linked to one expense as a combined amount", async () => {
    await setInitialBalance(10_000, database);
    await setOpeningSavings(3_000, database, new Date(2026, 6, 1, 9));
    const funded = await createSavingsFundedExpense(
      expenseDraft(),
      600,
      database,
      new Date(2026, 7, 8, 12, 30),
    );
    const second = await releaseSavings({
      amountMinor: 600,
      linkedExpenseEntryId: funded.entry.id,
    }, database, new Date(2026, 7, 8, 13));

    await expect(releaseSavings({
      amountMinor: 1,
      linkedExpenseEntryId: funded.entry.id,
    }, database, new Date(2026, 7, 8, 13, 1))).rejects.toMatchObject({
      code: "invalid-settings",
    });
    await expect(updateSavingsEvent(second.id, {
      amountMinor: 601,
      linkedExpenseEntryId: funded.entry.id,
    }, database, new Date(2026, 7, 8, 13, 2))).rejects.toMatchObject({
      code: "invalid-settings",
    });
    expect((await database.savingsEvents.get(second.id))?.amountMinor).toBe(600);

    await softDeleteSavingsEvent(
      funded.savingsEvent.id,
      database,
      new Date(2026, 7, 8, 13, 3),
    );
    const updated = await updateSavingsEvent(second.id, {
      amountMinor: 1_200,
      linkedExpenseEntryId: funded.entry.id,
    }, database, new Date(2026, 7, 8, 13, 4));
    expect(updated.amountMinor).toBe(1_200);
  });

  it("records actual income and clears its forecast without a settlement", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await setInitialBalance(1_000, database);
    await setOpeningSavings(100, database, new Date(2026, 6, 1, 9));
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 500,
    }, database, setup);

    const result = await recordActualIncome(
      500,
      database,
      new Date(2026, 7, 10, 14),
    );
    expect(result.entry?.amountMinor).toBe(500);
    expect(result.settlement).toBeUndefined();
    expect(result.settings.incomeForecast).toBeUndefined();
    expect(result.settings.savingsTargetOverride).toBeUndefined();
    expect((await getLedgerSummary("2026-08", database)).balanceMinor).toBe(1_500);
    expect(await database.savingsEvents.count()).toBe(1);
  });

  it("records zero income without a ledger row or a settlement", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 0,
    }, database, setup);

    const result = await recordActualIncome(
      0,
      database,
      new Date(2026, 7, 10, 14),
    );

    expect(result.entry).toBeUndefined();
    expect(result.settlement).toBeUndefined();
    expect(result.settings.incomeForecast).toBeUndefined();
    expect(await database.savingsEvents.count()).toBe(0);
  });

  it("rejects the retired income-and-savings operation", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 100,
    }, database, setup);

    await expect(recordActualIncomeWithSavings(
      100,
      101,
      database,
      new Date(2026, 7, 10, 14),
    )).rejects.toMatchObject({ code: "invalid-settings" });

    expect(await database.entries.count()).toBe(0);
    expect(await database.savingsEvents.count()).toBe(0);
    expect((await database.settings.get("primary"))?.incomeForecast).toBeDefined();
  });

  it("does not allow creating new legacy settlements", async () => {
    await setInitialBalance(1_000, database);
    await expect(settleSavingsCycle({
      cycleStartDateKey: "2026-07-10",
      cycleEndDateKey: "2026-08-09",
      goalMinorSnapshot: 300,
      amountMinor: 300,
      occurredAtLocal: "2026-08-10T09:00",
    }, database, new Date(2026, 7, 10, 9))).rejects.toMatchObject({
      code: "invalid-settings",
    });
    await expect(database.savingsEvents.count()).resolves.toBe(0);
  });

  it("keeps a migrated historical settlement in retained savings", async () => {
    await setInitialBalance(2_000, database);
    await setOpeningSavings(100, database, new Date(2026, 6, 1, 9));
    await reserveSavings({ amountMinor: 200 }, database, new Date(2026, 6, 20, 9));
    await reserveSavings({ amountMinor: 50 }, database, new Date(2026, 7, 10, 8));

    const settled: SavingsEvent = {
      id: "savings-settlement-2026-07-10",
      kind: "cycle_settlement",
      note: "legacy",
      cycleStartDateKey: "2026-07-10",
      cycleEndDateKey: "2026-08-09",
      goalMinorSnapshot: 500,
      amountMinor: 300,
      openingRetainedMinor: 100,
      closingRetainedMinor: 600,
      netGrowthMinor: 500,
      occurredAt: "2026-08-10T01:00:00.000Z",
      localDateKey: "2026-08-10",
      localMonthKey: "2026-08",
      timezoneOffsetMinutes: -480,
      createdAt: "2026-08-10T01:00:00.000Z",
      updatedAt: "2026-08-10T01:00:00.000Z",
    };
    await database.savingsEvents.put(settled);
    expect(calculateRetainedSavingsSummary(
      await listActiveSavingsEvents(database),
    ).totalRetainedMinor).toBe(650n);
  });

  it("rejects a legacy one-cycle target when income is postponed", async () => {
    const now = new Date(2026, 7, 9, 10);
    await setPayCyclePlan({ paydayDay: 10 }, database, now);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 500,
    }, database, now);
    await expect(setSavingsTargetOverride(450, database, now)).rejects.toMatchObject({
      code: "invalid-settings",
    });
    const postponed = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-15",
      expectedIncomeMinor: 500,
    }, database, now);
    expect(postponed.savingsTargetOverride).toBeUndefined();
    expect(postponed.incomeForecast?.targetPaydayDateKey).toBe("2026-08-15");
  });

  it("queues savings mutations without blocking the local event transaction", async () => {
    await setInitialBalance(1_000, database);
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 6,
      uploadApproved: true,
      linkedAt: "2026-08-01T00:00:00.000Z",
    });
    await database.syncOutbox.clear();
    const event = await setOpeningSavings(300, database, new Date(2026, 7, 1, 9));
    expect(await database.syncOutbox.get(`savingsEvent:${event?.id}`)).toMatchObject({
      entityType: "savingsEvent",
      entityId: event?.id,
      payload: { kind: "opening", amountMinor: 300 },
    });

    const put = vi.spyOn(database.syncOutbox, "put").mockRejectedValueOnce(new Error("quota"));
    await expect(reserveSavings({ amountMinor: 100 }, database)).rejects.toThrow("quota");
    put.mockRestore();
    expect(await database.savingsEvents.count()).toBe(1);
  });
});
