import { describe, expect, it } from "vitest";
import {
  cleanupPendingAttachments,
  orphanAttachmentCutoff,
  partitionCleanupJobs,
  type AttachmentCleanupJob,
} from "./cleanup";

describe("partitionCleanupJobs", () => {
  it("schedules a replaced attachment for KV and metadata cleanup", () => {
    const replaced: AttachmentCleanupJob = {
      attachment_id: "attachment_old",
      r2_key: "user/attachment_old.jpg",
      is_referenced: 0,
    };
    expect(partitionCleanupJobs([replaced])).toEqual({
      deleteObjects: [replaced],
      clearOnly: [],
    });
  });

  it("does not delete an object that is referenced again", () => {
    const referenced: AttachmentCleanupJob = {
      attachment_id: "attachment_kept",
      r2_key: "user/attachment_kept.jpg",
      is_referenced: 1,
    };
    expect(partitionCleanupJobs([referenced])).toEqual({
      deleteObjects: [],
      clearOnly: [referenced],
    });
  });

  it("keeps a 24 hour retry window before orphan collection", () => {
    expect(orphanAttachmentCutoff(new Date("2026-07-30T12:00:00.000Z")))
      .toBe("2026-07-29T12:00:00.000Z");
  });

  it("removes unreferenced metadata before attempting KV deletion", async () => {
    const calls: string[] = [];
    const db = {
      prepare: (query: string) => ({
        bind() {
          return this;
        },
        async run() {
          if (query.includes("INSERT INTO attachment_cleanup")) calls.push("enqueue");
          return { success: true };
        },
        async all() {
          if (query.includes("FROM cloud_attachment_cleanup q")) {
            calls.push("read-cloud-jobs");
            return { results: [] };
          }
          calls.push("read-jobs");
          return {
            results: [{
              attachment_id: "attachment_1",
              r2_key: "user/attachment_1/old.jpg",
              is_referenced: 0,
            }],
          };
        },
      }),
      async batch() {
        calls.push("remove-metadata");
        return [{ meta: { changes: 1 } }];
      },
    } as unknown as D1Database;
    const attachments = {
      async delete() {
        calls.push("delete-object");
        throw new Error("KV unavailable");
      },
    } as unknown as KVNamespace;

    await expect(cleanupPendingAttachments(
      {
        DB: db,
        ATTACHMENTS: attachments,
        TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        POLICY_AUD: "test-aud",
      },
      "user_1",
      1,
    )).rejects.toThrow("KV unavailable");

    expect(calls).toEqual([
      "read-cloud-jobs",
      "enqueue",
      "read-jobs",
      "remove-metadata",
      "delete-object",
    ]);
  });

  it("does not delete KV when the conditional metadata delete loses a reference race", async () => {
    const calls: string[] = [];
    const db = {
      prepare: (query: string) => ({
        bind() {
          return this;
        },
        async first() {
          if (query.includes("AS metadata_exists")) {
            return { metadata_exists: 1, is_referenced: 1 };
          }
          return null;
        },
        async run() {
          return { success: true };
        },
        async all() {
          if (query.includes("FROM cloud_attachment_cleanup q")) return { results: [] };
          return {
            results: [{
              attachment_id: "attachment_1",
              r2_key: "user/attachment_1/current.jpg",
              is_referenced: 0,
            }],
          };
        },
      }),
      async batch() {
        calls.push("conditional-delete");
        return [{ meta: { changes: 0 } }];
      },
    } as unknown as D1Database;
    const attachments = {
      async delete() {
        calls.push("delete-object");
      },
    } as unknown as KVNamespace;

    await cleanupPendingAttachments(
      {
        DB: db,
        ATTACHMENTS: attachments,
        TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        POLICY_AUD: "test-aud",
      },
      "user_1",
      1,
    );

    expect(calls).toEqual(["conditional-delete"]);
  });

  it("retries KV when an earlier attempt already removed unreferenced metadata", async () => {
    const calls: string[] = [];
    let batchCall = 0;
    const db = {
      prepare: (query: string) => ({
        bind() {
          return this;
        },
        async first() {
          if (query.includes("AS metadata_exists")) {
            return { metadata_exists: 0, is_referenced: 0 };
          }
          return null;
        },
        async run() {
          return { success: true };
        },
        async all() {
          if (query.includes("FROM cloud_attachment_cleanup q")) return { results: [] };
          return {
            results: [{
              attachment_id: "attachment_1",
              r2_key: "user/attachment_1/retry.jpg",
              is_referenced: 0,
            }],
          };
        },
      }),
      async batch() {
        batchCall += 1;
        calls.push(batchCall === 1 ? "conditional-delete" : "clear-job");
        return batchCall === 1 ? [{ meta: { changes: 0 } }] : [];
      },
    } as unknown as D1Database;
    const attachments = {
      async delete() {
        calls.push("delete-object");
      },
    } as unknown as KVNamespace;

    await cleanupPendingAttachments(
      {
        DB: db,
        ATTACHMENTS: attachments,
        TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        POLICY_AUD: "test-aud",
      },
      "user_1",
      1,
    );

    expect(calls).toEqual([
      "conditional-delete",
      "delete-object",
      "clear-job",
    ]);
  });

  it("retains an independent stale-upload job when KV is unavailable", async () => {
    let cleared = false;
    const db = {
      prepare: (query: string) => ({
        bind() {
          return this;
        },
        async all() {
          if (query.includes("FROM cloud_attachment_cleanup q")) {
            return {
              results: [{
                account_generation: 2,
                attachment_id: "attachment_late",
                r2_key: "user_1/g2/attachment_late/late.jpg",
                is_referenced: 0,
              }],
            };
          }
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      }),
      async batch() {
        cleared = true;
        return [];
      },
    } as unknown as D1Database;
    const env = {
      DB: db,
      ATTACHMENTS: {
        async delete() {
          throw new Error("KV unavailable");
        },
      } as unknown as KVNamespace,
      TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      POLICY_AUD: "test-aud",
    };

    await expect(cleanupPendingAttachments(env, "user_1", 3))
      .rejects.toThrow("KV unavailable");
    expect(cleared).toBe(false);
  });
});
