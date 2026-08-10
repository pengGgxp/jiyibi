import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryDraft, LedgerEntry, ProcessedImage } from "../domain/types";
import {
  API_SCHEMA_VERSION,
  type SessionResponse,
  type SyncChange,
} from "../sync/contracts";
import {
  DATABASE_SCHEMA_VERSION,
  INDEXED_DB_VERSION,
  LedgerDatabase,
  applyRemoteChanges,
  assertSyncAccount,
  createDefaultSettings,
  createEntry,
  getAttachment,
  getLedgerSummary,
  getSettings,
  listActiveEntries,
  linkSyncAccount,
  markPushResults,
  purgeDeletedEntry,
  replaceLedgerData,
  resolveSyncConflict,
  setInitialBalance,
  setMonthEndBalanceGoal,
  setPayCyclePlan,
  softDeleteEntry,
  undoDeleteEntry,
  updateEntry,
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

function remoteChange(entry: LedgerEntry, version: number, seq = String(version)): SyncChange {
  return {
    seq,
    entityType: "entry",
    entityId: entry.id,
    version,
    payload: entry,
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

  it("saves and clears an atomic pay-cycle plan while migrating the legacy goal", async () => {
    await setInitialBalance(1_234, database);
    await setMonthEndBalanceGoal(50_000, database);
    const plan = {
      paydayDay: 10,
      monthlySalaryMinor: 800_000,
      cycleEndBalanceGoalMinor: 100_000,
    };

    const saved = await setPayCyclePlan(plan, database, new Date("2026-08-10T02:00:00.000Z"));
    expect(saved).toMatchObject({ initialBalanceMinor: 1_234, payCycle: plan });
    expect(saved).not.toHaveProperty("monthEndBalanceGoalMinor");

    await setInitialBalance(-2_500, database);
    expect(await getSettings(database)).toMatchObject({
      initialBalanceMinor: -2_500,
      payCycle: plan,
    });

    const cleared = await setPayCyclePlan(undefined, database);
    expect(cleared).not.toHaveProperty("payCycle");
    expect(cleared).not.toHaveProperty("monthEndBalanceGoalMinor");
  });

  it.each([
    { paydayDay: 0, monthlySalaryMinor: 1, cycleEndBalanceGoalMinor: 0 },
    { paydayDay: 32, monthlySalaryMinor: 1, cycleEndBalanceGoalMinor: 0 },
    { paydayDay: 10, monthlySalaryMinor: 0, cycleEndBalanceGoalMinor: 0 },
    { paydayDay: 10, monthlySalaryMinor: 1.5, cycleEndBalanceGoalMinor: 0 },
    { paydayDay: 10, monthlySalaryMinor: 1, cycleEndBalanceGoalMinor: Number.NaN },
  ])("rejects an incomplete or invalid pay-cycle plan: %o", async (invalidPlan) => {
    const before = await getSettings(database);
    await expect(setPayCyclePlan(invalidPlan, database)).rejects.toMatchObject({
      code: "invalid-settings",
    });
    await expect(getSettings(database)).resolves.toEqual(before);
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
    const entry: LedgerEntry = {
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
      await expect(upgraded.entries.get(entry.id)).resolves.toEqual(entry);
      expect((await getSettings(upgraded)).initialBalanceMinor).toBe(4321);
      await expect(upgraded.syncOutbox.count()).resolves.toBe(0);
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
    expect((await database.syncState.get("primary"))?.syncProtocolVersion).toBe(3);

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
    const plan = {
      paydayDay: 10,
      monthlySalaryMinor: 800_000,
      cycleEndBalanceGoalMinor: 100_000,
    };

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
    expect(reset?.payload).toHaveProperty("payCycle", plan);
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
