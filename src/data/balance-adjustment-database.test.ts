import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_AMOUNT_MINOR } from "../domain/amount";
import type { AppSettings, LedgerEntry } from "../domain/types";
import {
  API_SCHEMA_VERSION,
  type SessionResponse,
  type SyncChange,
} from "../sync/contracts";
import {
  INDEXED_DB_VERSION,
  LedgerDatabase,
  applyRemoteChanges,
  correctOpeningBalance,
  createDefaultSettings,
  createEntry,
  getLedgerSummary,
  getSettings,
  linkSyncAccount,
  listBalanceAdjustments,
  reconcileBalance,
  setInitialBalance,
  softDeleteBalanceAdjustment,
  softDeleteEntry,
} from "./database";

function syncSession(hasData = false): SessionResponse {
  return {
    schemaVersion: API_SCHEMA_VERSION,
    user: { id: "account-1", email: "owner@example.test" },
    cloud: {
      syncStatus: "enabled",
      generation: 1,
      hasData,
      entryCount: 0,
      attachmentCount: 0,
      cursor: "0",
    },
  };
}

describe("balance audit data layer", () => {
  let database: LedgerDatabase;

  beforeEach(async () => {
    database = new LedgerDatabase(`jiyibi-balance-audit-${crypto.randomUUID()}`);
    await database.open();
  });

  afterEach(async () => {
    database.close();
    await database.delete();
  });

  it("locks the opening balance with the first fact and never unlocks after deletion", async () => {
    await setInitialBalance(10_000, database, new Date("2026-08-01T00:00:00.000Z"));
    const entry = await createEntry({
      kind: "expense",
      amount: "10",
      note: "午餐",
      occurredAtLocal: "2026-08-01T12:00",
    }, database, new Date("2026-08-01T04:00:00.000Z"));

    expect((await getSettings(database)).initialBalanceLockedAt)
      .toBe("2026-08-01T04:00:00.000Z");
    await softDeleteEntry(entry.id, database, new Date("2026-08-01T05:00:00.000Z"));
    await expect(setInitialBalance(20_000, database)).rejects.toMatchObject({
      code: "initial-balance-locked",
    });
  });

  it("reconciles total balance without changing cashflow statistics", async () => {
    await setInitialBalance(10_000, database);
    await createEntry({
      kind: "expense",
      amount: "10",
      note: "午餐",
      occurredAtLocal: "2026-08-01T12:00",
    }, database, new Date("2026-08-01T04:00:00.000Z"));
    const adjustment = await reconcileBalance(
      { observedBalanceMinor: 8_000 },
      database,
      new Date("2026-08-01T05:00:00.000Z"),
    );

    expect(adjustment).toMatchObject({
      kind: "reconciliation",
      amountMinor: -1_000,
      balanceBeforeMinor: 9_000,
      observedBalanceMinor: 8_000,
    });
    await expect(getLedgerSummary("2026-08", database)).resolves.toEqual({
      balanceMinor: 8_000,
      monthIncomeMinor: 0,
      monthExpenseMinor: 1_000,
    });

    await softDeleteBalanceAdjustment(
      adjustment.id,
      database,
      new Date("2026-08-01T05:00:07.999Z"),
    );
    await expect(getLedgerSummary("2026-08", database)).resolves.toMatchObject({
      balanceMinor: 9_000,
    });
    expect(await listBalanceAdjustments(database)).toEqual([
      expect.objectContaining({ id: adjustment.id, deletedAt: "2026-08-01T05:00:07.999Z" }),
    ]);
  });

  it("records opening corrections as deltas without rewriting the original setting", async () => {
    await setInitialBalance(1_000, database);
    const first = await correctOpeningBalance(
      { nextOpeningMinor: 2_000 },
      database,
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const second = await correctOpeningBalance(
      { nextOpeningMinor: 1_500 },
      database,
      new Date("2026-08-01T00:00:10.000Z"),
    );

    expect(first).toMatchObject({
      kind: "opening_correction",
      amountMinor: 1_000,
      previousOpeningMinor: 1_000,
      nextOpeningMinor: 2_000,
    });
    expect(second).toMatchObject({
      amountMinor: -500,
      previousOpeningMinor: 2_000,
      nextOpeningMinor: 1_500,
    });
    expect((await getSettings(database)).initialBalanceMinor).toBe(1_000);
    expect((await getLedgerSummary("2026-08", database)).balanceMinor).toBe(1_500);
  });

  it("only allows the just-saved adjustment to be soft-voided for eight seconds", async () => {
    const adjustment = await reconcileBalance(
      { observedBalanceMinor: 100 },
      database,
      new Date("2026-08-01T00:00:00.000Z"),
    );
    await expect(softDeleteBalanceAdjustment(
      adjustment.id,
      database,
      new Date("2026-08-01T00:00:08.001Z"),
    )).rejects.toMatchObject({ code: "undo-window-expired" });
    expect(await database.balanceAdjustments.get(adjustment.id)).not.toHaveProperty("deletedAt");
  });

  it("rolls back a reconciliation whose delta exceeds the supported range", async () => {
    await setInitialBalance(MAX_AMOUNT_MINOR, database);
    await expect(reconcileBalance(
      { observedBalanceMinor: -MAX_AMOUNT_MINOR },
      database,
    )).rejects.toMatchObject({ code: "invalid-settings" });
    expect(await database.balanceAdjustments.count()).toBe(0);
    expect((await getSettings(database)).initialBalanceLockedAt).toBeUndefined();
  });

  it("migrates a v6 ledger with even a deleted fact to a permanently locked opening", async () => {
    database.close();
    await database.delete();
    const name = `jiyibi-balance-v6-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(6).stores({
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
    const settings: AppSettings = createDefaultSettings(new Date("2026-08-02T00:00:00.000Z"));
    const deletedEntry: LedgerEntry = {
      id: "deleted-entry",
      amountMinor: -100,
      note: "deleted",
      occurredAt: "2026-08-01T00:00:00.000Z",
      localDateKey: "2026-08-01",
      localMonthKey: "2026-08",
      timezoneOffsetMinutes: 0,
      treatment: "ordinary_expense",
      confirmationStatus: "not_needed",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T01:00:00.000Z",
      deletedAt: "2026-08-01T01:00:00.000Z",
    };
    await legacy.table("settings").put(settings);
    await legacy.table("entries").put(deletedEntry);
    await legacy.table("syncOutbox").put({
      entityKey: "settings:primary",
      id: "mutation-before-v8",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 7,
      payload: settings,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    await legacy.table("syncConflicts").put({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      localPayload: settings,
      remotePayload: settings,
      remoteVersion: 8,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    legacy.close();

    database = new LedgerDatabase(name, new Date("2026-08-03T00:00:00.000Z"));
    await database.open();
    expect(database.verno).toBe(INDEXED_DB_VERSION);
    expect((await getSettings(database)).initialBalanceLockedAt)
      .toBe("2026-08-01T00:00:00.000Z");
    const migratedOutbox = await database.syncOutbox.get("settings:primary");
    expect(migratedOutbox).toMatchObject({
      baseVersion: 7,
      payload: { initialBalanceLockedAt: "2026-08-01T00:00:00.000Z" },
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    expect(migratedOutbox?.id).not.toBe("mutation-before-v8");
    const migratedConflict = await database.syncConflicts.get("settings:primary");
    expect(migratedConflict).toMatchObject({
      localPayload: { initialBalanceLockedAt: "2026-08-01T00:00:00.000Z" },
      remoteVersion: 8,
    });
    expect(migratedConflict?.remotePayload).not.toHaveProperty("initialBalanceLockedAt");
  });

  it("locks on a remote adjustment and never unlocks when later settings omit the field", async () => {
    await database.syncState.put({
      id: "primary",
      accountId: "account-1",
      accountEmail: "owner@example.test",
      generation: 1,
      cursor: "0",
      syncProtocolVersion: 8,
      uploadApproved: true,
      linkedAt: "2026-08-01T00:00:00.000Z",
    });
    const adjustment = {
      id: "remote-adjustment",
      kind: "reconciliation" as const,
      amountMinor: 100,
      balanceBeforeMinor: 0,
      observedBalanceMinor: 100,
      note: "remote",
      occurredAt: "2026-08-01T00:00:00.000Z",
      localDateKey: "2026-08-01",
      localMonthKey: "2026-08",
      timezoneOffsetMinutes: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    await applyRemoteChanges([{
      seq: "1",
      entityType: "balanceAdjustment",
      entityId: adjustment.id,
      version: 1,
      payload: adjustment,
    }], "1", database);
    expect((await getSettings(database)).initialBalanceLockedAt)
      .toBe("2026-08-01T00:00:00.000Z");

    await applyRemoteChanges([{
      seq: "2",
      entityType: "settings",
      entityId: "primary",
      version: 1,
      payload: createDefaultSettings(new Date("2026-08-02T00:00:00.000Z")),
    }], "2", database);
    expect((await getSettings(database)).initialBalanceLockedAt)
      .toBe("2026-08-01T00:00:00.000Z");
  });

  it("uploads pre-link adjustment history and lets a second device inherit its lock", async () => {
    await setInitialBalance(1_000, database, new Date("2026-08-01T00:00:00.000Z"));
    const active = await reconcileBalance(
      { observedBalanceMinor: 900 },
      database,
      new Date("2026-08-01T01:00:00.000Z"),
    );
    const voided = await correctOpeningBalance(
      { nextOpeningMinor: 1_200 },
      database,
      new Date("2026-08-01T01:00:10.000Z"),
    );
    await softDeleteBalanceAdjustment(
      voided.id,
      database,
      new Date("2026-08-01T01:00:17.000Z"),
    );

    await linkSyncAccount(syncSession(), true, database);
    const outbox = await database.syncOutbox.toArray();
    const settingsMutation = outbox.find((record) => record.entityType === "settings");
    const adjustmentMutations = outbox
      .filter((record) => record.entityType === "balanceAdjustment")
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    expect(settingsMutation?.payload).toMatchObject({
      initialBalanceLockedAt: active.createdAt,
    });
    expect(adjustmentMutations).toHaveLength(2);
    expect(adjustmentMutations.map((record) => record.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: active.id }),
      expect.objectContaining({ id: voided.id, deletedAt: "2026-08-01T01:00:17.000Z" }),
    ]));
    expect(adjustmentMutations.find((record) => record.entityId === active.id)?.payload)
      .not.toHaveProperty("deletedAt");

    const second = new LedgerDatabase(`jiyibi-balance-second-${crypto.randomUUID()}`);
    await second.open();
    try {
      await linkSyncAccount(syncSession(true), false, second);
      const remoteChanges: SyncChange[] = [settingsMutation!, ...adjustmentMutations]
        .map((record, index) => ({
          seq: String(index + 1),
          entityType: record.entityType,
          entityId: record.entityId,
          version: 1,
          payload: record.payload,
        } as SyncChange));
      await applyRemoteChanges(remoteChanges, String(remoteChanges.length), second);

      expect((await getSettings(second)).initialBalanceLockedAt).toBe(active.createdAt);
      expect(await listBalanceAdjustments(second)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: active.id }),
        expect.objectContaining({ id: voided.id, deletedAt: "2026-08-01T01:00:17.000Z" }),
      ]));
      expect(await second.balanceAdjustments.get(active.id)).not.toHaveProperty("deletedAt");
    } finally {
      second.close();
      await second.delete();
    }
  });
});
