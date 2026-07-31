import { ApiError } from "./errors";
import {
  attachmentGenerationPrefix,
  deleteAttachmentKeys,
  listAttachmentKeys,
} from "./attachment-store";
import type { CloudSyncState, Env } from "./types";

const DELETE_BATCH_SIZE = 50;
const KV_LIST_MAX_PAGES = 100;
const KV_PROPAGATION_WINDOW_MS = 60_000;
const MAX_GENERATION = 9_000_000_000_000_000;

interface R2KeyRow {
  r2_key: string;
}

interface RemainingRow {
  remaining: number;
}

interface DeletionQuietStateRow {
  deletion_quiet_since: string | null;
}

interface CloudSyncStateRow {
  status: CloudSyncState["status"];
  generation: number;
  last_deleted_generation: number | null;
}

type DeletionMode = "active" | "completed";
type DeletionFinish = "completed" | "retry";

export interface CloudAccountDeletionResult {
  complete: boolean;
  deletedObjects: number;
  remainingObjects: number;
}

function validateGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_GENERATION) {
    throw new ApiError(
      400,
      "invalid_cloud_generation",
      "Cloud generation is invalid",
    );
  }
  return Number(value);
}

function validateConfirmation(
  value: unknown,
  confirmation: "DELETE" | "ENABLE",
): number {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    (value as Record<string, unknown>).confirmation !== confirmation
  ) {
    throw new ApiError(
      400,
      confirmation === "DELETE"
        ? "invalid_deletion_confirmation"
        : "invalid_enable_confirmation",
      `Set confirmation to ${confirmation} and provide the current cloud generation`,
    );
  }
  return validateGeneration((value as Record<string, unknown>).generation);
}

export function validateAccountDeletionRequest(value: unknown): number {
  return validateConfirmation(value, "DELETE");
}

export function validateCloudSyncEnableRequest(value: unknown): number {
  return validateConfirmation(value, "ENABLE");
}

function staleCloudGeneration(): ApiError {
  return new ApiError(
    409,
    "stale_cloud_generation",
    "Cloud sync state changed; refresh the session and confirm again",
  );
}

async function readCloudSyncState(
  db: D1Database,
  userId: string,
): Promise<CloudSyncStateRow> {
  const state = await db
    .prepare(
      `SELECT status, generation, last_deleted_generation
       FROM cloud_sync_state
       WHERE user_id = ?`,
    )
    .bind(userId)
    .first<CloudSyncStateRow>();
  if (!state) throw new Error("Cloud sync state was not found");
  return state;
}

async function beginDeletion(
  db: D1Database,
  userId: string,
  expectedGeneration: number,
): Promise<DeletionMode> {
  const initial = await readCloudSyncState(db, userId);
  if (
    initial.status === "disabled" &&
    initial.last_deleted_generation === expectedGeneration
  ) {
    return "completed";
  }
  if (initial.generation !== expectedGeneration) throw staleCloudGeneration();
  if (initial.status === "deleting") return "active";
  if (expectedGeneration >= MAX_GENERATION) throw staleCloudGeneration();

  const now = new Date().toISOString();
  const [stateResult] = await db.batch([
    db
      .prepare(
        `UPDATE cloud_sync_state
         SET status = 'deleting', updated_at = ?
         WHERE user_id = ? AND generation = ? AND status = ?`,
      )
      .bind(now, userId, expectedGeneration, initial.status),
    db
      .prepare(
      `UPDATE users
         SET deletion_started_at = ?, deletion_quiet_since = NULL, updated_at = ?
         WHERE id = ? AND generation = ? AND deletion_started_at IS NULL`,
      )
      .bind(now, now, userId, expectedGeneration),
  ]);
  if (stateResult.meta.changes > 0) return "active";

  const raced = await readCloudSyncState(db, userId);
  if (raced.status === "deleting" && raced.generation === expectedGeneration) {
    return "active";
  }
  if (
    raced.status === "disabled" &&
    raced.last_deleted_generation === expectedGeneration
  ) {
    return "completed";
  }
  throw staleCloudGeneration();
}

async function getTrackedDeletionKeys(
  db: D1Database,
  userId: string,
  generation: number,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT r2_key
       FROM (
         SELECT r2_key FROM attachments
         WHERE user_id = ? AND account_generation = ?
         UNION
         SELECT r2_key FROM attachment_cleanup
         WHERE user_id = ? AND account_generation = ?
         UNION
         SELECT r2_key FROM cloud_attachment_cleanup
         WHERE user_id = ? AND account_generation = ?
       )
       ORDER BY r2_key
       LIMIT ?`,
    )
    .bind(
      userId,
      generation,
      userId,
      generation,
      userId,
      generation,
      DELETE_BATCH_SIZE,
    )
    .all<R2KeyRow>();
  return result.results.map((row) => row.r2_key);
}

async function listGenerationKeys(
  namespace: KVNamespace,
  userId: string,
  generation: number,
  limit: number,
): Promise<{ keys: string[]; scanComplete: boolean }> {
  try {
    const prefix = attachmentGenerationPrefix(userId, generation);
    const keys: string[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < KV_LIST_MAX_PAGES; pageNumber += 1) {
      const page = await listAttachmentKeys(
        namespace,
        prefix,
        Math.max(1, limit - keys.length),
        cursor,
      );
      keys.push(...page.keys.slice(0, limit - keys.length));
      if (page.listComplete) return { keys, scanComplete: true };
      if (keys.length >= limit) return { keys, scanComplete: false };
      if (!page.cursor || seenCursors.has(page.cursor)) {
        throw new Error("KV list cursor did not advance");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    throw new Error("KV list exceeded its page limit");
  } catch {
    throw new ApiError(
      503,
      "cloud_deletion_retry_required",
      "Cloud data deletion could not finish; retry the request",
    );
  }
}

async function resetDeletionQuietWindow(
  db: D1Database,
  userId: string,
  generation: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
       SET deletion_quiet_since = NULL
       WHERE id = ? AND generation = ? AND deletion_started_at IS NOT NULL`,
    )
    .bind(userId, generation)
    .run();
}

async function deletionQuietWindowComplete(
  db: D1Database,
  userId: string,
  generation: number,
  now: Date,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const activeLease = await db
    .prepare(
      `SELECT COUNT(*) AS remaining
       FROM cloud_upload_leases
       WHERE user_id = ? AND account_generation = ? AND expires_at > ?`,
    )
    .bind(userId, generation, nowIso)
    .first<RemainingRow>();
  if (!activeLease || !Number.isSafeInteger(activeLease.remaining) || activeLease.remaining < 0) {
    throw new Error("Cloud upload lease count query returned an invalid result");
  }
  if (activeLease.remaining > 0) {
    await resetDeletionQuietWindow(db, userId, generation);
    return false;
  }

  const state = await db
    .prepare(
      `UPDATE users
       SET deletion_quiet_since = COALESCE(deletion_quiet_since, ?)
       WHERE id = ? AND generation = ? AND deletion_started_at IS NOT NULL
       RETURNING deletion_quiet_since`,
    )
    .bind(nowIso, userId, generation)
    .first<DeletionQuietStateRow>();
  if (!state?.deletion_quiet_since) return false;
  const quietSince = Date.parse(state.deletion_quiet_since);
  return Number.isFinite(quietSince) && now.getTime() - quietSince >= KV_PROPAGATION_WINDOW_MS;
}

async function removeDeletedKeyMetadata(
  db: D1Database,
  userId: string,
  generation: number,
  r2Keys: string[],
): Promise<void> {
  if (!r2Keys.length) return;
  const placeholders = r2Keys.map(() => "?").join(", ");
  const bindings = [userId, generation, ...r2Keys] as const;
  await db.batch([
    db
      .prepare(
        `DELETE FROM attachments
         WHERE user_id = ? AND account_generation = ?
           AND r2_key IN (${placeholders})`,
      )
      .bind(...bindings),
    db
      .prepare(
        `DELETE FROM attachment_cleanup
         WHERE user_id = ? AND account_generation = ?
           AND r2_key IN (${placeholders})`,
      )
      .bind(...bindings),
    db
      .prepare(
        `DELETE FROM cloud_attachment_cleanup
         WHERE user_id = ? AND account_generation = ?
           AND r2_key IN (${placeholders})`,
      )
      .bind(...bindings),
  ]);
}

async function countTrackedKeys(
  db: D1Database,
  userId: string,
  generation: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS remaining
       FROM (
         SELECT r2_key FROM attachments
         WHERE user_id = ? AND account_generation = ?
         UNION
         SELECT r2_key FROM attachment_cleanup
         WHERE user_id = ? AND account_generation = ?
         UNION
         SELECT r2_key FROM cloud_attachment_cleanup
         WHERE user_id = ? AND account_generation = ?
       )`,
    )
    .bind(userId, generation, userId, generation, userId, generation)
    .first<RemainingRow>();
  if (!row || !Number.isSafeInteger(row.remaining) || row.remaining < 0) {
    throw new Error("Cloud deletion count query returned an invalid result");
  }
  return row.remaining;
}

async function deleteStoredKeys(namespace: KVNamespace, keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    await deleteAttachmentKeys(namespace, keys);
  } catch {
    throw new ApiError(
      503,
      "cloud_deletion_retry_required",
      "Cloud data deletion could not finish; retry the request",
    );
  }
}

async function finishDeletion(
  db: D1Database,
  userId: string,
  generation: number,
): Promise<DeletionFinish> {
  const now = new Date().toISOString();
  const deletedUser = await db
    .prepare(
      `DELETE FROM users
       WHERE id = ? AND generation = ? AND deletion_started_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM attachments
           WHERE user_id = ? AND account_generation = ?
         )
          AND NOT EXISTS (
            SELECT 1 FROM attachment_cleanup
            WHERE user_id = ? AND account_generation = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM cloud_attachment_cleanup
            WHERE user_id = ? AND account_generation = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM cloud_upload_leases
            WHERE user_id = ? AND account_generation = ? AND expires_at > ?
          )`,
    )
    .bind(
      userId,
      generation,
      userId,
      generation,
      userId,
      generation,
      userId,
      generation,
      userId,
      generation,
      now,
    )
    .run();
  if (deletedUser.meta.changes === 0) {
    const existingUser = await db
      .prepare("SELECT generation, deletion_started_at FROM users WHERE id = ?")
      .bind(userId)
      .first<{ generation: number; deletion_started_at: string | null }>();
    if (existingUser?.generation === generation) {
      if (existingUser.deletion_started_at === null) {
        throw new Error("Cloud account row was not marked for deletion");
      }
      return "retry";
    }
  }

  const disabled = await db
    .prepare(
      `UPDATE cloud_sync_state
       SET status = 'disabled', generation = generation + 1,
           last_deleted_generation = ?, updated_at = ?
       WHERE user_id = ? AND status = 'deleting' AND generation = ?
          AND NOT EXISTS (
            SELECT 1 FROM cloud_attachment_cleanup
            WHERE user_id = ? AND account_generation = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM cloud_upload_leases
            WHERE user_id = ? AND account_generation = ? AND expires_at > ?
          )`,
    )
    .bind(
      generation,
      now,
      userId,
      generation,
      userId,
      generation,
      userId,
      generation,
      now,
    )
    .run();
  if (disabled.meta.changes > 0) return "completed";

  const raced = await readCloudSyncState(db, userId);
  if (
    raced.status === "disabled" &&
    raced.last_deleted_generation === generation
  ) {
    return "completed";
  }
  if (raced.status === "deleting" && raced.generation === generation) {
    return "retry";
  }
  throw staleCloudGeneration();
}

export async function deleteCloudAccountData(
  env: Env,
  userId: string,
  generation: number,
): Promise<CloudAccountDeletionResult> {
  const mode = await beginDeletion(env.DB, userId, generation);
  const keys = new Set(await getTrackedDeletionKeys(env.DB, userId, generation));
  let initialScanComplete = false;
  if (keys.size < DELETE_BATCH_SIZE) {
    const listed = await listGenerationKeys(
      env.ATTACHMENTS,
      userId,
      generation,
      DELETE_BATCH_SIZE,
    );
    initialScanComplete = listed.scanComplete;
    for (const key of listed.keys) {
      if (keys.size >= DELETE_BATCH_SIZE) break;
      keys.add(key);
    }
  }

  const deletedKeys = [...keys];
  await deleteStoredKeys(env.ATTACHMENTS, deletedKeys);
  await removeDeletedKeyMetadata(env.DB, userId, generation, deletedKeys);

  const trackedRemaining = await countTrackedKeys(env.DB, userId, generation);
  const listedRemaining = await listGenerationKeys(
    env.ATTACHMENTS,
    userId,
    generation,
    1,
  );
  const scanComplete = initialScanComplete && listedRemaining.scanComplete;
  const remainingObjects = Math.max(
    trackedRemaining,
    listedRemaining.keys.length,
    scanComplete ? 0 : 1,
  );
  if (remainingObjects > 0 || deletedKeys.length > 0) {
    if (mode === "active") {
      await resetDeletionQuietWindow(env.DB, userId, generation);
    }
    return {
      complete: false,
      deletedObjects: deletedKeys.length,
      remainingObjects: Math.max(remainingObjects, 1),
    };
  }

  if (
    mode === "active" &&
    !await deletionQuietWindowComplete(env.DB, userId, generation, new Date())
  ) {
    return {
      complete: false,
      deletedObjects: 0,
      remainingObjects: 1,
    };
  }

  if (
    mode === "active" &&
    await finishDeletion(env.DB, userId, generation) === "retry"
  ) {
    return {
      complete: false,
      deletedObjects: deletedKeys.length,
      remainingObjects: 1,
    };
  }
  return {
    complete: true,
    deletedObjects: deletedKeys.length,
    remainingObjects: 0,
  };
}
