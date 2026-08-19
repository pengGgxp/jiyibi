import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LedgerEntry, RecoveryAllocation, SavingsEvent } from "../domain/types";
import { SyncApiError, createSyncApiClient, type SyncFetch } from "./api";
import {
  API_SCHEMA_VERSION,
  SYNC_SCHEMA_VERSION,
  type SessionResponse,
  type SyncResponse,
} from "./contracts";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "entry-1",
    amountMinor: -1_200,
    note: "Lunch",
    occurredAt: "2026-07-30T04:00:00.000Z",
    localDateKey: "2026-07-30",
    localMonthKey: "2026-07",
    timezoneOffsetMinutes: -480,
    treatment: "ordinary_expense",
    confirmationStatus: "not_needed",
    createdAt: "2026-07-30T04:00:00.000Z",
    updatedAt: "2026-07-30T04:00:00.000Z",
    ...overrides,
  };
}

function allocation(overrides: Partial<RecoveryAllocation> = {}): RecoveryAllocation {
  return {
    id: "recovery-1",
    refundEntryId: "entry-refund",
    expenseEntryId: "entry-expense",
    amountMinor: 500,
    createdAt: "2026-07-30T05:00:00.000Z",
    updatedAt: "2026-07-30T05:00:00.000Z",
    ...overrides,
  };
}

function session(overrides: Partial<SessionResponse["cloud"]> = {}): SessionResponse {
  return {
    schemaVersion: API_SCHEMA_VERSION,
    user: { id: "user-1", email: "owner@example.test" },
    cloud: {
      syncStatus: "enabled",
      generation: 3,
      hasData: true,
      entryCount: 1,
      attachmentCount: 0,
      cursor: "7",
      ...overrides,
    },
  };
}

function syncResponse(): SyncResponse {
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    results: [{ id: "mutation-1", status: "applied", version: 2 }],
    changes: [
      {
        seq: "7",
        entityType: "entry",
        entityId: "entry-1",
        version: 2,
        payload: entry(),
      },
      {
        seq: "8",
        entityType: "settings",
        entityId: "primary",
        version: 1,
        payload: {
          id: "primary",
          currency: "CNY",
          initialBalanceMinor: 500,
          monthEndBalanceGoalMinor: 25_000,
          payCycle: {
            paydayDay: 10,
            defaultSavingsTargetMinor: 100_000,
          },
          incomeForecast: {
            id: "forecast-2026-08-10",
            targetPaydayDateKey: "2026-08-10",
            minimumIncomeMinor: 600_000,
            expectedIncomeMinor: 800_000,
          },
          schemaVersion: 1,
          updatedAt: "2026-07-30T05:00:00.000Z",
        },
      },
    ],
    nextCursor: "8",
    hasMore: false,
  };
}

function mockFetch(response?: Response): ReturnType<typeof vi.fn<SyncFetch>> {
  const fetcher = vi.fn<SyncFetch>();
  if (response) fetcher.mockResolvedValue(response);
  return fetcher;
}

describe("sync API client", () => {
  beforeAll(() => vi.stubGlobal("crypto", webcrypto));
  afterAll(() => vi.unstubAllGlobals());

  it("loads the authenticated session with same-origin credentials", async () => {
    const fetcher = mockFetch(jsonResponse(session()));

    await expect(createSyncApiClient(fetcher).getSession()).resolves.toEqual(session());
    expect(fetcher).toHaveBeenCalledWith("/api/session", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  });

  it("enables cloud sync only through the explicit account endpoint", async () => {
    const fetcher = mockFetch(jsonResponse({
      schemaVersion: API_SCHEMA_VERSION,
      syncStatus: "enabled",
      generation: 4,
    }));

    await expect(createSyncApiClient(fetcher).enableCloudSync(3)).resolves.toBe(4);
    expect(fetcher).toHaveBeenCalledWith("/api/account/enable", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation: "ENABLE", generation: 3 }),
    });
  });

  it("rejects an enable response for an unrelated generation", async () => {
    const fetcher = mockFetch(jsonResponse({
      schemaVersion: API_SCHEMA_VERSION,
      syncStatus: "enabled",
      generation: 9,
    }));

    await expect(createSyncApiClient(fetcher).enableCloudSync(3)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("continues cloud deletion until every attachment object and D1 row is removed", async () => {
    const fetcher = mockFetch();
    const wait = vi.fn(async () => undefined);
    fetcher
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: API_SCHEMA_VERSION,
        complete: false,
        deletedObjects: 50,
        remainingObjects: 2,
      }, { status: 202, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: API_SCHEMA_VERSION,
        complete: true,
        deletedObjects: 2,
        remainingObjects: 0,
      }));

    await expect(createSyncApiClient(fetcher, wait).deleteCloudData(3)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000);
    expect(fetcher).toHaveBeenLastCalledWith("/api/account", {
      method: "DELETE",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation: "DELETE", generation: 3 }),
    });
  });

  it("waits for an active upload lease instead of treating zero deleted objects as failure", async () => {
    const fetcher = mockFetch();
    const wait = vi.fn(async () => undefined);
    fetcher
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: API_SCHEMA_VERSION,
        complete: false,
        deletedObjects: 0,
        remainingObjects: 1,
      }, { status: 202, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: API_SCHEMA_VERSION,
        complete: true,
        deletedObjects: 0,
        remainingObjects: 0,
      }));

    await expect(createSyncApiClient(fetcher, wait).deleteCloudData(3)).resolves.toBeUndefined();
    expect(wait).toHaveBeenCalledWith(2_000);
  });

  it.each([401, 403])("classifies HTTP %s as unauthorized", async (status) => {
    const fetcher = mockFetch(new Response(null, { status }));

    const request = createSyncApiClient(fetcher).getSession();
    await expect(request).rejects.toBeInstanceOf(SyncApiError);
    await expect(request).rejects.toMatchObject({
      name: "SyncApiError",
      code: "unauthorized",
    });
  });

  it("classifies fetch failures and non-auth HTTP failures as network errors", async () => {
    const fetchFailure = mockFetch();
    fetchFailure.mockRejectedValue(new TypeError("offline"));
    const serviceFailure = mockFetch(new Response(null, { status: 503 }));

    await expect(createSyncApiClient(fetchFailure).getSession()).rejects.toMatchObject({
      code: "network",
    });
    await expect(createSyncApiClient(serviceFailure).getSession()).rejects.toMatchObject({
      code: "network",
    });
  });

  it("classifies HTTP 507 as a cloud attachment quota error", async () => {
    const fetcher = mockFetch(new Response(null, { status: 507 }));

    await expect(createSyncApiClient(fetcher).getSession()).rejects.toMatchObject({
      code: "quota",
    });
  });

  it.each([
    "not-json",
    JSON.stringify({ ...session(), unexpected: true }),
    JSON.stringify(session({ entryCount: -1 })),
    JSON.stringify(session({ generation: 0 })),
    JSON.stringify({
      ...session(),
      cloud: { ...session().cloud, generation: undefined },
    }),
  ])("rejects a malformed or structurally invalid session response", async (body) => {
    const fetcher = mockFetch(new Response(body));

    await expect(createSyncApiClient(fetcher).getSession()).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it.each([
    "stale_cloud_generation",
    "cloud_sync_disabled",
    "account_deletion_in_progress",
  ] as const)("preserves the cloud state error code %s", async (code) => {
    const fetcher = mockFetch(jsonResponse({
      error: { code, message: "state changed" },
    }, { status: 409 }));

    await expect(createSyncApiClient(fetcher).sync({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [],
    }, 3)).rejects.toMatchObject({ code });
  });

  it("posts mutations and validates all nested sync result variants", async () => {
    const response = syncResponse();
    response.results.push({
      id: "mutation-2",
      status: "conflict",
      remote: response.changes[0],
    });
    const fetcher = mockFetch(jsonResponse(response));
    const request = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "6",
      mutations: [
        {
          id: "mutation-1",
          entityType: "entry" as const,
          entityId: "entry-1",
          baseVersion: 1,
          payload: entry(),
        },
        {
          id: "mutation-2",
          entityType: "entry" as const,
          entityId: "entry-1",
          baseVersion: 1,
          payload: entry({ note: "second edit" }),
        },
      ],
    };

    await expect(createSyncApiClient(fetcher).sync(request, 3)).resolves.toEqual(response);
    expect(fetcher).toHaveBeenCalledWith("/api/sync", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Jiyibi-Sync-Generation": "3",
      },
      body: JSON.stringify(request),
    });
  });

  it("accepts recovery allocation changes and conflicts", async () => {
    const response = syncResponse();
    const change = {
      seq: "9",
      entityType: "recoveryAllocation" as const,
      entityId: "recovery-1",
      version: 2,
      payload: allocation(),
    };
    response.results = [{ id: "mutation-recovery", status: "conflict", remote: change }];
    response.changes = [change];
    response.nextCursor = "9";
    const fetcher = mockFetch(jsonResponse(response));
    const request = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "8",
      mutations: [{
        id: "mutation-recovery",
        entityType: "recoveryAllocation" as const,
        entityId: "recovery-1",
        baseVersion: 1,
        payload: allocation({ amountMinor: 400 }),
      }],
    };

    await expect(createSyncApiClient(fetcher).sync(request, 3)).resolves.toEqual(response);
  });

  it.each([
    allocation({ id: "different-id" }),
    allocation({ amountMinor: 0 }),
    allocation({ refundEntryId: "same", expenseEntryId: "same" }),
    allocation({ updatedAt: "2026-07-30T04:59:59.000Z" }),
    { ...allocation(), unexpected: true },
  ])("rejects an invalid recovery allocation change: %o", async (payload) => {
    const response = syncResponse() as unknown as Record<string, unknown>;
    response.results = [];
    response.changes = [{
      seq: "9",
      entityType: "recoveryAllocation",
      entityId: "recovery-1",
      version: 1,
      payload,
    }];
    const fetcher = mockFetch(jsonResponse(response));

    await expect(createSyncApiClient(fetcher).sync({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [],
    }, 3)).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("preserves upgrade_required without treating it as a network failure", async () => {
    const fetcher = mockFetch(jsonResponse({
      error: { code: "upgrade_required", message: "upgrade" },
    }, { status: 409 }));

    await expect(createSyncApiClient(fetcher).sync({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [],
    }, 3)).rejects.toMatchObject({ code: "upgrade_required" });
  });

  it("accepts legacy settings changes without optional planning fields", async () => {
    const response = syncResponse();
    response.results = [];
    const settings = response.changes[1];
    if (settings.entityType !== "settings") throw new Error("Expected settings change");
    delete settings.payload.monthEndBalanceGoalMinor;
    delete settings.payload.payCycle;
    delete settings.payload.incomeForecast;
    const fetcher = mockFetch(jsonResponse(response));

    await expect(createSyncApiClient(fetcher).sync({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [],
    }, 3)).resolves.toEqual(response);
  });

  it("normalizes a legacy salary hint into a dated one-time income forecast", async () => {
    const response = syncResponse() as unknown as Record<string, unknown>;
    response.results = [];
    const changes = response.changes as Array<Record<string, unknown>>;
    const settings = changes[1].payload as Record<string, unknown>;
    delete settings.incomeForecast;
    settings._legacyMonthlySalaryMinor = 700_000;
    const fetcher = mockFetch(jsonResponse(response));

    const result = await createSyncApiClient(
      fetcher,
      undefined,
      () => new Date(2026, 7, 9, 12),
    ).sync({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [],
    }, 3);

    const settingsChange = result.changes[1];
    expect(settingsChange).toMatchObject({
      entityType: "settings",
      claimLegacyIncomeForecast: true,
      payload: {
        payCycle: { paydayDay: 10, defaultSavingsTargetMinor: 100_000 },
        incomeForecast: {
          id: "legacy-income-2026-08-10",
          targetPaydayDateKey: "2026-08-10",
          minimumIncomeMinor: 0,
          expectedIncomeMinor: 700_000,
        },
      },
    });
    expect(settingsChange.payload).not.toHaveProperty("_legacyMonthlySalaryMinor");
  });

  it.each([
    [25_000, 25_000, false],
    [-25_000, 0, true],
  ])(
    "normalizes and claims a legacy balance floor: %s",
    async (legacyTarget, expectedTarget, needsReview) => {
      const response = syncResponse() as unknown as Record<string, unknown>;
      response.results = [];
      const changes = response.changes as Array<Record<string, unknown>>;
      const settings = changes[1].payload as Record<string, unknown>;
      settings.payCycle = {
        paydayDay: 10,
        cycleEndBalanceGoalMinor: legacyTarget,
      };
      const fetcher = mockFetch(jsonResponse(response));

      const result = await createSyncApiClient(fetcher).sync({
        schemaVersion: SYNC_SCHEMA_VERSION,
        cursor: "0",
        mutations: [],
      }, 3);

      const settingsChange = result.changes[1];
      if (settingsChange.entityType !== "settings") {
        throw new Error("Expected settings change");
      }
      expect(settingsChange).toMatchObject({
        entityType: "settings",
        claimLegacySavingsTarget: true,
        payload: {
          payCycle: { paydayDay: 10, defaultSavingsTargetMinor: expectedTarget },
        },
      });
      if (needsReview) {
        expect(settingsChange.payload).toHaveProperty("savingsTargetNeedsReview", true);
      } else {
        expect(settingsChange.payload).not.toHaveProperty("savingsTargetNeedsReview");
      }
      expect(settingsChange.payload.payCycle).not.toHaveProperty("cycleEndBalanceGoalMinor");
    },
  );

  it.each([0, 1.5, 9_000_000_000_000_001])(
    "rejects an invalid legacy salary hint: %s",
    async (legacySalary) => {
      const response = syncResponse() as unknown as Record<string, unknown>;
      response.results = [];
      const changes = response.changes as Array<Record<string, unknown>>;
      const settings = changes[1].payload as Record<string, unknown>;
      delete settings.incomeForecast;
      settings._legacyMonthlySalaryMinor = legacySalary;
      const fetcher = mockFetch(jsonResponse(response));

      await expect(createSyncApiClient(fetcher).sync({
        schemaVersion: SYNC_SCHEMA_VERSION,
        cursor: "0",
        mutations: [],
      }, 3)).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it("sends and receives planning settings without changing integer values", async () => {
    const settingsChange = syncResponse().changes[1];
    if (settingsChange.entityType !== "settings") throw new Error("Expected settings change");
    const request = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "7",
      mutations: [{
        id: "mutation-settings-goal",
        entityType: "settings" as const,
        entityId: "primary",
        baseVersion: 0,
        payload: settingsChange.payload,
      }],
    };
    const response: SyncResponse = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      results: [{ id: "mutation-settings-goal", status: "applied", version: 1 }],
      changes: [settingsChange],
      nextCursor: "8",
      hasMore: false,
    };
    const fetcher = mockFetch(jsonResponse(response));

    await expect(createSyncApiClient(fetcher).sync(request, 3)).resolves.toEqual(response);
    const init = fetcher.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      mutations: [{ payload: {
        monthEndBalanceGoalMinor: 25_000,
        payCycle: {
          paydayDay: 10,
          defaultSavingsTargetMinor: 100_000,
        },
        incomeForecast: {
          targetPaydayDateKey: "2026-08-10",
          minimumIncomeMinor: 600_000,
          expectedIncomeMinor: 800_000,
        },
      } }],
    });
  });

  it.each([
    null,
    { paydayDay: 0, cycleEndBalanceGoalMinor: 0 },
    { paydayDay: 10, cycleEndBalanceGoalMinor: 1.5 },
    { paydayDay: 10 },
    { paydayDay: 10, monthlySalaryMinor: 1, cycleEndBalanceGoalMinor: 0 },
  ])("rejects an invalid pay cycle in a settings change: %o", async (payCycle) => {
    const response = syncResponse() as unknown as Record<string, unknown>;
    const changes = response.changes as Array<Record<string, unknown>>;
    const settings = changes[1].payload as Record<string, unknown>;
    settings.payCycle = payCycle;
    const fetcher = mockFetch(jsonResponse(response));

    await expect(createSyncApiClient(fetcher).sync({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [],
    }, 3)).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("accepts a version-six retained-money change and rejects an invalid amount", async () => {
    const event: SavingsEvent = {
      id: "savings-1",
      kind: "reserve",
      amountMinor: 50_000,
      note: "本周期留存",
      occurredAt: "2026-07-30T04:00:00.000Z",
      localDateKey: "2026-07-30",
      localMonthKey: "2026-07",
      timezoneOffsetMinutes: -480,
      createdAt: "2026-07-30T04:00:00.000Z",
      updatedAt: "2026-07-30T04:00:00.000Z",
    };
    const response = syncResponse();
    response.results = [];
    response.changes.push({
      seq: "9",
      entityType: "savingsEvent",
      entityId: event.id,
      version: 1,
      payload: event,
    });
    response.nextCursor = "9";

    await expect(createSyncApiClient(mockFetch(jsonResponse(response))).sync({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [],
    }, 3)).resolves.toMatchObject({
      changes: expect.arrayContaining([
        expect.objectContaining({ entityType: "savingsEvent", payload: event }),
      ]),
    });

    event.amountMinor = 0;
    await expect(createSyncApiClient(mockFetch(jsonResponse(response))).sync({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [],
    }, 3)).rejects.toMatchObject({ code: "invalid-response" });
  });

  it.each([
    null,
    {
      id: "forecast-1",
      targetPaydayDateKey: "2026-02-30",
      minimumIncomeMinor: 1,
      expectedIncomeMinor: 2,
    },
    {
      id: "forecast-1",
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 3,
      expectedIncomeMinor: 2,
    },
    {
      id: "forecast-1",
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: -1,
      expectedIncomeMinor: 2,
    },
    {
      id: "forecast with spaces",
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 1,
      expectedIncomeMinor: 2,
    },
    {
      id: "f".repeat(129),
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 1,
      expectedIncomeMinor: 2,
    },
  ])("rejects an invalid income forecast in a settings change: %o", async (forecast) => {
    const response = syncResponse() as unknown as Record<string, unknown>;
    const changes = response.changes as Array<Record<string, unknown>>;
    const settings = changes[1].payload as Record<string, unknown>;
    settings.incomeForecast = forecast;
    const fetcher = mockFetch(jsonResponse(response));

    await expect(createSyncApiClient(fetcher).sync({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [],
    }, 3)).rejects.toMatchObject({ code: "invalid-response" });
  });

  it.each([null, 1.5, 9_000_000_000_000_001])(
    "rejects an invalid monthly goal in a settings change: %s",
    async (goal) => {
      const response = syncResponse() as unknown as Record<string, unknown>;
      const changes = response.changes as Array<Record<string, unknown>>;
      const settings = changes[1].payload as Record<string, unknown>;
      settings.monthEndBalanceGoalMinor = goal;
      const fetcher = mockFetch(jsonResponse(response));

      await expect(createSyncApiClient(fetcher).sync({
        schemaVersion: SYNC_SCHEMA_VERSION,
        cursor: "0",
        mutations: [],
      }, 3)).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it("rejects invalid nested changes instead of trusting a type assertion", async () => {
    const mismatchedEntity = syncResponse() as unknown as Record<string, unknown>;
    const changes = mismatchedEntity.changes as Array<Record<string, unknown>>;
    changes[0] = { ...changes[0], entityId: "another-entry" };
    const fetcher = mockFetch(jsonResponse(mismatchedEntity));

    await expect(
      createSyncApiClient(fetcher).sync({
        schemaVersion: SYNC_SCHEMA_VERSION,
        cursor: "0",
        mutations: [],
      }, 3),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects missing, duplicate, or cross-entity mutation results", async () => {
    const request = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: "0",
      mutations: [{
        id: "mutation-1",
        entityType: "entry" as const,
        entityId: "entry-1",
        baseVersion: 0,
        payload: entry(),
      }],
    };
    const missing = syncResponse();
    missing.results = [];
    const duplicate = syncResponse();
    duplicate.results.push(duplicate.results[0]);
    const mismatched = syncResponse();
    mismatched.results = [{
      id: "mutation-1",
      status: "conflict",
      remote: {
        seq: "9",
        entityType: "entry",
        entityId: "entry-2",
        version: 1,
        payload: entry({ id: "entry-2" }),
      },
    }];

    for (const response of [missing, duplicate, mismatched]) {
      const fetcher = mockFetch(jsonResponse(response));
      await expect(createSyncApiClient(fetcher).sync(request, 3)).rejects.toMatchObject({
        code: "invalid-response",
      });
    }
  });

  it("uploads and downloads encoded attachment paths without storing a token", async () => {
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    const attachment = {
      id: "attachment_receipt/one",
      entryId: "entry_1",
      blob: image,
      mimeType: image.type,
      size: image.size,
      width: 2,
      height: 1,
      createdAt: "2026-07-30T04:00:00.000Z",
    };
    const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const fetcher = mockFetch(
      jsonResponse(
        {
          schemaVersion: API_SCHEMA_VERSION,
          attachment: {
            id: attachment.id,
            entryId: attachment.entryId,
            mimeType: attachment.mimeType,
            size: attachment.size,
            width: attachment.width,
            height: attachment.height,
            sha256,
          },
        },
        { status: 201 },
      ),
    );
    const client = createSyncApiClient(fetcher);

    await client.putAttachment(attachment, 3);
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/attachments/attachment_receipt%2Fone", {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "Content-Type": "image/jpeg",
        "X-Content-Sha256": sha256,
        "X-Entry-Id": "entry_1",
        "X-Height": "1",
        "X-Jiyibi-Sync-Generation": "3",
        "X-Width": "2",
      },
      body: image,
    });

    fetcher.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Length": "3",
          "Content-Type": image.type,
          "X-Content-Sha256": sha256,
          "X-Entry-Id": "entry_1",
          "X-Height": "1",
          "X-Width": "2",
        },
      }),
    );
    const downloaded = await client.getAttachment("attachment_receipt/one", 3);
    expect(downloaded).toMatchObject({
      entryId: "entry_1",
      mimeType: "image/jpeg",
      size: 3,
      width: 2,
      height: 1,
    });
    expect(downloaded?.blob.size).toBe(3);
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/attachments/attachment_receipt%2Fone", {
      method: "GET",
      credentials: "same-origin",
      headers: {
        Accept: "image/*",
        "X-Jiyibi-Sync-Generation": "3",
      },
    });
  });

  it("returns undefined only when a cloud attachment is absent", async () => {
    const fetcher = mockFetch(new Response(null, { status: 404 }));

    await expect(
      createSyncApiClient(fetcher).getAttachment("missing", 3),
    ).resolves.toBeUndefined();
  });

  it("retries a KV attachment with bounded backoff for about one minute while it propagates", async () => {
    const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const fetcher = mockFetch();
    const waited: number[] = [];
    const wait = vi.fn(async (milliseconds: number) => {
      waited.push(milliseconds);
    });
    let requestCount = 0;
    fetcher.mockImplementation(async () => {
      requestCount += 1;
      if (requestCount <= 9) {
        return jsonResponse({
          error: { code: "attachment_replication_pending", message: "retry" },
        }, { status: 503, headers: { "Retry-After": "2" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Length": "3",
          "Content-Type": "image/jpeg",
          "X-Content-Sha256": sha256,
          "X-Entry-Id": "entry_1",
          "X-Height": "1",
          "X-Width": "2",
        },
      });
    });

    await expect(
      createSyncApiClient(fetcher, wait).getAttachment("attachment_1", 3),
    ).resolves.toMatchObject({ entryId: "entry_1", size: 3 });
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(waited).toEqual([2_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000, 4_000]);
    expect(waited.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(60_000);
  });

  it("rejects incomplete or dishonest attachment metadata", async () => {
    const incomplete = mockFetch(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } }),
    );
    const dishonest = mockFetch(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Length": "4",
          "Content-Type": "image/jpeg",
          "X-Content-Sha256": "0".repeat(64),
          "X-Entry-Id": "entry_1",
          "X-Height": "1",
          "X-Width": "2",
        },
      }),
    );

    await expect(createSyncApiClient(incomplete).getAttachment("attachment_1", 3)).rejects.toMatchObject({
      code: "invalid-response",
    });
    await expect(createSyncApiClient(dishonest).getAttachment("attachment_1", 3)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });
});
