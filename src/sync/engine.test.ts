import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryDraft, LedgerEntry, ProcessedImage } from "../domain/types";
import {
  clearIncomeForecast,
  LedgerDatabase,
  createEntry,
  linkSyncAccount,
  resolveSyncConflict,
  setIncomeForecast,
  setMonthEndBalanceGoal,
  setPayCyclePlan,
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

  it("sends an explicit null only when the user clears the monthly goal", async () => {
    await linkSyncAccount(session(), true, database);
    await setMonthEndBalanceGoal(50_000, database);
    await setMonthEndBalanceGoal(undefined, database);
    const queued = (await database.syncOutbox.get("settings:primary"))!;
    const api = apiClient(emptyResponse({
      results: [{ id: queued.id, status: "applied", version: 1 }],
    }));

    await syncNow(database, api);

    expect(api.sync).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 4,
      mutations: [expect.objectContaining({
        entityType: "settings",
        payload: expect.objectContaining({ monthEndBalanceGoalMinor: null }),
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
      schemaVersion: 4,
      mutations: [expect.objectContaining({
        entityType: "settings",
        payload: expect.objectContaining({
          monthEndBalanceGoalMinor: null,
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
      schemaVersion: 4,
      mutations: [expect.objectContaining({
        entityType: "settings",
        payload: expect.objectContaining({
          payCycle: {
            paydayDay: 10,
            cycleEndBalanceGoalMinor: 100_000,
          },
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
      schemaVersion: 4,
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
      syncProtocolVersion: 4,
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
        payCycle: { paydayDay: 10, cycleEndBalanceGoalMinor: 25_000 },
        incomeForecast: {
          targetPaydayDateKey: "2026-08-10",
          minimumIncomeMinor: 0,
          expectedIncomeMinor: 700_000,
        },
      },
    });
    expect(await database.syncOutbox.get("settings:primary")).toBeUndefined();
    expect(await database.syncState.get("primary")).toMatchObject({
      cursor: "9",
      syncProtocolVersion: 4,
    });
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
