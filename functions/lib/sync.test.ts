import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppSettingsPayload, LedgerEntryPayload, SyncMutation } from "./types";
import { minimizeDeletedEntry, synchronize, syncMutationHash } from "./sync";

function settingsMutation(overrides: Partial<SyncMutation> = {}): SyncMutation {
  return {
    id: "mutation_settings_1",
    entityType: "settings",
    entityId: "primary",
    baseVersion: 0,
    payload: {
      id: "primary",
      currency: "CNY",
      initialBalanceMinor: 500,
      schemaVersion: 1,
      updatedAt: "2026-07-30T12:00:00.000Z",
    },
    ...overrides,
  };
}

describe("sync mutation receipts", () => {
  beforeAll(() => vi.stubGlobal("crypto", webcrypto));
  afterAll(() => vi.unstubAllGlobals());

  it("is stable across object key order and binds the base version and payload", async () => {
    const original = settingsMutation();
    const reordered = settingsMutation({
      payload: {
        updatedAt: "2026-07-30T12:00:00.000Z",
        schemaVersion: 1,
        initialBalanceMinor: 500,
        currency: "CNY",
        id: "primary",
      },
    });

    await expect(syncMutationHash(reordered)).resolves.toBe(await syncMutationHash(original));
    await expect(syncMutationHash(settingsMutation({ baseVersion: 1 })))
      .resolves.not.toBe(await syncMutationHash(original));
    await expect(syncMutationHash(settingsMutation({
      payload: {
        ...(original.payload as AppSettingsPayload),
        initialBalanceMinor: 501,
      },
    }))).resolves.not.toBe(await syncMutationHash(original));
  });
});

describe("deleted entry minimization", () => {
  it("keeps only a valid deletion tombstone and removes original ledger details", () => {
    const entry: LedgerEntryPayload = {
      id: "entry_private_1",
      amountMinor: -987_654,
      note: "private merchant and memo",
      occurredAt: "2026-06-01T02:00:00.000Z",
      localDateKey: "2026-06-01",
      localMonthKey: "2026-06",
      timezoneOffsetMinutes: -480,
      attachmentId: "attachment_private_1",
      createdAt: "2026-06-01T02:00:00.000Z",
      updatedAt: "2026-07-30T12:00:00.000Z",
      deletedAt: "2026-07-30T12:00:00.000Z",
    };

    expect(minimizeDeletedEntry(entry)).toEqual({
      id: entry.id,
      amountMinor: 1,
      note: "",
      occurredAt: entry.deletedAt,
      localDateKey: "2026-07-30",
      localMonthKey: "2026-07",
      timezoneOffsetMinutes: 0,
      createdAt: entry.deletedAt,
      updatedAt: entry.deletedAt,
      deletedAt: entry.deletedAt,
    });
  });
});

describe("sync privacy cleanup", () => {
  it("compacts superseded payloads before a KV cleanup failure", async () => {
    const calls: string[] = [];
    const db = {
      prepare: (query: string) => ({
        bind() {
          return this;
        },
        async run() {
          if (query.includes("UPDATE sync_changes")) calls.push("compact");
          if (query.includes("INSERT INTO attachment_cleanup")) calls.push("enqueue");
          return { success: true };
        },
        async all() {
          if (query.includes("FROM attachment_cleanup q")) {
            return {
              results: [{
                attachment_id: "attachment_1",
                r2_key: "user/attachment_1/old.jpg",
                is_referenced: 0,
              }],
            };
          }
          return { results: [] };
        },
      }),
      async batch() {
        calls.push("remove-metadata");
        return [{ meta: { changes: 1 } }];
      },
    } as unknown as D1Database;
    const attachments = {
      async delete() {
        calls.push("delete");
        throw new Error("KV unavailable");
      },
    } as unknown as KVNamespace;

    await expect(synchronize(
      {
        DB: db,
        ATTACHMENTS: attachments,
        TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        POLICY_AUD: "test-aud",
      },
      "user_1",
      1,
      { schemaVersion: 1, cursor: "0", mutations: [] },
    )).rejects.toThrow("KV unavailable");

    expect(calls).toEqual([
      "compact",
      "enqueue",
      "remove-metadata",
      "delete",
    ]);
  });
});
