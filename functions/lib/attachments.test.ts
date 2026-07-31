import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import {
  attachmentStoreWriteError,
  finalizeAttachmentUpload,
  getAttachment,
  parseJpegDimensions,
  putAttachment,
} from "./attachments";
import type { AuthenticatedUser, Env } from "./types";

function minimalJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

describe("parseJpegDimensions", () => {
  it("reads dimensions from a baseline JPEG SOF segment", () => {
    expect(parseJpegDimensions(minimalJpeg(640, 480))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("rejects a truncated JPEG", () => {
    expect(() => parseJpegDimensions(minimalJpeg(640, 480).slice(0, -2))).toThrowError(ApiError);
  });

  it("rejects a JPEG without a supported SOF segment", () => {
    expect(() => parseJpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toThrowError(
      "dimensions could not be read",
    );
  });
});

describe("attachmentStoreWriteError", () => {
  it("maps free-tier write limits to a recoverable quota response", () => {
    expect(attachmentStoreWriteError(new Error("KV PUT failed: 429 Too Many Requests")))
      .toMatchObject({ status: 507, code: "cloud_attachment_quota_exceeded" });
    expect(attachmentStoreWriteError(new Error("daily write quota exceeded")))
      .toMatchObject({ status: 507, code: "cloud_attachment_quota_exceeded" });
  });

  it("maps other KV failures to a temporary service response", () => {
    expect(attachmentStoreWriteError(new Error("KV unavailable")))
      .toMatchObject({ status: 503, code: "cloud_attachment_storage_unavailable" });
  });
});

describe("finalizeAttachmentUpload", () => {
  it("deletes a just-written KV object when account deletion blocks ready metadata", async () => {
    const deletedKeys: string[] = [];
    let cleanupQueued = false;
    const db = {
      prepare: (query: string) => ({
        bind() {
          return this;
        },
        async run() {
          if (query.includes("UPDATE attachments")) {
            throw new Error("stale_cloud_generation");
          }
          if (query.includes("INSERT INTO cloud_attachment_cleanup")) {
            cleanupQueued = true;
            return { success: true };
          }
          if (query.includes("DELETE FROM cloud_attachment_cleanup")) {
            cleanupQueued = false;
            return { success: true };
          }
          throw new Error(`Unexpected query: ${query}`);
        },
      }),
    } as unknown as D1Database;
    const attachments = {
      async delete(key: string) {
        deletedKeys.push(key);
      },
    } as unknown as KVNamespace;
    const env: Env = {
      DB: db,
      ATTACHMENTS: attachments,
      TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      POLICY_AUD: "test-aud",
    };

    await expect(finalizeAttachmentUpload(
      env,
      "user_1",
      1,
      "attachment_1",
      "user_1/g1/attachment_1/generation.jpg",
      "a".repeat(64),
    )).rejects.toThrow("stale_cloud_generation");
    expect(deletedKeys).toEqual(["user_1/g1/attachment_1/generation.jpg"]);
    expect(cleanupQueued).toBe(false);
  });

  it("keeps a durable cleanup row when direct KV deletion fails", async () => {
    let cleanupQueued = false;
    const db = {
      prepare: (query: string) => ({
        bind() {
          return this;
        },
        async run() {
          if (query.includes("UPDATE attachments")) {
            return { success: true, meta: { changes: 0 } };
          }
          if (query.includes("INSERT INTO cloud_attachment_cleanup")) {
            cleanupQueued = true;
            return { success: true };
          }
          if (query.includes("DELETE FROM cloud_attachment_cleanup")) {
            cleanupQueued = false;
            return { success: true };
          }
          throw new Error(`Unexpected query: ${query}`);
        },
      }),
    } as unknown as D1Database;
    const env: Env = {
      DB: db,
      ATTACHMENTS: {
        async delete() {
          throw new Error("KV unavailable");
        },
      } as unknown as KVNamespace,
      TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      POLICY_AUD: "test-aud",
    };

    await expect(finalizeAttachmentUpload(
      env,
      "user_1",
      4,
      "attachment_1",
      "user_1/g4/attachment_1/stale.jpg",
      "a".repeat(64),
    )).resolves.toBe(false);
    expect(cleanupQueued).toBe(true);
  });
});

describe("getAttachment", () => {
  it("asks the client to retry while a ready KV object is still propagating", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return {
              id: "attachment_1",
              account_generation: 1,
              entry_id: "entry_1",
              r2_key: "user_1/g1/attachment_1/object.jpg",
              mime_type: "image/jpeg",
              size_bytes: 23,
              width: 1,
              height: 1,
              sha256: "a".repeat(64),
              status: "ready",
            };
          },
        };
      },
    } as unknown as D1Database;
    const env: Env = {
      DB: db,
      ATTACHMENTS: {
        async get() {
          return null;
        },
      } as unknown as KVNamespace,
      TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      POLICY_AUD: "test-aud",
    };
    const user: AuthenticatedUser = {
      id: "user_1",
      email: "nobody@example.invalid",
      issuer: "test",
      subject: "subject",
    };

    const response = await getAttachment(env, user, 1, "attachment_1");

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "attachment_replication_pending",
        message: "Attachment is still propagating through cloud storage",
      },
    });
  });
});

describe("putAttachment upload lease", () => {
  it("does not write KV when the generation can no longer acquire a lease", async () => {
    let kvPut = false;
    const db = {
      prepare(query: string) {
        return {
          bind() {
            return this;
          },
          async run() {
            if (query.includes("DELETE FROM cloud_upload_leases")) {
              return { success: true };
            }
            throw new Error(`Unexpected run query: ${query}`);
          },
          async first() {
            if (query.includes("INSERT INTO cloud_upload_leases")) return null;
            throw new Error(`Unexpected first query: ${query}`);
          },
        };
      },
    } as unknown as D1Database;
    const env: Env = {
      DB: db,
      ATTACHMENTS: {
        async put() {
          kvPut = true;
        },
      } as unknown as KVNamespace,
      TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      POLICY_AUD: "test-aud",
    };
    const user: AuthenticatedUser = {
      id: "user_1",
      email: "nobody@example.invalid",
      issuer: "test",
      subject: "subject",
    };
    const body = minimalJpeg(1, 1);
    const request = new Request("https://example.test/api/attachments/attachment_1", {
      method: "PUT",
      headers: {
        "Content-Type": "image/jpeg",
        "X-Content-Sha256": "b0792b14c4e2cd5546472072923666f772de678f4874bd6d0610b1e3f12d4f3b",
        "X-Entry-Id": "entry_1",
        "X-Height": "1",
        "X-Width": "1",
      },
      body,
    });

    await expect(putAttachment(request, env, user, 1, "attachment_1"))
      .rejects.toMatchObject({ status: 409, code: "stale_cloud_generation" });
    expect(kvPut).toBe(false);
  });
});

describe("putAttachment idempotency", () => {
  it("returns an existing ready attachment without rewriting KV or resetting pending state", async () => {
    const body = minimalJpeg(1, 1);
    const sha256 = "b0792b14c4e2cd5546472072923666f772de678f4874bd6d0610b1e3f12d4f3b";
    let attachmentUpdates = 0;
    let kvPuts = 0;
    let leaseDeletes = 0;
    const db = {
      prepare(query: string) {
        return {
          bind() {
            return this;
          },
          async run() {
            if (query.includes("DELETE FROM cloud_upload_leases")) {
              leaseDeletes += 1;
              return { success: true };
            }
            if (query.includes("UPDATE attachments")) {
              attachmentUpdates += 1;
              return { success: true, meta: { changes: 1 } };
            }
            throw new Error(`Unexpected run query: ${query}`);
          },
          async first() {
            if (query.includes("INSERT INTO cloud_upload_leases")) {
              return { lease_id: "lease_1" };
            }
            if (query.includes("FROM attachments")) {
              return {
                id: "attachment_1",
                account_generation: 1,
                entry_id: "entry_1",
                r2_key: "user_1/g1/attachment_1/ready.jpg",
                mime_type: "image/jpeg",
                size_bytes: body.byteLength,
                width: 1,
                height: 1,
                sha256,
                status: "ready",
              };
            }
            if (query.includes("FROM attachment_cleanup")) return null;
            throw new Error(`Unexpected first query: ${query}`);
          },
        };
      },
    } as unknown as D1Database;
    const env: Env = {
      DB: db,
      ATTACHMENTS: {
        async put() {
          kvPuts += 1;
        },
      } as unknown as KVNamespace,
      TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      POLICY_AUD: "test-aud",
    };
    const user: AuthenticatedUser = {
      id: "user_1",
      email: "nobody@example.invalid",
      issuer: "test",
      subject: "subject",
    };
    const request = new Request("https://example.test/api/attachments/attachment_1", {
      method: "PUT",
      headers: {
        "Content-Type": "image/jpeg",
        "X-Content-Sha256": sha256,
        "X-Entry-Id": "entry_1",
        "X-Height": "1",
        "X-Width": "1",
      },
      body,
    });

    const response = await putAttachment(request, env, user, 1, "attachment_1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      attachment: { id: "attachment_1", entryId: "entry_1", sha256 },
    });
    expect(kvPuts).toBe(0);
    expect(attachmentUpdates).toBe(0);
    expect(leaseDeletes).toBe(2);
  });
});
