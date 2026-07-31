import { ApiError } from "./errors";
import { jsonResponse } from "./http";
import { createAttachmentKey } from "./attachment-store";
import type { AuthenticatedUser, Env } from "./types";
import { isValidId } from "./validation";

const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_UPLOAD_CLAIM_ATTEMPTS = 3;
const UPLOAD_LEASE_DURATION_MS = 15 * 60 * 1000;
export const MAX_CLOUD_ATTACHMENT_COUNT = 2_000;
export const MAX_CLOUD_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

interface AttachmentRow {
  id: string;
  account_generation: number;
  entry_id: string;
  r2_key: string;
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  sha256: string;
  status: "pending" | "ready";
}

interface UploadMetadata {
  id: string;
  entryId: string;
  size: number;
  width: number;
  height: number;
  sha256: string;
}

interface AttachmentUsageRow {
  attachment_count: number;
  attachment_bytes: number;
}

export function attachmentStoreWriteError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error);
  if (/(?:^|\D)429(?:\D|$)|quota|limit exceeded|too many requests/i.test(message)) {
    return new ApiError(
      507,
      "cloud_attachment_quota_exceeded",
      "Cloud attachment storage quota has been reached",
    );
  }
  return new ApiError(
    503,
    "cloud_attachment_storage_unavailable",
    "Cloud attachment storage is temporarily unavailable",
  );
}

function parsePositiveIntegerHeader(request: Request, name: string, maximum: number): number {
  const value = request.headers.get(name);
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new ApiError(400, "invalid_attachment_metadata", `${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new ApiError(400, "invalid_attachment_metadata", `${name} is invalid`);
  }
  return parsed;
}

export function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    throw new ApiError(400, "invalid_jpeg", "Attachment body is not a complete JPEG image");
  }
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = bytes[offset] * 256 + bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new ApiError(400, "invalid_jpeg", "JPEG segment data is invalid");
    }
    if (SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        throw new ApiError(400, "invalid_jpeg", "JPEG dimensions are invalid");
      }
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];
      if (width < 1 || height < 1) {
        throw new ApiError(400, "invalid_jpeg", "JPEG dimensions are invalid");
      }
      return { width, height };
    }
    offset += segmentLength;
  }
  throw new ApiError(400, "invalid_jpeg", "JPEG dimensions could not be read");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readUpload(
  request: Request,
  attachmentId: string,
): Promise<{ metadata: UploadMetadata; body: Uint8Array }> {
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "image/jpeg") {
    throw new ApiError(415, "unsupported_media_type", "Attachment must be image/jpeg");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 1 ||
      parsedLength > MAX_ATTACHMENT_BYTES
    ) {
      throw new ApiError(413, "attachment_too_large", "Attachment must not exceed 1 MiB");
    }
  }
  const entryId = request.headers.get("x-entry-id")?.trim();
  if (!isValidId(entryId)) {
    throw new ApiError(400, "invalid_attachment_metadata", "x-entry-id is invalid");
  }
  const width = parsePositiveIntegerHeader(request, "x-width", MAX_IMAGE_DIMENSION);
  const height = parsePositiveIntegerHeader(request, "x-height", MAX_IMAGE_DIMENSION);
  const expectedSha256 = request.headers.get("x-content-sha256")?.trim().toLowerCase();
  if (!expectedSha256 || !SHA256_PATTERN.test(expectedSha256)) {
    throw new ApiError(400, "invalid_attachment_metadata", "x-content-sha256 is invalid");
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength < 1 || body.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new ApiError(413, "attachment_too_large", "Attachment must not exceed 1 MiB");
  }
  const actualDimensions = parseJpegDimensions(body);
  if (actualDimensions.width !== width || actualDimensions.height !== height) {
    throw new ApiError(400, "attachment_dimensions_mismatch", "JPEG dimensions do not match headers");
  }
  const actualSha256 = await sha256Hex(body);
  if (actualSha256 !== expectedSha256) {
    throw new ApiError(400, "attachment_hash_mismatch", "Attachment SHA-256 does not match");
  }
  return {
    body,
    metadata: {
      id: attachmentId,
      entryId,
      size: body.byteLength,
      width,
      height,
      sha256: actualSha256,
    },
  };
}

function matches(row: AttachmentRow, metadata: UploadMetadata): boolean {
  return (
    row.entry_id === metadata.entryId &&
    row.mime_type === "image/jpeg" &&
    row.size_bytes === metadata.size &&
    row.width === metadata.width &&
    row.height === metadata.height &&
    row.sha256 === metadata.sha256
  );
}

async function getMetadata(
  db: D1Database,
  userId: string,
  generation: number,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  return db
    .prepare(
      `SELECT id, account_generation, entry_id, r2_key, mime_type, size_bytes,
              width, height, sha256, status
       FROM attachments
       WHERE user_id = ? AND account_generation = ? AND id = ?`,
    )
    .bind(userId, generation, attachmentId)
    .first<AttachmentRow>();
}

async function assertCloudAttachmentCapacity(
  db: D1Database,
  userId: string,
  generation: number,
  incomingBytes: number,
): Promise<void> {
  const usage = await db
    .prepare(
      `SELECT COUNT(*) AS attachment_count,
              COALESCE(SUM(size_bytes), 0) AS attachment_bytes
       FROM attachments
       WHERE user_id = ? AND account_generation = ?`,
    )
    .bind(userId, generation)
    .first<AttachmentUsageRow>();
  if (
    usage && (
      usage.attachment_count >= MAX_CLOUD_ATTACHMENT_COUNT ||
      usage.attachment_bytes + incomingBytes > MAX_CLOUD_ATTACHMENT_BYTES
    )
  ) {
    throw new ApiError(
      507,
      "cloud_attachment_quota_exceeded",
      "Cloud attachment storage quota has been reached",
    );
  }
}

async function acquireUploadLease(
  db: D1Database,
  userId: string,
  generation: number,
): Promise<string> {
  const now = new Date();
  const nowIso = now.toISOString();
  await db
    .prepare(
      `DELETE FROM cloud_upload_leases
       WHERE user_id = ? AND account_generation = ? AND expires_at <= ?`,
    )
    .bind(userId, generation, nowIso)
    .run();

  const leaseId = crypto.randomUUID();
  const lease = await db
    .prepare(
      `INSERT INTO cloud_upload_leases (
         user_id, account_generation, lease_id, expires_at, created_at
       )
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM cloud_sync_state
         WHERE user_id = ? AND status = 'enabled' AND generation = ?
       )
       RETURNING lease_id`,
    )
    .bind(
      userId,
      generation,
      leaseId,
      new Date(now.getTime() + UPLOAD_LEASE_DURATION_MS).toISOString(),
      nowIso,
      userId,
      generation,
    )
    .first<{ lease_id: string }>();
  if (!lease) {
    throw new ApiError(
      409,
      "stale_cloud_generation",
      "Cloud sync generation changed; retry after explicitly enabling sync",
    );
  }
  return lease.lease_id;
}

async function releaseUploadLease(
  db: D1Database,
  userId: string,
  generation: number,
  leaseId: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `DELETE FROM cloud_upload_leases
         WHERE user_id = ? AND account_generation = ? AND lease_id = ?`,
      )
      .bind(userId, generation, leaseId)
      .run();
  } catch (error) {
    console.error("Failed to release cloud upload lease", error);
  }
}

async function claimAttachmentUpload(
  env: Env,
  userId: string,
  generation: number,
  metadata: UploadMetadata,
): Promise<{ created: boolean; r2Key: string; alreadyReady: boolean }> {
  let created = false;
  for (let attempt = 0; attempt < MAX_UPLOAD_CLAIM_ATTEMPTS; attempt += 1) {
    let existing = await getMetadata(env.DB, userId, generation, metadata.id);
    if (existing && !matches(existing, metadata)) {
      throw new ApiError(409, "attachment_id_conflict", "Attachment ID is already in use");
    }
    if (!existing) {
      const now = new Date().toISOString();
      const candidateR2Key = createAttachmentKey(userId, generation, metadata.id);
      const inserted = await env.DB
        .prepare(
          `INSERT INTO attachments (
             user_id, account_generation, id, entry_id, r2_key, mime_type,
             size_bytes, width, height, sha256, status, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, 'image/jpeg', ?, ?, ?, ?, 'pending', ?, ?
           WHERE (
             SELECT COUNT(*) FROM attachments
             WHERE user_id = ? AND account_generation = ?
           ) < ?
              AND (
                SELECT COALESCE(SUM(size_bytes), 0) FROM attachments
                WHERE user_id = ? AND account_generation = ?
              ) <= ? - ?
           ON CONFLICT(user_id, id) DO NOTHING
           RETURNING id`,
        )
        .bind(
          userId,
          generation,
          metadata.id,
          metadata.entryId,
          candidateR2Key,
          metadata.size,
          metadata.width,
          metadata.height,
          metadata.sha256,
          now,
          now,
          userId,
          generation,
          MAX_CLOUD_ATTACHMENT_COUNT,
          userId,
          generation,
          MAX_CLOUD_ATTACHMENT_BYTES,
          metadata.size,
        )
        .first<{ id: string }>();
      created ||= Boolean(inserted);
      existing = await getMetadata(env.DB, userId, generation, metadata.id);
      if (!existing) {
        await assertCloudAttachmentCapacity(env.DB, userId, generation, metadata.size);
        continue;
      }
      if (!matches(existing, metadata)) {
        throw new ApiError(409, "attachment_id_conflict", "Attachment ID is already in use");
      }
    }

    const cleanup = await env.DB
      .prepare(
        `SELECT r2_key
         FROM attachment_cleanup
         WHERE user_id = ? AND account_generation = ?
           AND attachment_id = ? AND r2_key = ?`,
      )
      .bind(userId, generation, metadata.id, existing.r2_key)
      .first<{ r2_key: string }>();
    if (existing.status === "ready" && !cleanup) {
      return { created, r2Key: existing.r2_key, alreadyReady: true };
    }
    const previousR2Key = existing.r2_key;
    const claimedR2Key = cleanup
      ? createAttachmentKey(userId, generation, metadata.id)
      : previousR2Key;
    const now = new Date().toISOString();
    const claimed = cleanup
      ? await env.DB
          .prepare(
            `UPDATE attachments
             SET r2_key = ?, status = 'pending', updated_at = ?
             WHERE user_id = ? AND account_generation = ?
               AND id = ? AND r2_key = ? AND sha256 = ?
               AND EXISTS (
                 SELECT 1 FROM attachment_cleanup
                 WHERE user_id = ? AND account_generation = ?
                   AND attachment_id = ? AND r2_key = ?
               )`,
          )
          .bind(
            claimedR2Key,
            now,
            userId,
            generation,
            metadata.id,
            previousR2Key,
            metadata.sha256,
            userId,
            generation,
            metadata.id,
            previousR2Key,
          )
          .run()
      : await env.DB
          .prepare(
            `UPDATE attachments
             SET status = 'pending', updated_at = ?
             WHERE user_id = ? AND account_generation = ?
               AND id = ? AND r2_key = ? AND sha256 = ?
               AND NOT EXISTS (
                 SELECT 1 FROM attachment_cleanup
                 WHERE user_id = ? AND account_generation = ?
                   AND attachment_id = ? AND r2_key = ?
               )`,
          )
          .bind(
            now,
            userId,
            generation,
            metadata.id,
            previousR2Key,
            metadata.sha256,
            userId,
            generation,
            metadata.id,
            previousR2Key,
          )
          .run();
    if (claimed.meta.changes > 0) {
      return { created, r2Key: claimedR2Key, alreadyReady: false };
    }
  }
  throw new ApiError(
    409,
    "attachment_upload_raced",
    "Attachment changed during upload; retry the request",
  );
}

function attachmentUploadResponse(
  metadata: UploadMetadata,
  status: 200 | 201,
): Response {
  return jsonResponse(
    {
      schemaVersion: 1,
      attachment: {
        id: metadata.id,
        entryId: metadata.entryId,
        mimeType: "image/jpeg",
        size: metadata.size,
        width: metadata.width,
        height: metadata.height,
        sha256: metadata.sha256,
      },
    },
    status,
  );
}

async function discardStaleUpload(
  env: Env,
  userId: string,
  generation: number,
  attachmentId: string,
  r2Key: string,
): Promise<void> {
  let queueError: unknown;
  try {
    await env.DB
      .prepare(
        `INSERT INTO cloud_attachment_cleanup (
           user_id, account_generation, attachment_id, r2_key, created_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, account_generation, attachment_id, r2_key) DO NOTHING`,
      )
      .bind(userId, generation, attachmentId, r2Key, new Date().toISOString())
      .run();
  } catch (error) {
    queueError = error;
  }
  try {
    await env.ATTACHMENTS.delete(r2Key);
    if (!queueError) {
      await env.DB
        .prepare(
          `DELETE FROM cloud_attachment_cleanup
           WHERE user_id = ? AND account_generation = ?
             AND attachment_id = ? AND r2_key = ?`,
        )
        .bind(userId, generation, attachmentId, r2Key)
        .run();
    }
  } catch (error) {
    if (queueError) throw error;
    // A durable cleanup row remains for a later sync or account-deletion retry.
  }
}

export async function finalizeAttachmentUpload(
  env: Env,
  userId: string,
  generation: number,
  attachmentId: string,
  r2Key: string,
  sha256: string,
): Promise<boolean> {
  let ready: D1Result;
  try {
    ready = await env.DB
      .prepare(
        `UPDATE attachments
         SET status = 'ready', updated_at = ?
         WHERE user_id = ? AND account_generation = ?
           AND id = ? AND r2_key = ? AND sha256 = ?`,
      )
      .bind(new Date().toISOString(), userId, generation, attachmentId, r2Key, sha256)
      .run();
  } catch (error) {
    await discardStaleUpload(env, userId, generation, attachmentId, r2Key);
    throw error;
  }
  if (ready.meta.changes > 0) return true;
  await discardStaleUpload(env, userId, generation, attachmentId, r2Key);
  return false;
}

export async function putAttachment(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
  generation: number,
  attachmentId: string,
): Promise<Response> {
  const { body, metadata } = await readUpload(request, attachmentId);
  const leaseId = await acquireUploadLease(env.DB, user.id, generation);
  try {
    const claim = await claimAttachmentUpload(env, user.id, generation, metadata);
    if (claim.alreadyReady) return attachmentUploadResponse(metadata, 200);

    const r2Key = claim.r2Key;
    try {
      await env.ATTACHMENTS.put(r2Key, body, {
        metadata: {
          entryId: metadata.entryId,
          width: String(metadata.width),
          height: String(metadata.height),
          sha256: metadata.sha256,
        },
      });
    } catch (error) {
      throw attachmentStoreWriteError(error);
    }
    if (!await finalizeAttachmentUpload(
      env,
      user.id,
      generation,
      attachmentId,
      r2Key,
      metadata.sha256,
    )) {
      throw new ApiError(
        409,
        "attachment_upload_raced",
        "Attachment changed during upload; retry the request",
      );
    }

    return attachmentUploadResponse(metadata, claim.created ? 201 : 200);
  } finally {
    await releaseUploadLease(env.DB, user.id, generation, leaseId);
  }
}

export async function getAttachment(
  env: Env,
  user: AuthenticatedUser,
  generation: number,
  attachmentId: string,
): Promise<Response> {
  const metadata = await getMetadata(env.DB, user.id, generation, attachmentId);
  if (!metadata || metadata.status !== "ready") {
    throw new ApiError(404, "attachment_not_found", "Attachment not found");
  }
  const object = await env.ATTACHMENTS.get(metadata.r2_key, "arrayBuffer");
  if (object === null) {
    return jsonResponse(
      {
        error: {
          code: "attachment_replication_pending",
          message: "Attachment is still propagating through cloud storage",
        },
      },
      503,
      { "Retry-After": "2" },
    );
  }
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": "inline",
    "Content-Length": String(object.byteLength),
    "Content-Type": "image/jpeg",
    "X-Content-Sha256": metadata.sha256,
    "X-Entry-Id": metadata.entry_id,
    "X-Height": String(metadata.height),
    "X-Width": String(metadata.width),
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(object, { status: 200, headers });
}
