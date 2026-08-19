import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateExceptionPrompt } from "../domain/exception-prompt";
import type {
  AppSettings,
  EntryDraft,
  LedgerEntry,
  ProcessedImage,
  RecoveryAllocation,
} from "../domain/types";
import {
  API_SCHEMA_VERSION,
  SYNC_SCHEMA_VERSION,
  type SessionResponse,
  type SyncChange,
} from "../sync/contracts";
import {
  DATABASE_SCHEMA_VERSION,
  INDEXED_DB_VERSION,
  LedgerDatabase,
  applyRemoteChanges,
  assertSyncAccount,
  clearIncomeForecast,
  createDefaultSettings,
  createEntry,
  getAttachment,
  getLedgerSummary,
  getSettings,
  listActiveEntries,
  linkSyncAccount,
  markPushResults,
  purgeDeletedEntry,
  recordActualIncome,
  replaceLedgerData,
  resolveSyncConflict,
  setInitialBalance,
  setIncomeForecast,
  setMonthEndBalanceGoal,
  setPayCyclePlan,
  softDeleteEntry,
  softDeleteRecoveryAllocation,
  undoDeleteEntry,
  updateEntry,
  updateEntryTreatment,
  upsertRecoveryAllocation,
} from "./database";

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return {
    kind: "expense",
    amount: "12.34",
    note: "午餐",
    occurredAtLocal: "2026-07-30T12:30",
    ...overrides,
  };
}

function image(contents = "image"): ProcessedImage {
  const blob = new Blob([contents], { type: "image/jpeg" });
  return { blob, mimeType: blob.type, size: blob.size, width: 100, height: 80 };
}

function session(overrides: Partial<SessionResponse["cloud"]> = {}): SessionResponse {
  return {
    schemaVersion: API_SCHEMA_VERSION,
    user: { id: "account-1", email: "owner@example.test" },
    cloud: {
      syncStatus: "enabled",
      generation: 3,
      hasData: true,
      entryCount: 1,
      attachmentCount: 0,
      cursor: "3",
      ...overrides,
    },
  };
}

async function pendingIncomeConfirmation(database: LedgerDatabase) {
  return (await database.syncOutbox.toArray())
    .find((record) => record.incomeConfirmation !== undefined);
}

function remoteChange(entry: LedgerEntry, version: number, seq = String(version)): SyncChange {
  return {
    seq,
    entityType: "entry",
    entityId: entry.id,
    version,
    payload: entry,
  };
}

function recoveryChange(
  allocation: RecoveryAllocation,
  version: number,
  seq = String(version),
): SyncChange {
  return {
    seq,
    entityType: "recoveryAllocation",
    entityId: allocation.id,
    version,
    payload: allocation,
  };
}

describe("LedgerDatabase", () => {
  let database: LedgerDatabase;

  beforeEach(async () => {
    database = new LedgerDatabase(`jiyibi-test-${crypto.randomUUID()}`);
    await database.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    database.close();
    await database.delete();
  });

  it("creates the initial CNY/zero settings", async () => {
    const settings = await getSettings(database);
    expect(settings).toMatchObject({
      id: "primary",
      currency: "CNY",
      initialBalanceMinor: 0,
      schemaVersion: 1,
    });
    expect(settings).not.toHaveProperty("monthEndBalanceGoalMinor");
    expect(settings).not.toHaveProperty("payCycle");
  });

  it("saves and clears a payday without changing independent settings", async () => {
    await setInitialBalance(1_234, database);
    await setMonthEndBalanceGoal(50_000, database);
    const plan = { paydayDay: 10 };

    const saved = await setPayCyclePlan(plan, database, new Date("2026-08-10T02:00:00.000Z"));
    expect(saved).toMatchObject({
      initialBalanceMinor: 1_234,
      payCycle: { paydayDay: 10 },
    });
    expect(saved).not.toHaveProperty("monthEndBalanceGoalMinor");

    const forecast = await setIncomeForecast({
      targetPaydayDateKey: "2026-09-10",
      expectedIncomeMinor: 800_000,
    }, database, new Date(2026, 7, 10, 10));
    await setInitialBalance(-2_500, database);
    expect(await getSettings(database)).toMatchObject({
      initialBalanceMinor: -2_500,
      payCycle: { paydayDay: 10 },
      incomeForecast: forecast.incomeForecast,
    });

    await setPayCyclePlan(plan, database);
    expect((await getSettings(database)).incomeForecast).toEqual(forecast.incomeForecast);

    const cleared = await setPayCyclePlan(undefined, database);
    expect(cleared).not.toHaveProperty("payCycle");
    expect(cleared).not.toHaveProperty("incomeForecast");
    expect(cleared).not.toHaveProperty("monthEndBalanceGoalMinor");
  });

  it.each([
    { paydayDay: 0 },
    { paydayDay: 32 },
    { paydayDay: 10.5 },
  ])("rejects an incomplete or invalid pay-cycle plan: %o", async (invalidPlan) => {
    const before = await getSettings(database);
    await expect(setPayCyclePlan(invalidPlan, database)).rejects.toMatchObject({
      code: "invalid-settings",
    });
    await expect(getSettings(database)).resolves.toEqual(before);
  });

  it("saves a delayed income forecast in its payday window and preserves its id while editing", async () => {
    const now = new Date(2026, 7, 9, 10, 30);
    await setPayCyclePlan({
      paydayDay: 10,
    }, database, now);

    const saved = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-15",
      expectedIncomeMinor: 800_000,
    }, database, now);
    expect(saved.incomeForecast).toMatchObject({
      id: expect.any(String),
      targetPaydayDateKey: "2026-08-15",
      expectedIncomeMinor: 800_000,
    });

    const edited = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-20",
      expectedIncomeMinor: 850_000,
    }, database, now);
    expect(edited.incomeForecast?.id).toBe(saved.incomeForecast?.id);
    expect(edited.incomeForecast?.expectedIncomeMinor).toBe(850_000);
    expect(edited.lastExpectedIncomeMinor).toBe(850_000);

    const cleared = await clearIncomeForecast(database, now);
    expect(cleared).not.toHaveProperty("incomeForecast");
  });

  it.each([
    {
      targetPaydayDateKey: "2026-02-30",
      expectedIncomeMinor: 2,
    },
    {
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: -1,
    },
    {
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 1.5,
    },
    {
      id: "forecast with spaces",
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 2,
    },
    {
      id: "f".repeat(129),
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 2,
    },
  ])("rejects an invalid income forecast: %o", async (invalidForecast) => {
    const now = new Date(2026, 7, 9, 10, 30);
    await setPayCyclePlan({
      paydayDay: 10,
    }, database, now);
    const before = await getSettings(database);

    await expect(
      setIncomeForecast(invalidForecast, database, now),
    ).rejects.toMatchObject({ code: "invalid-settings" });
    await expect(getSettings(database)).resolves.toEqual(before);
  });

  it("enforces the start and exclusive end of a new forecast payday window", async () => {
    const now = new Date(2026, 7, 1, 10, 30);
    await setPayCyclePlan({
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 100_000,
    }, database, now);

    await expect(setIncomeForecast({
      targetPaydayDateKey: "2026-07-31",
      minimumIncomeMinor: 100,
      expectedIncomeMinor: 200,
    }, database, now)).rejects.toMatchObject({ code: "invalid-settings" });

    const start = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 100,
      expectedIncomeMinor: 200,
    }, database, now);
    const end = await setIncomeForecast({
      targetPaydayDateKey: "2026-09-09",
      minimumIncomeMinor: 150,
      expectedIncomeMinor: 250,
    }, database, now);
    expect(end.incomeForecast?.id).toBe(start.incomeForecast?.id);

    await expect(setIncomeForecast({
      targetPaydayDateKey: "2026-09-10",
      minimumIncomeMinor: 150,
      expectedIncomeMinor: 250,
    }, database, now)).rejects.toMatchObject({ code: "invalid-settings" });
    expect((await getSettings(database)).incomeForecast).toEqual(end.incomeForecast);
  });

  it("allows an overdue forecast to move to today or later within its original window", async () => {
    const setupNow = new Date(2026, 7, 9, 10, 30);
    await setPayCyclePlan({
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 100_000,
    }, database, setupNow);
    const saved = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 500_000,
      expectedIncomeMinor: 800_000,
    }, database, setupNow);
    const overdueNow = new Date(2026, 7, 12, 8);

    await expect(setIncomeForecast({
      targetPaydayDateKey: "2026-08-11",
      minimumIncomeMinor: 500_000,
      expectedIncomeMinor: 800_000,
    }, database, overdueNow)).rejects.toMatchObject({ code: "invalid-settings" });

    const postponed = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-12",
      minimumIncomeMinor: 550_000,
      expectedIncomeMinor: 850_000,
    }, database, overdueNow);
    expect(postponed.incomeForecast).toMatchObject({
      id: saved.incomeForecast?.id,
      targetPaydayDateKey: "2026-08-12",
    });

    const later = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-20",
      minimumIncomeMinor: 550_000,
      expectedIncomeMinor: 850_000,
    }, database, overdueNow);
    expect(later.incomeForecast?.id).toBe(saved.incomeForecast?.id);

    await expect(setIncomeForecast({
      targetPaydayDateKey: "2026-09-10",
      minimumIncomeMinor: 550_000,
      expectedIncomeMinor: 850_000,
    }, database, overdueNow)).rejects.toMatchObject({ code: "invalid-settings" });
  });

  it("accepts the following cycle after the current payday was confirmed", async () => {
    const setupNow = new Date(2026, 7, 9, 10, 30);
    await setPayCyclePlan({
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 0,
    }, database, setupNow);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 500_000,
      expectedIncomeMinor: 800_000,
    }, database, setupNow);
    const paydayNow = new Date(2026, 7, 10, 12);
    await recordActualIncome(800_000, database, paydayNow);

    const next = await setIncomeForecast({
      targetPaydayDateKey: "2026-09-10",
      minimumIncomeMinor: 500_000,
      expectedIncomeMinor: 800_000,
    }, database, paydayNow);
    expect(next.incomeForecast?.targetPaydayDateKey).toBe("2026-09-10");
  });

  it("allows a newly reported delay after the regular payday has passed", async () => {
    const now = new Date(2026, 7, 12, 10, 30);
    await setPayCyclePlan({
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 0,
    }, database, now);

    const delayed = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-15",
      minimumIncomeMinor: 500_000,
      expectedIncomeMinor: 800_000,
    }, database, now);

    expect(delayed.incomeForecast?.targetPaydayDateKey).toBe("2026-08-15");
  });

  it("allows a short-month payday delay to cross into the next month", async () => {
    const now = new Date(2026, 2, 1, 10, 30);
    await setPayCyclePlan({
      paydayDay: 31,
      cycleEndBalanceGoalMinor: 0,
    }, database, now);

    const delayed = await setIncomeForecast({
      targetPaydayDateKey: "2026-03-02",
      minimumIncomeMinor: 500_000,
      expectedIncomeMinor: 800_000,
    }, database, now);

    expect(delayed.incomeForecast?.targetPaydayDateKey).toBe("2026-03-02");
  });

  it("records a due actual income and clears its forecast atomically", async () => {
    const forecastNow = new Date(2026, 7, 9, 10, 30);
    await setPayCyclePlan({
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 100_000,
    }, database, forecastNow);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 500_000,
      expectedIncomeMinor: 800_000,
    }, database, forecastNow);
    await linkSyncAccount(session(), true, database);
    await database.syncOutbox.clear();

    const result = await recordActualIncome(
      765_432,
      database,
      new Date(2026, 7, 10, 14, 35),
    );
    expect(result.entry).toMatchObject({
      amountMinor: 765_432,
      note: "本次实际收入",
      localDateKey: "2026-08-10",
      localMonthKey: "2026-08",
    });
    expect(result.settings).not.toHaveProperty("incomeForecast");
    expect(await database.entries.toArray()).toEqual([result.entry]);
    expect(await database.syncOutbox.get(`entry:${result.entry?.id}`)).toBeUndefined();
    expect(await database.syncOutbox.get("settings:primary")).toMatchObject({
      clearIncomeForecast: true,
    });
    expect(await pendingIncomeConfirmation(database)).toMatchObject({
      entityKey: `incomeConfirmation:${result.entry?.id}`,
      incomeConfirmation: {
        forecastId: result.entry?.id,
        targetPaydayDateKey: "2026-08-10",
        expectedIncomeMinor: 800_000,
        actualIncomeMinor: 765_432,
        entry: { id: result.entry?.id, amountMinor: 765_432 },
      },
    });

    await expect(
      recordActualIncome(765_432, database, new Date(2026, 7, 10, 14, 36)),
    ).rejects.toMatchObject({ code: "invalid-settings" });
    expect(await database.entries.count()).toBe(1);
  });

  it("allows a zero actual income without creating a zero-value entry", async () => {
    const forecastNow = new Date(2026, 7, 9, 10, 30);
    await setPayCyclePlan({ paydayDay: 10, cycleEndBalanceGoalMinor: 0 }, database, forecastNow);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 0,
      expectedIncomeMinor: 0,
    }, database, forecastNow);
    await linkSyncAccount(session(), true, database);
    await database.syncOutbox.clear();

    const result = await recordActualIncome(0, database, new Date(2026, 7, 10, 9));
    expect(result.entry).toBeUndefined();
    expect(result.settings).not.toHaveProperty("incomeForecast");
    expect(await database.entries.count()).toBe(0);
    expect(await database.syncOutbox.get("settings:primary")).toMatchObject({
      clearIncomeForecast: true,
    });
    expect(await pendingIncomeConfirmation(database)).toMatchObject({
      incomeConfirmation: {
        forecastId: expect.any(String),
        expectedIncomeMinor: 0,
        actualIncomeMinor: 0,
      },
    });
    expect((await pendingIncomeConfirmation(database))?.incomeConfirmation)
      .not.toHaveProperty("entry");
  });

  it("rolls back the actual income entry when its sync mutation cannot be queued", async () => {
    const forecastNow = new Date(2026, 7, 9, 10, 30);
    await setPayCyclePlan({ paydayDay: 10, cycleEndBalanceGoalMinor: 0 }, database, forecastNow);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 100,
      expectedIncomeMinor: 200,
    }, database, forecastNow);
    await linkSyncAccount(session(), true, database);
    await database.syncOutbox.clear();
    const put = vi.spyOn(database.syncOutbox, "put").mockRejectedValueOnce(new Error("quota"));

    await expect(
      recordActualIncome(150, database, new Date(2026, 7, 10, 9)),
    ).rejects.toThrow("quota");
    expect(await database.entries.count()).toBe(0);
    expect((await getSettings(database)).incomeForecast).toBeDefined();
    put.mockRestore();
  });

  it("saves and clears the month-end goal without overwriting the initial balance", async () => {
    await setInitialBalance(1_234, database, new Date("2026-08-10T01:00:00.000Z"));

    await expect(
      setMonthEndBalanceGoal(50_000, database, new Date("2026-08-10T02:00:00.000Z")),
    ).resolves.toMatchObject({
      initialBalanceMinor: 1_234,
      monthEndBalanceGoalMinor: 50_000,
      updatedAt: "2026-08-10T02:00:00.000Z",
    });

    await expect(
      setInitialBalance(-2_500, database, new Date("2026-08-10T03:00:00.000Z")),
    ).resolves.toMatchObject({
      initialBalanceMinor: -2_500,
      monthEndBalanceGoalMinor: 50_000,
    });

    const cleared = await setMonthEndBalanceGoal(
      undefined,
      database,
      new Date("2026-08-10T04:00:00.000Z"),
    );
    expect(cleared).toMatchObject({
      initialBalanceMinor: -2_500,
      updatedAt: "2026-08-10T04:00:00.000Z",
    });
    expect(cleared).not.toHaveProperty("monthEndBalanceGoalMinor");
    expect(await getSettings(database)).not.toHaveProperty("monthEndBalanceGoalMinor");
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 9_000_000_000_000_001])(
    "rejects an invalid month-end goal without changing settings: %s",
    async (invalidGoal) => {
      await setInitialBalance(1_234, database);
      await setMonthEndBalanceGoal(-5_000, database);
      const before = await getSettings(database);

      await expect(
        setMonthEndBalanceGoal(invalidGoal, database),
      ).rejects.toMatchObject({ code: "invalid-settings" });
      await expect(getSettings(database)).resolves.toEqual(before);
    },
  );

  it("stamps the persisted revision when a treatment prompt is handled", async () => {
    const created = await createEntry(draft({ amount: "800.00" }), database);
    const promptedAt = new Date("2026-07-30T13:00:00.000Z");

    const pending = await updateEntryTreatment(created.id, "ordinary_expense", {
      confirmationStatus: "pending",
      detectionRuleVersion: 1,
      markPrompted: true,
    }, database, promptedAt);

    expect(pending).toMatchObject({
      confirmationStatus: "pending",
      detectionRuleVersion: 1,
      promptedRevision: promptedAt.toISOString(),
      updatedAt: promptedAt.toISOString(),
    });
    expect(await database.entries.get(created.id)).toEqual(pending);
  });

  it("keeps prompt metadata across note-only edits and clears it after material edits", async () => {
    const created = await createEntry(draft({ amount: "800.00" }), database);
    const prompted = await updateEntryTreatment(created.id, "ordinary_expense", {
      confirmationStatus: "pending",
      detectionRuleVersion: 1,
      markPrompted: true,
    }, database, new Date("2026-07-30T13:00:00.000Z"));

    const noteOnly = await updateEntry(
      created.id,
      draft({ amount: "800.00", note: "只改备注" }),
      database,
      new Date("2026-07-30T13:01:00.000Z"),
    );
    expect(noteOnly.confirmationStatus).toBe("pending");
    expect(noteOnly.promptedRevision).toBe(noteOnly.updatedAt);
    expect(noteOnly.promptedRevision).not.toBe(prompted.promptedRevision);
    expect(evaluateExceptionPrompt(noteOnly, [noteOnly], undefined).shouldPrompt).toBe(false);

    const amountChanged = await updateEntry(
      created.id,
      draft({ amount: "900.00", note: "只改备注" }),
      database,
      new Date("2026-07-30T13:02:00.000Z"),
    );
    expect(amountChanged.confirmationStatus).toBe("not_needed");
    expect(amountChanged.promptedRevision).toBeUndefined();
    expect(evaluateExceptionPrompt(amountChanged, [amountChanged], undefined).shouldPrompt).toBe(true);
  });

  it("creates, edits and summarizes signed entries", async () => {
    const created = await createEntry(draft(), database);
    expect(created.amountMinor).toBe(-1234);

    await setInitialBalance(5_000, database);
    await updateEntry(created.id, draft({ kind: "income", amount: "20", note: "退款" }), database);

    expect(await listActiveEntries(database)).toHaveLength(1);
    await expect(getLedgerSummary("2026-07", database)).resolves.toEqual({
      balanceMinor: 7_000,
      monthIncomeMinor: 2_000,
      monthExpenseMinor: 0,
    });
  });

  it("keeps an attachment during undo and removes it only after purge", async () => {
    const created = await createEntry(draft({ note: "", image: image() }), database);
    expect(created.attachmentId).toBeTruthy();
    const attachmentId = created.attachmentId!;

    await softDeleteEntry(created.id, database, new Date("2026-07-30T12:31:00.000Z"));
    expect(await listActiveEntries(database)).toEqual([]);
    expect(await getAttachment(attachmentId, database)).toBeDefined();

    await undoDeleteEntry(created.id, database);
    expect(await listActiveEntries(database)).toHaveLength(1);
    await softDeleteEntry(created.id, database);
    await purgeDeletedEntry(created.id, database);
    expect(await database.entries.get(created.id)).toBeUndefined();
    expect(await getAttachment(attachmentId, database)).toBeUndefined();
  });

  it("replaces and removes screenshots transactionally during edit", async () => {
    const created = await createEntry(draft({ image: image("old") }), database);
    const oldAttachmentId = created.attachmentId!;
    const updated = await updateEntry(created.id, draft({ image: image("new") }), database);

    expect(updated.attachmentId).not.toBe(oldAttachmentId);
    expect(await getAttachment(oldAttachmentId, database)).toBeUndefined();
    expect(await getAttachment(updated.attachmentId!, database)).toBeDefined();

    const withoutImage = await updateEntry(
      created.id,
      draft({ image: undefined, removeExistingImage: true }),
      database,
    );
    expect(withoutImage.attachmentId).toBeUndefined();
    expect(await database.attachments.count()).toBe(0);
  });

  it("refuses to edit or purge a cross-owned attachment", async () => {
    const owner = await createEntry(draft({ image: image("owned") }), database);
    const borrower = await createEntry(draft({ note: "borrower" }), database);
    await database.entries.update(borrower.id, { attachmentId: owner.attachmentId });

    await expect(updateEntry(owner.id, draft({ note: "owner edited" }), database)).rejects.toMatchObject({
      code: "attachment-mismatch",
    });
    await softDeleteEntry(borrower.id, database);
    await expect(purgeDeletedEntry(borrower.id, database)).rejects.toMatchObject({
      code: "attachment-mismatch",
    });
    expect(await getAttachment(owner.attachmentId!, database)).toBeDefined();
  });

  it("rolls back settings, entries and attachments when replacement fails", async () => {
    const original = await createEntry(draft({ image: image("original") }), database);
    await setInitialBalance(5_000, database);
    const originalAttachment = await getAttachment(original.attachmentId!, database);
    const replacementEntry: LedgerEntry = {
      ...original,
      id: "replacement-entry",
      attachmentId: "replacement-attachment",
    };
    const replacementAttachment = {
      ...originalAttachment!,
      id: "replacement-attachment",
      entryId: replacementEntry.id,
    };
    const settings = {
      ...createDefaultSettings(),
      initialBalanceMinor: -500,
    };

    await expect(
      replaceLedgerData({
        settings,
        entries: [replacementEntry],
        attachments: [replacementAttachment, replacementAttachment],
        recoveryAllocations: [],
      }, database),
    ).rejects.toBeDefined();
    await expect(database.entries.toArray()).resolves.toEqual([original]);
    expect((await getSettings(database)).initialBalanceMinor).toBe(5_000);
    await expect(database.attachments.toArray()).resolves.toEqual([originalAttachment]);
  });

  it("upgrades a v1 ledger without changing the backup schema or losing data", async () => {
    const name = `jiyibi-v1-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt",
      attachments: "id, entryId, createdAt",
      settings: "id",
    });
    await legacy.open();
    const entry = {
      id: "legacy-entry",
      amountMinor: 100,
      note: "legacy",
      occurredAt: "2026-07-30T12:30:00.000Z",
      localDateKey: "2026-07-30",
      localMonthKey: "2026-07",
      timezoneOffsetMinutes: 0,
      createdAt: "2026-07-30T12:30:00.000Z",
      updatedAt: "2026-07-30T12:30:00.000Z",
    };
    await legacy.table("entries").add(entry);
    await legacy.table("settings").add({
      ...createDefaultSettings(new Date("2026-07-30T12:30:00.000Z")),
      initialBalanceMinor: 4321,
    });
    legacy.close();

    const upgraded = new LedgerDatabase(name);
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(INDEXED_DB_VERSION);
      expect(DATABASE_SCHEMA_VERSION).toBe(1);
      await expect(upgraded.entries.get(entry.id)).resolves.toEqual({
        ...entry,
        treatment: "ordinary_income",
        confirmationStatus: "not_needed",
      });
      expect((await getSettings(upgraded)).initialBalanceMinor).toBe(4321);
      await expect(upgraded.syncOutbox.count()).resolves.toBe(0);
    } finally {
      upgraded.close();
      await upgraded.delete();
    }
  });

  it("upgrades v2 settings, outbox payloads and conflict snapshots to income forecasts", async () => {
    const name = `jiyibi-v2-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt",
      attachments: "id, entryId, createdAt",
      settings: "id",
    });
    legacy.version(2).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt",
      attachments: "id, entryId, createdAt",
      settings: "id",
      syncState: "id, accountId",
      entitySyncState: "id, [entityType+entityId], status",
      syncOutbox: "entityKey, &id, [entityType+entityId], createdAt",
      syncConflicts: "id, [entityType+entityId], createdAt",
    });
    await legacy.open();
    const legacySettings = {
      ...createDefaultSettings(new Date("2026-08-01T00:00:00.000Z")),
      payCycle: {
        paydayDay: 31,
        monthlySalaryMinor: 800_000,
        cycleEndBalanceGoalMinor: 100_000,
      },
    };
    const remoteSettings = {
      ...legacySettings,
      payCycle: { ...legacySettings.payCycle, monthlySalaryMinor: 900_000 },
    };
    await legacy.table("settings").add(legacySettings);
    await legacy.table("syncOutbox").add({
      entityKey: "settings:primary",
      id: "legacy-mutation",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 2,
      payload: legacySettings,
      clearPayCycle: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    await legacy.table("syncConflicts").add({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      localPayload: legacySettings,
      remotePayload: remoteSettings,
      remoteVersion: 3,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    legacy.close();

    const upgraded = new LedgerDatabase(name, new Date(2026, 7, 30, 12));
    try {
      await upgraded.open();
      expect(await upgraded.settings.get("primary")).toMatchObject({
        payCycle: { paydayDay: 31 },
        savingsGoalNeedsSetup: true,
        lastExpectedIncomeMinor: 800_000,
        incomeForecast: {
          id: "legacy-income-2026-08-31",
          targetPaydayDateKey: "2026-08-31",
          expectedIncomeMinor: 800_000,
        },
      });
      const outbox = await upgraded.syncOutbox.get("settings:primary");
      expect(outbox).toMatchObject({
        clearIncomeForecast: true,
        payload: {
          payCycle: { paydayDay: 31 },
          savingsGoalNeedsSetup: true,
          incomeForecast: { expectedIncomeMinor: 800_000 },
        },
      });
      expect(outbox?.payload).not.toHaveProperty("payCycle.monthlySalaryMinor");
      const conflict = await upgraded.syncConflicts.get("settings:primary");
      expect(conflict?.localPayload).toMatchObject({
        incomeForecast: { expectedIncomeMinor: 800_000 },
      });
      expect(conflict?.remotePayload).toMatchObject({
        incomeForecast: { expectedIncomeMinor: 900_000 },
      });
    } finally {
      upgraded.close();
      await upgraded.delete();
    }
  });

  it("atomically coalesces local edits while preserving their original base version", async () => {
    await linkSyncAccount(session(), true, database);
    const created = await createEntry(draft(), database);
    const first = await database.syncOutbox.get(`entry:${created.id}`);
    expect(first).toMatchObject({ baseVersion: 0, payload: { id: created.id } });

    await updateEntry(created.id, draft({ note: "edited" }), database);
    const edited = await database.syncOutbox.get(`entry:${created.id}`);
    expect(await database.syncOutbox.count()).toBe(1);
    expect(edited?.id).not.toBe(first?.id);
    expect(edited?.baseVersion).toBe(0);
    expect((edited?.payload as LedgerEntry).note).toBe("edited");

    const put = vi.spyOn(database.syncOutbox, "put").mockRejectedValueOnce(new Error("quota"));
    await expect(createEntry(draft({ note: "must roll back" }), database)).rejects.toThrow("quota");
    expect(await database.entries.count()).toBe(1);
    put.mockRestore();
  });

  it("keeps an explicit goal-clear intent while coalescing settings edits", async () => {
    await linkSyncAccount(session(), true, database);
    expect((await database.syncState.get("primary"))?.syncProtocolVersion).toBe(
      SYNC_SCHEMA_VERSION,
    );

    await setMonthEndBalanceGoal(50_000, database);
    expect(await database.syncOutbox.get("settings:primary")).not.toHaveProperty(
      "clearMonthEndBalanceGoal",
    );

    await setMonthEndBalanceGoal(undefined, database);
    await setInitialBalance(1_234, database);
    const cleared = await database.syncOutbox.get("settings:primary");
    expect(cleared?.clearMonthEndBalanceGoal).toBe(true);
    expect(cleared?.payload).not.toHaveProperty("monthEndBalanceGoalMinor");

    await setMonthEndBalanceGoal(-25_000, database);
    const reset = await database.syncOutbox.get("settings:primary");
    expect(reset).not.toHaveProperty("clearMonthEndBalanceGoal");
    expect(reset?.payload).toHaveProperty("monthEndBalanceGoalMinor", -25_000);
  });

  it("keeps an explicit pay-cycle clear while coalescing later settings edits", async () => {
    await linkSyncAccount(session(), true, database);
    const plan = { paydayDay: 10 };

    await setPayCyclePlan(plan, database);
    expect(await database.syncOutbox.get("settings:primary")).not.toHaveProperty(
      "clearPayCycle",
    );

    await setPayCyclePlan(undefined, database);
    await setInitialBalance(1_234, database);
    const cleared = await database.syncOutbox.get("settings:primary");
    expect(cleared?.clearPayCycle).toBe(true);
    expect(cleared?.payload).not.toHaveProperty("payCycle");

    await setPayCyclePlan(plan, database);
    const reset = await database.syncOutbox.get("settings:primary");
    expect(reset).not.toHaveProperty("clearPayCycle");
    expect(reset?.payload).toHaveProperty("payCycle", {
      paydayDay: 10,
    });
  });

  it("keeps an explicit income-forecast clear while coalescing later settings edits", async () => {
    const now = new Date(2026, 7, 9, 10);
    await setPayCyclePlan({ paydayDay: 10, cycleEndBalanceGoalMinor: 0 }, database, now);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 100,
      expectedIncomeMinor: 200,
    }, database, now);
    await linkSyncAccount(session(), true, database);
    await database.syncOutbox.clear();

    await clearIncomeForecast(database, now);
    await setInitialBalance(1_234, database, now);
    const cleared = await database.syncOutbox.get("settings:primary");
    expect(cleared?.clearIncomeForecast).toBe(true);
    expect(cleared?.payload).not.toHaveProperty("incomeForecast");

    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 150,
      expectedIncomeMinor: 250,
    }, database, now);
    const reset = await database.syncOutbox.get("settings:primary");
    expect(reset).not.toHaveProperty("clearIncomeForecast");
    expect(reset?.payload).toHaveProperty("incomeForecast.expectedIncomeMinor", 250);
  });

  it("queues recovery allocations and their tombstones atomically", async () => {
    const expense = await createEntry(draft({ amount: "20.00" }), database);
    const refund = await createEntry(draft({ kind: "income", amount: "10.00" }), database);
    await updateEntryTreatment(expense.id, "reimbursable_expense", {}, database);
    await updateEntryTreatment(refund.id, "refund_reimbursement", {}, database);
    await linkSyncAccount(session(), true, database);
    await database.syncOutbox.clear();

    const allocation = await upsertRecoveryAllocation({
      refundEntryId: refund.id,
      expenseEntryId: expense.id,
      amountMinor: 500,
    }, database, new Date("2026-07-30T13:00:00.000Z"));
    expect(await database.syncOutbox.get(`recoveryAllocation:${allocation.id}`)).toMatchObject({
      entityType: "recoveryAllocation",
      baseVersion: 0,
      payload: allocation,
    });

    await softDeleteRecoveryAllocation(
      allocation.id,
      database,
      new Date("2026-07-30T14:00:00.000Z"),
    );
    expect(await database.syncOutbox.get(`recoveryAllocation:${allocation.id}`)).toMatchObject({
      entityType: "recoveryAllocation",
      baseVersion: 0,
      payload: {
        id: allocation.id,
        deletedAt: "2026-07-30T14:00:00.000Z",
        updatedAt: "2026-07-30T14:00:00.000Z",
      },
    });
  });

  it("syncs allocation tombstones when deleting and undoing a related entry", async () => {
    const expense = await createEntry(draft({ amount: "20.00" }), database);
    const refund = await createEntry(draft({ kind: "income", amount: "10.00" }), database);
    await updateEntryTreatment(expense.id, "reimbursable_expense", {}, database);
    await updateEntryTreatment(refund.id, "refund_reimbursement", {}, database);
    const allocation = await upsertRecoveryAllocation({
      refundEntryId: refund.id,
      expenseEntryId: expense.id,
      amountMinor: 500,
    }, database);
    await linkSyncAccount(session(), true, database);
    await database.syncOutbox.clear();
    const deletedAt = new Date("2026-07-30T14:00:00.000Z");

    await softDeleteEntry(expense.id, database, deletedAt);
    expect(await database.recoveryAllocations.get(allocation.id)).toMatchObject({
      deletedAt: deletedAt.toISOString(),
    });
    expect(await database.syncOutbox.get(`recoveryAllocation:${allocation.id}`)).toMatchObject({
      entityType: "recoveryAllocation",
      payload: { deletedAt: deletedAt.toISOString() },
    });

    await undoDeleteEntry(
      expense.id,
      database,
      new Date("2026-07-30T14:01:00.000Z"),
    );
    expect(await database.recoveryAllocations.get(allocation.id)).not.toHaveProperty("deletedAt");
    expect(await database.syncOutbox.get(`recoveryAllocation:${allocation.id}`)).toMatchObject({
      entityType: "recoveryAllocation",
      payload: { id: allocation.id, amountMinor: 500 },
    });
    expect(
      (await database.syncOutbox.get(`recoveryAllocation:${allocation.id}`))?.payload,
    ).not.toHaveProperty("deletedAt");
  });

  it("applies and resolves recovery allocation conflicts", async () => {
    await linkSyncAccount(session(), true, database);
    const local: RecoveryAllocation = {
      id: "recovery-conflict",
      refundEntryId: "refund-local",
      expenseEntryId: "expense-local",
      amountMinor: 400,
      createdAt: "2026-07-30T12:00:00.000Z",
      updatedAt: "2026-07-30T12:00:00.000Z",
    };
    await database.recoveryAllocations.put(local);
    await database.syncOutbox.put({
      entityKey: `recoveryAllocation:${local.id}`,
      id: "mutation-recovery-conflict",
      entityType: "recoveryAllocation",
      entityId: local.id,
      baseVersion: 1,
      payload: local,
      createdAt: local.createdAt,
      updatedAt: local.updatedAt,
    });
    const sent = (await database.syncOutbox.get(`recoveryAllocation:${local.id}`))!;
    const remote = {
      ...local,
      amountMinor: 500,
      updatedAt: "2026-07-30T13:00:00.000Z",
    };

    await markPushResults([sent], [{
      id: sent.id,
      status: "conflict",
      remote: recoveryChange(remote, 2),
    }], database);
    expect(await database.syncConflicts.get(`recoveryAllocation:${local.id}`)).toBeDefined();

    await resolveSyncConflict("recoveryAllocation", local.id, "use-cloud", database);
    expect(await database.recoveryAllocations.get(local.id)).toEqual(remote);
    expect(await database.syncOutbox.get(`recoveryAllocation:${local.id}`)).toBeUndefined();
  });

  it("keeps a durable deletion outbox after the local entry and attachment are purged", async () => {
    await linkSyncAccount(session(), true, database);
    const created = await createEntry(draft({ note: "", image: image() }), database);
    await softDeleteEntry(created.id, database);
    const tombstone = await database.syncOutbox.get(`entry:${created.id}`);
    expect(tombstone?.payload).toMatchObject({ id: created.id, deletedAt: expect.any(String) });
    expect((tombstone?.payload as LedgerEntry).attachmentId).toBeUndefined();

    await purgeDeletedEntry(created.id, database);
    expect(await database.entries.get(created.id)).toBeUndefined();
    expect(await database.attachments.get(created.attachmentId!)).toBeUndefined();
    await expect(database.syncOutbox.get(`entry:${created.id}`)).resolves.toEqual(tombstone);
  });

  it("applies remote entities and tombstones transactionally", async () => {
    await linkSyncAccount(session(), false, database);
    const entry: LedgerEntry = {
      id: "remote-entry",
      amountMinor: 2500,
      note: "remote",
      occurredAt: "2026-07-30T12:30:00.000Z",
      localDateKey: "2026-07-30",
      localMonthKey: "2026-07",
      timezoneOffsetMinutes: 0,
      treatment: "ordinary_income",
      confirmationStatus: "not_needed",
      createdAt: "2026-07-30T12:30:00.000Z",
      updatedAt: "2026-07-30T12:30:00.000Z",
    };
    await applyRemoteChanges([remoteChange(entry, 1)], "1", database);
    await expect(database.entries.get(entry.id)).resolves.toEqual(entry);
    expect((await database.syncState.get("primary"))?.cursor).toBe("1");

    const deleted = {
      ...entry,
      deletedAt: "2026-07-30T13:00:00.000Z",
      updatedAt: "2026-07-30T13:00:00.000Z",
    };
    await applyRemoteChanges([remoteChange(deleted, 2)], "2", database);
    expect(await database.entries.get(entry.id)).toBeUndefined();
    expect((await database.entitySyncState.get(`entry:${entry.id}`))?.serverVersion).toBe(2);
  });

  it("ignores an acknowledgement for an outbox mutation that was superseded locally", async () => {
    await linkSyncAccount(session(), true, database);
    const created = await createEntry(draft(), database);
    const sent = (await database.syncOutbox.get(`entry:${created.id}`))!;
    await updateEntry(created.id, draft({ note: "newer edit" }), database);
    const current = await database.syncOutbox.get(`entry:${created.id}`);

    await markPushResults(
      [sent],
      [{ id: sent.id, status: "applied", version: 1 }],
      database,
    );
    await expect(database.syncOutbox.get(`entry:${created.id}`)).resolves.toEqual(current);
    expect((await database.entitySyncState.get(`entry:${created.id}`))?.status).toBe("pending");
  });

  it("keeps local data visible on conflict and supports both explicit resolutions", async () => {
    await linkSyncAccount(session(), true, database);
    const local = await createEntry(draft({ note: "local" }), database);
    const sent = (await database.syncOutbox.get(`entry:${local.id}`))!;
    const remote = { ...local, amountMinor: -999, note: "cloud" };
    await markPushResults(
      [sent],
      [{ id: sent.id, status: "conflict", remote: remoteChange(remote, 1) }],
      database,
    );
    expect((await database.entries.get(local.id))?.note).toBe("local");
    expect(await database.syncOutbox.get(`entry:${local.id}`)).toBeDefined();
    expect(await database.syncConflicts.get(`entry:${local.id}`)).toBeDefined();

    await resolveSyncConflict("entry", local.id, "use-cloud", database);
    expect((await database.entries.get(local.id))?.note).toBe("cloud");
    expect(await database.syncOutbox.get(`entry:${local.id}`)).toBeUndefined();

    await updateEntry(local.id, draft({ note: "keep this" }), database);
    const secondSent = (await database.syncOutbox.get(`entry:${local.id}`))!;
    const newerRemote = { ...remote, amountMinor: -777, note: "newer cloud" };
    await markPushResults(
      [secondSent],
      [{ id: secondSent.id, status: "conflict", remote: remoteChange(newerRemote, 2) }],
      database,
    );
    await resolveSyncConflict("entry", local.id, "keep-local", database);
    const retry = await database.syncOutbox.get(`entry:${local.id}`);
    expect(retry?.baseVersion).toBe(2);
    expect((retry?.payload as LedgerEntry).note).toBe("keep this");
    expect((await database.entries.get(local.id))?.note).toBe("keep this");
    expect(await database.syncConflicts.get(`entry:${local.id}`)).toBeUndefined();
  });

  it("keeps a legacy-income claim durable when a settings conflict uses the cloud version", async () => {
    await linkSyncAccount(session(), true, database);
    await setPayCyclePlan({
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 10_000,
    }, database, new Date(2026, 7, 9, 10));
    const sent = (await database.syncOutbox.get("settings:primary"))!;
    const remote: AppSettings = {
      ...(await getSettings(database)),
      payCycle: {
        paydayDay: 10,
        cycleEndBalanceGoalMinor: 25_000,
      },
      incomeForecast: {
        id: "legacy-income-2026-08-10",
        targetPaydayDateKey: "2026-08-10",
        minimumIncomeMinor: 0,
        expectedIncomeMinor: 700_000,
      },
      updatedAt: "2026-08-09T03:00:00.000Z",
    };
    await markPushResults([sent], [{
      id: sent.id,
      status: "conflict",
      remote: {
        seq: "4",
        entityType: "settings",
        entityId: "primary",
        version: 4,
        payload: remote,
        claimLegacyIncomeForecast: true,
      },
    }], database, new Date(2026, 7, 9, 11));

    expect(await database.syncConflicts.get("settings:primary")).toMatchObject({
      claimLegacyIncomeForecast: true,
      remoteVersion: 4,
    });
    await resolveSyncConflict(
      "settings",
      "primary",
      "use-cloud",
      database,
      new Date(2026, 7, 9, 12),
    );

    expect((await getSettings(database)).incomeForecast).toEqual(remote.incomeForecast);
    expect(await database.syncOutbox.get("settings:primary")).toMatchObject({
      baseVersion: 4,
      payload: { incomeForecast: remote.incomeForecast },
    });
    expect(await database.syncConflicts.get("settings:primary")).toBeUndefined();
  });

  it("rejects a different authenticated account until the ledger is explicitly unlinked", async () => {
    await linkSyncAccount(session(), false, database);
    await expect(assertSyncAccount("account-2", database)).rejects.toMatchObject({
      code: "account-mismatch",
    });
    await expect(
      linkSyncAccount({
        ...session(),
        user: { id: "account-2", email: "other@example.test" },
      }, false, database),
    ).rejects.toMatchObject({ code: "account-mismatch" });
  });

  it("persists the cloud generation and rejects a silent generation relink", async () => {
    await linkSyncAccount(session({ generation: 3 }), false, database);

    await expect(assertSyncAccount("account-1", database, 3)).resolves.toMatchObject({
      generation: 3,
    });
    await expect(assertSyncAccount("account-1", database, 4)).rejects.toMatchObject({
      code: "sync-generation-mismatch",
    });
    await expect(
      linkSyncAccount(session({ generation: 4 }), true, database),
    ).rejects.toMatchObject({ code: "sync-generation-mismatch" });
    expect((await database.syncState.get("primary"))?.generation).toBe(3);
  });
});
