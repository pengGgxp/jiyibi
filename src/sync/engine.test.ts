import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EntryDraft,
  LedgerEntry,
  ProcessedImage,
  RecoveryAllocation,
} from "../domain/types";
import {
  clearIncomeForecast,
  LedgerDatabase,
  createEntry,
  linkSyncAccount,
  recordActualIncome,
  resolveSyncConflict,
  reserveSavings,
  setIncomeForecast,
  setInitialBalance,
  setMonthEndBalanceGoal,
  setPayCyclePlan,
  softDeleteEntry,
  updateEntry,
  updateEntryTreatment,
  upsertRecoveryAllocation,
} from "../data/database";
import type { SyncApiClient } from "./api";
import {
  API_SCHEMA_VERSION,
  SYNC_SCHEMA_VERSION,
  type SessionResponse,
  type SyncResponse,
} from "./contracts";
import {
  SyncGenerationChangedError,
  SyncIncompleteError,
  syncNow,
} from "./engine";

function session(accountId = "account-1", generation = 1): SessionResponse {
  return {
    schemaVersion: API_SCHEMA_VERSION,
    user: { id: accountId, email: `${accountId}@example.test` },
    cloud: {
      syncStatus: "enabled",
      generation,
      hasData: true,
      entryCount: 1,
      attachmentCount: 0,
      cursor: "1",
    },
  };
}

function draft(image?: ProcessedImage): EntryDraft {
  return {
    kind: "expense",
    amount: "12.34",
    note: image ? "" : "local",
    occurredAtLocal: "2026-07-30T12:30",
    image,
  };
}

function processedImage(): ProcessedImage {
  const blob = new Blob(["jpeg"], { type: "image/jpeg" });
  return { blob, mimeType: blob.type, size: blob.size, width: 10, height: 8 };
}

function emptyResponse(overrides: Partial<SyncResponse> = {}): SyncResponse {
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    results: [],
    changes: [],
    nextCursor: "0",
    hasMore: false,
    ...overrides,
  };
}

function apiClient(response: SyncResponse, currentSession = session()): SyncApiClient {
  return {
    getSession: vi.fn().mockResolvedValue(currentSession),
    enableCloudSync: vi.fn().mockResolvedValue(1),
    deleteCloudData: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(response),
    putAttachment: vi.fn().mockResolvedValue(undefined),
    getAttachment: vi.fn().mockResolvedValue(undefined),
  };
}

describe("sync engine", () => {
  let database: LedgerDatabase;

  beforeEach(async () => {
    database = new LedgerDatabase(`jiyibi-engine-${crypto.randomUUID()}`);
    await database.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    database.close();
    await database.delete();
  });

  it("uploads an attachment before its entry mutation and clears an acknowledged outbox", async () => {
    await linkSyncAccount(session(), true, database);
    const entry = await createEntry(draft(processedImage()), database);
    const queued = (await database.syncOutbox.get(`entry:${entry.id}`))!;
    const api = apiClient(emptyResponse({
      results: [{ id: queued.id, status: "applied", version: 1 }],
      nextCursor: "1",
    }));

    const overview = await syncNow(database, api);

    expect(api.putAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: entry.attachmentId, entryId: entry.id }),
      1,
    );
    expect(vi.mocked(api.putAttachment).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.sync).mock.invocationCallOrder[0],
    );
    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      cursor: "0",
      mutations: [expect.objectContaining({ id: queued.id, entityId: entry.id })],
    }), 1);
    expect(overview.pendingCount).toBe(0);
  });

  it("downloads and caches a remote attachment in the same successful pull", async () => {
    await linkSyncAccount(session(), false, database);
    const entry: LedgerEntry = {
      id: "entry_remote",
      amountMinor: 500,
      note: "",
      occurredAt: "2026-07-30T12:30:00.000Z",
      localDateKey: "2026-07-30",
      localMonthKey: "2026-07",
      timezoneOffsetMinutes: 0,
      attachmentId: "attachment_remote",
      treatment: "ordinary_income",
      confirmationStatus: "not_needed",
      createdAt: "2026-07-30T12:30:00.000Z",
      updatedAt: "2026-07-30T12:30:00.000Z",
    };
    const blob = new Blob(["remote"], { type: "image/jpeg" });
    const api = apiClient(emptyResponse({
      changes: [{
        seq: "1",
        entityType: "entry",
        entityId: entry.id,
        version: 1,
        payload: entry,
      }],
      nextCursor: "1",
    }));
    vi.mocked(api.getAttachment).mockResolvedValue({
      blob,
      entryId: entry.id,
      mimeType: blob.type,
      size: blob.size,
      width: 20,
      height: 10,
    });

    await syncNow(database, api);

    expect(api.getAttachment).toHaveBeenCalledWith(entry.attachmentId, 1);
    expect(await database.entries.get(entry.id)).toEqual(entry);
    expect(await database.attachments.get(entry.attachmentId!)).toMatchObject({
      id: entry.attachmentId,
      entryId: entry.id,
      width: 20,
      height: 10,
    });
    expect((await database.syncState.get("primary"))?.cursor).toBe("1");
  });

  it("pushes and acknowledges an independent recovery allocation mutation", async () => {
    const expense = await createEntry(draft(), database);
    const refund = await createEntry({ ...draft(), kind: "income" }, database);
    await updateEntryTreatment(expense.id, "reimbursable_expense", {}, database);
    await updateEntryTreatment(refund.id, "refund_reimbursement", {}, database);
    await linkSyncAccount(session(), true, database);
    await database.syncOutbox.clear();
    const allocation = await upsertRecoveryAllocation({
      refundEntryId: refund.id,
      expenseEntryId: expense.id,
      amountMinor: 500,
    }, database);
    const queued = (await database.syncOutbox.get(
      `recoveryAllocation:${allocation.id}`,
    ))!;
    const api = apiClient(emptyResponse({
      results: [{ id: queued.id, status: "applied", version: 1 }],
      nextCursor: "1",
    }));

    await syncNow(database, api);

    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: SYNC_SCHEMA_VERSION,
      mutations: [expect.objectContaining({
        entityType: "recoveryAllocation",
        entityId: allocation.id,
        payload: allocation,
      })],
    }), 1);
    expect(await database.syncOutbox.get(
      `recoveryAllocation:${allocation.id}`,
    )).toBeUndefined();
  });

  it("pushes and acknowledges an independent retained-money mutation", async () => {
    await createEntry({
      ...draft(),
      kind: "income",
      amount: "1000",
      note: "opening funds",
    }, database);
    await linkSyncAccount(session(), true, database);
    await database.syncOutbox.clear();
    const event = await reserveSavings({
      amountMinor: 50_000,
      note: "本周期留存",
      occurredAtLocal: "2026-07-30T13:00",
    }, database);
    const queued = (await database.syncOutbox.get(`savingsEvent:${event.id}`))!;
    const api = apiClient(emptyResponse({
      results: [{ id: queued.id, status: "applied", version: 1 }],
      nextCursor: "1",
    }));

    await syncNow(database, api);

    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: SYNC_SCHEMA_VERSION,
      mutations: [expect.objectContaining({
        entityType: "savingsEvent",
        entityId: event.id,
        payload: event,
      })],
    }), 1);
    expect(await database.syncOutbox.get(`savingsEvent:${event.id}`)).toBeUndefined();
  });

  it("pushes allocation tombstones before deleting their linked entry", async () => {
    const expense = await createEntry(draft(), database);
    const refund = await createEntry({ ...draft(), kind: "income" }, database);
    await updateEntryTreatment(expense.id, "reimbursable_expense", {}, database);
    await updateEntryTreatment(refund.id, "refund_reimbursement", {}, database);
    const allocation = await upsertRecoveryAllocation({
      refundEntryId: refund.id,
      expenseEntryId: expense.id,
      amountMinor: 500,
    }, database);
    await linkSyncAccount(session(), true, database);
    await database.syncOutbox.clear();
    await database.entitySyncState.bulkPut([
      {
        id: `entry:${expense.id}`,
        entityType: "entry",
        entityId: expense.id,
        serverVersion: 1,
        status: "clean",
        updatedAt: "2026-07-30T13:59:00.000Z",
      },
      {
        id: `recoveryAllocation:${allocation.id}`,
        entityType: "recoveryAllocation",
        entityId: allocation.id,
        serverVersion: 1,
        status: "clean",
        updatedAt: "2026-07-30T13:59:00.000Z",
      },
    ]);
    await softDeleteEntry(
      expense.id,
      database,
      new Date("2026-07-30T14:00:00.000Z"),
    );
    const allocationMutation = (await database.syncOutbox.get(
      `recoveryAllocation:${allocation.id}`,
    ))!;
    const entryMutation = (await database.syncOutbox.get(`entry:${expense.id}`))!;
    const api = apiClient(emptyResponse({
      results: [
        { id: allocationMutation.id, status: "applied", version: 1 },
        { id: entryMutation.id, status: "applied", version: 1 },
      ],
      nextCursor: "1",
    }));

    await syncNow(database, api);

    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [
        expect.objectContaining({
          entityType: "recoveryAllocation",
          entityId: allocation.id,
          payload: expect.objectContaining({ deletedAt: "2026-07-30T14:00:00.000Z" }),
        }),
        expect.objectContaining({
          entityType: "entry",
          entityId: expense.id,
          payload: expect.objectContaining({ deletedAt: "2026-07-30T14:00:00.000Z" }),
        }),
      ],
    }), 1);
  });

  it("pushes new entries before a new allocation tombstone that references them", async () => {
    await linkSyncAccount(session(), true, database);
    const expense = await createEntry(draft(), database);
    const refund = await createEntry({ ...draft(), kind: "income" }, database);
    await updateEntryTreatment(expense.id, "one_time_expense", {}, database);
    await updateEntryTreatment(refund.id, "refund_reimbursement", {}, database);
    const allocation = await upsertRecoveryAllocation({
      refundEntryId: refund.id,
      expenseEntryId: expense.id,
      amountMinor: 500,
    }, database);
    await softDeleteEntry(
      expense.id,
      database,
      new Date("2026-07-30T14:00:00.000Z"),
    );
    const queued = await database.syncOutbox.toArray();
    const api = apiClient(emptyResponse({
      results: queued.map((mutation) => ({
        id: mutation.id,
        status: "applied" as const,
        version: 1,
      })),
      nextCursor: "1",
    }));

    await syncNow(database, api);

    const request = vi.mocked(api.sync).mock.calls[0][0];
    expect(request.mutations.map((mutation) => mutation.entityType)).toEqual([
      "entry",
      "entry",
      "recoveryAllocation",
    ]);
    expect(request.mutations[2]).toMatchObject({
      entityId: allocation.id,
      payload: { deletedAt: "2026-07-30T14:00:00.000Z" },
    });
  });

  it("pulls and removes recovery allocations independently", async () => {
    await linkSyncAccount(session(), false, database);
    const allocation: RecoveryAllocation = {
      id: "recovery-remote",
      refundEntryId: "refund-remote",
      expenseEntryId: "expense-remote",
      amountMinor: 500,
      createdAt: "2026-07-30T12:00:00.000Z",
      updatedAt: "2026-07-30T12:00:00.000Z",
    };
    const deleted = {
      ...allocation,
      deletedAt: "2026-07-30T13:00:00.000Z",
      updatedAt: "2026-07-30T13:00:00.000Z",
    };
    const api = apiClient(emptyResponse());
    vi.mocked(api.sync)
      .mockResolvedValueOnce(emptyResponse({
        changes: [{
          seq: "1",
          entityType: "recoveryAllocation",
          entityId: allocation.id,
          version: 1,
          payload: allocation,
        }],
        nextCursor: "1",
        hasMore: true,
      }))
      .mockResolvedValueOnce(emptyResponse({
        changes: [{
          seq: "2",
          entityType: "recoveryAllocation",
          entityId: allocation.id,
          version: 2,
          payload: deleted,
        }],
        nextCursor: "2",
      }));

    await syncNow(database, api);

    expect(await database.recoveryAllocations.get(allocation.id)).toBeUndefined();
    expect(await database.entitySyncState.get(
      `recoveryAllocation:${allocation.id}`,
    )).toMatchObject({ serverVersion: 2, tombstoneAcknowledged: true });
    expect((await database.syncState.get("primary"))?.cursor).toBe("2");
  });

  it("leaves the cursor and outbox untouched when the server requires an upgrade", async () => {
    await linkSyncAccount(session(), true, database);
    const entry = await createEntry(draft(), database);
    const queued = (await database.syncOutbox.get(`entry:${entry.id}`))!;
    const api = apiClient(emptyResponse());
    vi.mocked(api.sync).mockRejectedValue(Object.assign(new Error("upgrade"), {
      code: "upgrade_required",
    }));

    await expect(syncNow(database, api)).rejects.toMatchObject({
      code: "upgrade_required",
    });
    expect((await database.syncState.get("primary"))?.cursor).toBe("0");
    expect(await database.syncOutbox.get(`entry:${entry.id}`)).toEqual(queued);
  });

  it("leaves the same mutation durable across a network failure and idempotent retry", async () => {
    await linkSyncAccount(session(), true, database);
    const entry = await createEntry(draft(), database);
    const queued = (await database.syncOutbox.get(`entry:${entry.id}`))!;
    const api = apiClient(emptyResponse());
    vi.mocked(api.sync)
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(emptyResponse({
        results: [{ id: queued.id, status: "duplicate", version: 1 }],
        nextCursor: "1",
      }));

    await expect(syncNow(database, api)).rejects.toThrow("offline");
    expect((await database.syncOutbox.get(`entry:${entry.id}`))?.id).toBe(queued.id);

    await syncNow(database, api);
    const requests = vi.mocked(api.sync).mock.calls.map(([request]) => request);
    expect(requests[0].mutations[0].id).toBe(queued.id);
    expect(requests[1].mutations[0].id).toBe(queued.id);
    expect(await database.syncOutbox.get(`entry:${entry.id}`)).toBeUndefined();
  });

  it("does not upload an edited provisional income while its confirmation is blocked", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await linkSyncAccount(session(), true, database);
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const confirmed = await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    await updateEntry(confirmed.entry!.id, {
      kind: "income",
      amount: "700.00",
      note: "corrected income",
      occurredAtLocal: "2026-08-10T09:00",
    }, database, new Date(2026, 7, 10, 9, 1));
    const localSettings = (await database.settings.get("primary"))!;
    await database.syncConflicts.put({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      localPayload: localSettings,
      remotePayload: { ...localSettings, initialBalanceMinor: 1 },
      remoteVersion: 1,
      createdAt: setup.toISOString(),
      updatedAt: setup.toISOString(),
    });
    const api = apiClient(emptyResponse());

    await syncNow(database, api);

    expect(vi.mocked(api.sync).mock.calls[0][0].mutations).not.toContainEqual(
      expect.objectContaining({
        entityType: "entry",
        entityId: confirmed.entry!.id,
      }),
    );
    await expect(database.syncOutbox.get(`entry:${confirmed.entry!.id}`))
      .resolves.toBeDefined();
  });

  it("keeps a confirmation while upload is paused and sends it first after approval", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await linkSyncAccount(session(), false, database);
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    const confirmed = await recordActualIncome(0, database, new Date(2026, 7, 10, 9));
    const pendingConfirmation = (await database.syncOutbox.toArray())
      .find((record) => record.incomeConfirmation);
    expect(pendingConfirmation).toBeDefined();
    expect(confirmed.entry).toBeUndefined();

    await linkSyncAccount(session(), true, database);
    const api = apiClient(emptyResponse());
    vi.mocked(api.sync).mockImplementation(async (request) => {
      const confirmationMutation = request.mutations.find((mutation) =>
        mutation.entityType === "settings" && mutation.payload.incomeConfirmation);
      if (confirmationMutation?.entityType === "settings") {
        const receipt = confirmationMutation.payload.incomeConfirmation!;
        return emptyResponse({
          results: [{
            id: confirmationMutation.id,
            status: "applied",
            version: 1,
            incomeConfirmation: {
              confirmationId: receipt.confirmationId,
              forecastId: receipt.forecastId,
              actualIncomeMinor: receipt.actualIncomeMinor,
              ...(receipt.entry
                ? { entryVersion: 1, entry: receipt.entry }
                : {}),
            },
          }],
          nextCursor: "1",
        });
      }
      return emptyResponse({
        results: request.mutations.map((mutation) => ({
          id: mutation.id,
          status: "applied" as const,
          version: 2,
        })),
        nextCursor: "2",
      });
    });

    const overview = await syncNow(database, api);

    const requests = vi.mocked(api.sync).mock.calls.map(([request]) => request);
    const mutationRequests = requests.filter((request) => request.mutations.length > 0);
    expect(mutationRequests[0].mutations).toHaveLength(1);
    expect(mutationRequests[0].mutations[0]).toMatchObject({
      entityType: "settings",
      payload: { incomeConfirmation: { actualIncomeMinor: 0 } },
    });
    expect(mutationRequests[1].mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "settings", baseVersion: 1 }),
    ]));
    expect(overview.pendingCount).toBe(0);
  });

  it("downloads an attachment referenced only by a confirmation result", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await linkSyncAccount(session(), true, database);
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    const planned = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    await recordActualIncome(0, database, new Date(2026, 7, 10, 9));
    const pendingConfirmation = (await database.syncOutbox.toArray())
      .find((record) => record.incomeConfirmation)!;
    const forecastId = planned.incomeForecast!.id;
    const remoteEntry: LedgerEntry = {
      id: forecastId,
      amountMinor: 75_000,
      note: "remote income",
      occurredAt: "2026-08-10T01:00:00.000Z",
      localDateKey: "2026-08-10",
      localMonthKey: "2026-08",
      timezoneOffsetMinutes: -480,
      attachmentId: "attachment-confirmed-income",
      treatment: "ordinary_income",
      confirmationStatus: "not_needed",
      createdAt: "2026-08-10T01:00:00.000Z",
      updatedAt: "2026-08-10T01:00:00.000Z",
    };
    const remoteSettings = { ...(await database.settings.get("primary"))! };
    delete remoteSettings.incomeForecast;
    const api = apiClient(emptyResponse({
      results: [{
        id: pendingConfirmation.id,
        status: "duplicate",
        version: 2,
        incomeConfirmation: {
          confirmationId: "remote-confirmation",
          forecastId,
          actualIncomeMinor: 75_000,
          entryVersion: 1,
          entry: remoteEntry,
        },
      }],
      changes: [{
        seq: "1",
        entityType: "settings",
        entityId: "primary",
        version: 2,
        payload: remoteSettings,
      }],
      nextCursor: "1",
    }));
    const blob = new Blob(["remote receipt"], { type: "image/jpeg" });
    vi.mocked(api.getAttachment).mockResolvedValue({
      blob,
      entryId: forecastId,
      mimeType: blob.type,
      size: blob.size,
      width: 20,
      height: 10,
    });

    await syncNow(database, api);

    expect(api.getAttachment).toHaveBeenCalledWith(remoteEntry.attachmentId, 1);
    await expect(database.entries.get(forecastId)).resolves.toEqual(remoteEntry);
    await expect(database.attachments.get(remoteEntry.attachmentId!)).resolves.toMatchObject({
      entryId: forecastId,
      blob,
    });
  });

  it("sends multiple offline confirmations in order without leaving a settings mutation", async () => {
    const setup = new Date(2026, 7, 9, 10);
    await linkSyncAccount(session(), true, database);
    await setPayCyclePlan({ paydayDay: 10 }, database, setup);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, database, setup);
    await recordActualIncome(75_000, database, new Date(2026, 7, 10, 9));
    await setIncomeForecast({
      targetPaydayDateKey: "2026-09-10",
      expectedIncomeMinor: 82_000,
    }, database, new Date(2026, 7, 11, 9));
    await recordActualIncome(81_000, database, new Date(2026, 8, 10, 9));
    const api = apiClient(emptyResponse());
    let version = 0;
    vi.mocked(api.sync).mockImplementation(async (request) => {
      const mutation = request.mutations[0];
      if (!mutation) return emptyResponse({ nextCursor: String(version) });
      if (mutation.entityType !== "settings" || !mutation.payload.incomeConfirmation) {
        throw new Error("Expected one income confirmation per round");
      }
      version += 1;
      const receipt = mutation.payload.incomeConfirmation;
      return emptyResponse({
        results: [{
          id: mutation.id,
          status: "applied",
          version,
          incomeConfirmation: {
            confirmationId: receipt.confirmationId,
            forecastId: receipt.forecastId,
            actualIncomeMinor: receipt.actualIncomeMinor,
            ...(receipt.entry ? { entryVersion: 1, entry: receipt.entry } : {}),
          },
        }],
        nextCursor: String(version),
      });
    });

    const overview = await syncNow(database, api);

    const confirmations = vi.mocked(api.sync).mock.calls
      .flatMap(([request]) => request.mutations)
      .filter((mutation) => mutation.entityType === "settings")
      .map((mutation) => mutation.payload.incomeConfirmation!);
    expect(confirmations.map((confirmation) => confirmation.targetPaydayDateKey))
      .toEqual(["2026-08-10", "2026-09-10"]);
    expect(overview.pendingCount).toBe(0);
    await expect(database.syncOutbox.count()).resolves.toBe(0);
  });

  it("does not upload the retired monthly goal", async () => {
    await linkSyncAccount(session(), true, database);
    await setMonthEndBalanceGoal(50_000, database);
    await setMonthEndBalanceGoal(undefined, database);
    const queued = (await database.syncOutbox.get("settings:primary"))!;
    const api = apiClient(emptyResponse({
      results: [{ id: queued.id, status: "applied", version: 1 }],
    }));

    await syncNow(database, api);

    const request = vi.mocked(api.sync).mock.calls[0][0];
    expect(request.schemaVersion).toBe(SYNC_SCHEMA_VERSION);
    expect(request.mutations[0]).toMatchObject({ entityType: "settings" });
    expect(request.mutations[0].payload).not.toHaveProperty("monthEndBalanceGoalMinor");
  });

  it("pushes invalidated allocation tombstones before editing their linked entry", async () => {
    const expense = await createEntry(draft(), database);
    const refund = await createEntry({ ...draft(), kind: "income" }, database);
    await updateEntryTreatment(expense.id, "reimbursable_expense", {}, database);
    await updateEntryTreatment(refund.id, "refund_reimbursement", {}, database);
    const allocation = await upsertRecoveryAllocation({
      refundEntryId: refund.id,
      expenseEntryId: expense.id,
      amountMinor: 500,
    }, database);
    await linkSyncAccount(session(), true, database);
    await database.syncOutbox.clear();
    await database.entitySyncState.bulkPut([
      {
        id: `entry:${refund.id}`,
        entityType: "entry",
        entityId: refund.id,
        serverVersion: 1,
        status: "clean",
        updatedAt: "2026-07-30T13:59:00.000Z",
      },
      {
        id: `recoveryAllocation:${allocation.id}`,
        entityType: "recoveryAllocation",
        entityId: allocation.id,
        serverVersion: 1,
        status: "clean",
        updatedAt: "2026-07-30T13:59:00.000Z",
      },
    ]);
    await updateEntry(refund.id, {
      ...draft(),
      kind: "income",
      amount: "4.00",
    }, database, new Date("2026-07-30T14:00:00.000Z"));
    const allocationMutation = (await database.syncOutbox.get(
      `recoveryAllocation:${allocation.id}`,
    ))!;
    const entryMutation = (await database.syncOutbox.get(`entry:${refund.id}`))!;
    const api = apiClient(emptyResponse({
      results: [
        { id: allocationMutation.id, status: "applied", version: 2 },
        { id: entryMutation.id, status: "applied", version: 2 },
      ],
      nextCursor: "2",
    }));

    await syncNow(database, api);

    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [
        expect.objectContaining({
          entityType: "recoveryAllocation",
          entityId: allocation.id,
          payload: expect.objectContaining({ deletedAt: "2026-07-30T14:00:00.000Z" }),
        }),
        expect.objectContaining({
          entityType: "entry",
          entityId: refund.id,
          payload: expect.objectContaining({ amountMinor: 400 }),
        }),
      ],
    }), 1);
  });

  it("preserves the permanent opening-balance lock in v8 settings mutations", async () => {
    await linkSyncAccount(session(), true, database);
    const lockedAt = "2026-08-10T00:00:00.000Z";
    const settings = {
      ...(await database.settings.get("primary"))!,
      initialBalanceLockedAt: lockedAt,
      updatedAt: lockedAt,
    };
    await database.settings.put(settings);
    await database.syncOutbox.put({
      entityKey: "settings:primary",
      id: "mutation_locked_settings",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 0,
      payload: settings,
      createdAt: lockedAt,
      updatedAt: lockedAt,
    });
    const api = apiClient(emptyResponse({
      results: [{ id: "mutation_locked_settings", status: "applied", version: 1 }],
    }));

    await syncNow(database, api);

    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: SYNC_SCHEMA_VERSION,
      mutations: [expect.objectContaining({
        entityType: "settings",
        payload: expect.objectContaining({ initialBalanceLockedAt: lockedAt }),
      })],
    }), 1);
  });

  it("sends an explicit null only when the user clears the pay cycle", async () => {
    await linkSyncAccount(session(), true, database);
    await setPayCyclePlan({
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 100_000,
    }, database);
    await setPayCyclePlan(undefined, database);
    const queued = (await database.syncOutbox.get("settings:primary"))!;
    const api = apiClient(emptyResponse({
      results: [{ id: queued.id, status: "applied", version: 1 }],
    }));

    await syncNow(database, api);

    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: SYNC_SCHEMA_VERSION,
      mutations: [expect.objectContaining({
        entityType: "settings",
        payload: expect.objectContaining({
          payCycle: null,
          incomeForecast: null,
        }),
      })],
    }), 1);
  });

  it("sends an explicit null when the user clears only the next income forecast", async () => {
    await linkSyncAccount(session(), true, database);
    await setPayCyclePlan({
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 100_000,
    }, database, new Date(2026, 7, 1));
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 500_000,
      expectedIncomeMinor: 800_000,
    }, database, new Date(2026, 7, 1));
    await clearIncomeForecast(database, new Date(2026, 7, 2));
    const queued = (await database.syncOutbox.get("settings:primary"))!;
    const api = apiClient(emptyResponse({
      results: [{ id: queued.id, status: "applied", version: 1 }],
    }));

    await syncNow(database, api);

    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: SYNC_SCHEMA_VERSION,
      mutations: [expect.objectContaining({
        entityType: "settings",
        payload: expect.objectContaining({
          payCycle: { paydayDay: 10 },
          incomeForecast: null,
        }),
      })],
    }), 1);
  });

  it("refreshes settings once when a linked database upgrades from sync v3 to v4", async () => {
    await linkSyncAccount(session(), false, database);
    const legacyState = (await database.syncState.get("primary"))!;
    legacyState.syncProtocolVersion = 3;
    legacyState.cursor = "9";
    await database.syncState.put(legacyState);
    await database.entitySyncState.put({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      serverVersion: 1,
      status: "clean",
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
    const remoteSettings = {
      ...(await database.settings.get("primary"))!,
      payCycle: {
        paydayDay: 10,
        cycleEndBalanceGoalMinor: 25_000,
      },
      incomeForecast: {
        id: "forecast-remote",
        targetPaydayDateKey: "2026-09-10",
        minimumIncomeMinor: 500_000,
        expectedIncomeMinor: 800_000,
      },
      updatedAt: "2026-08-10T01:00:00.000Z",
    };
    const api = apiClient(emptyResponse({
      changes: [{
        seq: "9",
        entityType: "settings",
        entityId: "primary",
        version: 1,
        payload: remoteSettings,
      }],
      nextCursor: "9",
    }));

    await syncNow(database, api);

    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [],
    }), 1);
    expect((await database.settings.get("primary"))?.payCycle).toMatchObject({
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 25_000,
    });
    expect((await database.settings.get("primary"))?.incomeForecast).toMatchObject({
      targetPaydayDateKey: "2026-09-10",
      minimumIncomeMinor: 500_000,
      expectedIncomeMinor: 800_000,
    });
    expect(await database.syncState.get("primary")).toMatchObject({
      cursor: "9",
      syncProtocolVersion: SYNC_SCHEMA_VERSION,
    });
    expect(await database.syncState.get("primary")).not.toHaveProperty(
      "syncProtocolRefreshPending",
    );
  });

  it("claims a legacy salary during the v4 refresh and writes it back on the next round", async () => {
    await linkSyncAccount(session(), true, database);
    const legacyState = (await database.syncState.get("primary"))!;
    legacyState.syncProtocolVersion = 3;
    legacyState.cursor = "8";
    await database.syncState.put(legacyState);
    await database.entitySyncState.put({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      serverVersion: 1,
      status: "clean",
      updatedAt: "2026-08-09T00:00:00.000Z",
    });
    const remoteSettings = {
      ...(await database.settings.get("primary"))!,
      payCycle: { paydayDay: 10, cycleEndBalanceGoalMinor: 25_000 },
      incomeForecast: {
        id: "legacy-income-2026-08-10",
        targetPaydayDateKey: "2026-08-10",
        minimumIncomeMinor: 0,
        expectedIncomeMinor: 700_000,
      },
      updatedAt: "2026-08-09T01:00:00.000Z",
    };
    const api = apiClient(emptyResponse());
    vi.mocked(api.sync).mockImplementation(async (request) => {
      if (request.mutations.length === 0) {
        return emptyResponse({
          changes: [{
            seq: "9",
            entityType: "settings",
            entityId: "primary",
            version: 2,
            payload: remoteSettings,
            claimLegacyIncomeForecast: true,
          }],
          nextCursor: "9",
        });
      }
      return emptyResponse({
        results: request.mutations.map((mutation) => ({
          id: mutation.id,
          status: "applied" as const,
          version: 3,
        })),
        nextCursor: "9",
      });
    });

    await syncNow(database, api);

    const requests = vi.mocked(api.sync).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ cursor: "0", mutations: [] });
    expect(requests[1].mutations[0]).toMatchObject({
      entityType: "settings",
      baseVersion: 2,
      payload: {
        payCycle: { paydayDay: 10 },
        incomeForecast: {
          targetPaydayDateKey: "2026-08-10",
          expectedIncomeMinor: 700_000,
        },
      },
    });
    expect(await database.syncOutbox.get("settings:primary")).toBeUndefined();
    expect(await database.syncState.get("primary")).toMatchObject({
      cursor: "9",
      syncProtocolVersion: SYNC_SCHEMA_VERSION,
    });
  });

  it("claims a legacy balance floor during the v6 refresh and writes the savings target back", async () => {
    await linkSyncAccount(session(), true, database);
    const legacyState = (await database.syncState.get("primary"))!;
    legacyState.syncProtocolVersion = 5;
    legacyState.cursor = "8";
    await database.syncState.put(legacyState);
    await database.entitySyncState.put({
      id: "settings:primary",
      entityType: "settings",
      entityId: "primary",
      serverVersion: 1,
      status: "clean",
      updatedAt: "2026-08-09T00:00:00.000Z",
    });
    const remoteSettings = {
      ...(await database.settings.get("primary"))!,
      payCycle: { paydayDay: 10, defaultSavingsTargetMinor: 0 },
      savingsTargetNeedsReview: true as const,
      updatedAt: "2026-08-09T01:00:00.000Z",
    };
    const api = apiClient(emptyResponse());
    vi.mocked(api.sync).mockImplementation(async (request) => {
      if (request.mutations.length === 0) {
        return emptyResponse({
          changes: [{
            seq: "9",
            entityType: "settings",
            entityId: "primary",
            version: 2,
            payload: remoteSettings,
            claimLegacySavingsTarget: true,
          }],
          nextCursor: "9",
        });
      }
      return emptyResponse({
        results: request.mutations.map((mutation) => ({
          id: mutation.id,
          status: "applied" as const,
          version: 3,
        })),
        nextCursor: "9",
      });
    });

    await syncNow(database, api);

    const requests = vi.mocked(api.sync).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ cursor: "0", mutations: [] });
    expect(requests[1].mutations[0]).toMatchObject({
      entityType: "settings",
      baseVersion: 2,
      payload: {
        payCycle: { paydayDay: 10 },
      },
    });
    expect(requests[1].mutations[0].payload).not.toHaveProperty("savingsTargetNeedsReview");
    expect(await database.syncOutbox.get("settings:primary")).toBeUndefined();
    expect(await database.settings.get("primary")).toMatchObject({
      payCycle: { paydayDay: 10, defaultSavingsTargetMinor: 0 },
      savingsTargetNeedsReview: true,
    });
  });

  it("sends explicit nulls for v7 settings cleared during conflict resolution", async () => {
    await linkSyncAccount(session(), true, database);
    await setInitialBalance(1, database);
    const queued = (await database.syncOutbox.get("settings:primary"))!;
    queued.clearSavingsGoal = true;
    queued.clearLastExpectedIncomeMinor = true;
    queued.clearSavingsGoalNeedsSetup = true;
    await database.syncOutbox.put(queued);
    const api = apiClient(emptyResponse({
      results: [{ id: queued.id, status: "applied", version: 1 }],
      nextCursor: "1",
    }));

    await syncNow(database, api);

    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [expect.objectContaining({
        entityType: "settings",
        payload: expect.objectContaining({
          savingsGoal: null,
          lastExpectedIncomeMinor: null,
          savingsGoalNeedsSetup: null,
        }),
      })],
    }), 1);
  });

  it("caches a conflicting cloud screenshot so using the cloud version is complete", async () => {
    await linkSyncAccount(session(), true, database);
    const local = await createEntry(draft(), database);
    const queued = (await database.syncOutbox.get(`entry:${local.id}`))!;
    const remote: LedgerEntry = {
      ...local,
      note: "",
      attachmentId: "attachment_cloud",
      updatedAt: "2026-07-30T13:00:00.000Z",
    };
    const conflict = {
      seq: "1",
      entityType: "entry" as const,
      entityId: local.id,
      version: 1,
      payload: remote,
    };
    const api = apiClient(emptyResponse({
      results: [{ id: queued.id, status: "conflict", remote: conflict }],
    }));
    const blob = new Blob(["cloud"], { type: "image/jpeg" });
    vi.mocked(api.getAttachment).mockResolvedValue({
      blob,
      entryId: local.id,
      mimeType: blob.type,
      size: blob.size,
      width: 30,
      height: 20,
    });

    await syncNow(database, api);
    expect(await database.attachments.get(remote.attachmentId!)).toBeDefined();
    expect((await database.entries.get(local.id))?.note).toBe("local");

    await resolveSyncConflict("entry", local.id, "use-cloud", database);
    expect(await database.entries.get(local.id)).toEqual(remote);
    expect(await database.attachments.get(remote.attachmentId!)).toMatchObject({
      entryId: local.id,
      width: 30,
    });
  });

  it("rejects a session for another account before sending local ledger data", async () => {
    await linkSyncAccount(session(), true, database);
    await createEntry(draft(), database);
    const api = apiClient(emptyResponse(), session("account-2"));

    await expect(syncNow(database, api)).rejects.toMatchObject({ code: "account-mismatch" });
    expect(api.sync).not.toHaveBeenCalled();
    expect(await database.syncOutbox.count()).toBe(1);
  });

  it("rejects a changed cloud generation before sending entries or attachments", async () => {
    await linkSyncAccount(session(), true, database);
    await createEntry(draft(processedImage()), database);
    const api = apiClient(emptyResponse(), session("account-1", 2));

    await expect(syncNow(database, api)).rejects.toBeInstanceOf(
      SyncGenerationChangedError,
    );
    expect(api.putAttachment).not.toHaveBeenCalled();
    expect(api.sync).not.toHaveBeenCalled();
    expect(await database.syncOutbox.count()).toBe(1);
  });

  it("does not commit a response after the local link switches generation", async () => {
    await linkSyncAccount(session(), true, database);
    const entry = await createEntry(draft(), database);
    const queued = (await database.syncOutbox.get(`entry:${entry.id}`))!;
    const response = emptyResponse({
      results: [{ id: queued.id, status: "applied", version: 1 }],
      nextCursor: "1",
    });
    const api = apiClient(response);
    vi.mocked(api.sync).mockImplementation(async () => {
      await database.syncState.update("primary", { generation: 2 });
      return response;
    });

    await expect(syncNow(database, api)).rejects.toMatchObject({
      code: "sync-generation-mismatch",
    });
    await expect(database.syncOutbox.get(`entry:${entry.id}`)).resolves.toEqual(queued);
  });

  it("does not report success when the bounded pass still has remote changes", async () => {
    await linkSyncAccount(session(), false, database);
    const api = apiClient(emptyResponse());
    vi.mocked(api.sync).mockImplementation(async (request) => ({
      ...emptyResponse(),
      nextCursor: String(Number(request.cursor) + 1),
      hasMore: true,
    }));

    await expect(syncNow(database, api)).rejects.toBeInstanceOf(SyncIncompleteError);
    expect(api.sync).toHaveBeenCalledTimes(10);
    expect((await database.syncState.get("primary"))?.cursor).toBe("10");
  });
});
