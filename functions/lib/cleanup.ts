import { deleteAttachmentKeys } from "./attachment-store";
import type { Env } from "./types";

const CLEANUP_BATCH_SIZE = 50;
const ORPHAN_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface AttachmentCleanupJob {
  attachment_id: string;
  r2_key: string;
  is_referenced: number;
}

interface CloudAttachmentCleanupJob extends AttachmentCleanupJob {
  account_generation: number;
}

interface AttachmentCleanupState {
  metadata_exists: number;
  is_referenced: number;
}

export function partitionCleanupJobs<T extends AttachmentCleanupJob>(jobs: T[]): {
  deleteObjects: T[];
  clearOnly: T[];
} {
  return {
    deleteObjects: jobs.filter((job) => job.is_referenced !== 1),
    clearOnly: jobs.filter((job) => job.is_referenced === 1),
  };
}

export function orphanAttachmentCutoff(now = new Date()): string {
  return new Date(now.getTime() - ORPHAN_GRACE_PERIOD_MS).toISOString();
}

async function cleanupStaleCloudUploads(env: Env, userId: string): Promise<void> {
  const result = await env.DB
    .prepare(
      `SELECT q.account_generation, q.attachment_id, q.r2_key,
              CASE WHEN EXISTS (
                SELECT 1 FROM attachments a
                WHERE a.user_id = q.user_id
                  AND a.account_generation = q.account_generation
                  AND a.r2_key = q.r2_key
              ) THEN 1 ELSE 0 END AS is_referenced
       FROM cloud_attachment_cleanup q
       WHERE q.user_id = ?
       ORDER BY q.created_at ASC
       LIMIT ?`,
    )
    .bind(userId, CLEANUP_BATCH_SIZE)
    .all<CloudAttachmentCleanupJob>();
  if (!result.results.length) return;

  const { deleteObjects, clearOnly } = partitionCleanupJobs(result.results);
  if (deleteObjects.length) {
    await deleteAttachmentKeys(env.ATTACHMENTS, deleteObjects.map((job) => job.r2_key));
  }
  const completed = [...deleteObjects, ...clearOnly];
  await env.DB.batch(completed.map((job) =>
    env.DB
      .prepare(
        `DELETE FROM cloud_attachment_cleanup
         WHERE user_id = ? AND account_generation = ?
           AND attachment_id = ? AND r2_key = ?`,
      )
      .bind(userId, job.account_generation, job.attachment_id, job.r2_key)
  ));
}

export async function cleanupPendingAttachments(
  env: Env,
  userId: string,
  generation: number,
  now = new Date(),
): Promise<void> {
  await cleanupStaleCloudUploads(env, userId);
  await env.DB
    .prepare(
      `INSERT INTO attachment_cleanup (
         user_id, account_generation, attachment_id, r2_key, created_at
       )
       SELECT a.user_id, a.account_generation, a.id, a.r2_key, a.updated_at
       FROM attachments a
       WHERE a.user_id = ? AND a.account_generation = ?
          AND a.updated_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries e
            WHERE e.user_id = a.user_id
              AND e.account_generation = a.account_generation
              AND e.attachment_id = a.id
          )
       ON CONFLICT(user_id, account_generation, attachment_id, r2_key) DO NOTHING`,
    )
    .bind(userId, generation, orphanAttachmentCutoff(now))
    .run();

  const result = await env.DB
    .prepare(
      `SELECT q.attachment_id, q.r2_key,
              CASE WHEN EXISTS (
                SELECT 1
                FROM ledger_entries e
                 JOIN attachments a
                  ON a.user_id = e.user_id
                    AND a.account_generation = e.account_generation
                    AND a.id = e.attachment_id
                 WHERE e.user_id = q.user_id
                   AND e.account_generation = q.account_generation
                   AND e.attachment_id = q.attachment_id
                  AND a.r2_key = q.r2_key
              ) THEN 1 ELSE 0 END AS is_referenced
       FROM attachment_cleanup q
       WHERE q.user_id = ? AND q.account_generation = ?
       ORDER BY q.created_at ASC
       LIMIT ?`,
    )
    .bind(userId, generation, CLEANUP_BATCH_SIZE)
    .all<AttachmentCleanupJob>();
  if (!result.results.length) return;

  const { deleteObjects, clearOnly } = partitionCleanupJobs(result.results);
  let deletedObjects: AttachmentCleanupJob[] = [];
  if (deleteObjects.length) {
    const deletionResults = await env.DB.batch(deleteObjects.map((job) =>
      env.DB
        .prepare(
          `DELETE FROM attachments
           WHERE user_id = ? AND account_generation = ?
             AND id = ? AND r2_key = ?
              AND NOT EXISTS (
                SELECT 1 FROM ledger_entries
                WHERE user_id = ? AND account_generation = ?
                  AND attachment_id = ?
              )`,
        )
        .bind(
          userId,
          generation,
          job.attachment_id,
          job.r2_key,
          userId,
          generation,
          job.attachment_id,
        )
    ));
    const deletionDecisions = await Promise.all(deleteObjects.map(async (job, index) => {
      if (deletionResults[index]?.meta.changes > 0) return job;

      // A zero-change retry can mean either that another request re-referenced
      // the attachment or that an earlier object-store attempt failed after D1 cleanup.
      const state = await env.DB
        .prepare(
          `SELECT
             CASE WHEN EXISTS (
               SELECT 1 FROM attachments
               WHERE user_id = ? AND account_generation = ?
                 AND id = ? AND r2_key = ?
             ) THEN 1 ELSE 0 END AS metadata_exists,
             CASE WHEN EXISTS (
               SELECT 1 FROM ledger_entries
               WHERE user_id = ? AND account_generation = ?
                 AND attachment_id = ?
             ) THEN 1 ELSE 0 END AS is_referenced`,
        )
        .bind(
          userId,
          generation,
          job.attachment_id,
          job.r2_key,
          userId,
          generation,
          job.attachment_id,
        )
        .first<AttachmentCleanupState>();
      if (
        !state ||
        (state.metadata_exists !== 0 && state.metadata_exists !== 1) ||
        (state.is_referenced !== 0 && state.is_referenced !== 1)
      ) {
        throw new Error("Attachment cleanup state query returned an invalid result");
      }
      return state.metadata_exists === 0 && state.is_referenced === 0
        ? job
        : undefined;
    }));
    deletedObjects = deletionDecisions.filter(
      (job): job is AttachmentCleanupJob => job !== undefined,
    );
    if (deletedObjects.length) {
      await deleteAttachmentKeys(env.ATTACHMENTS, deletedObjects.map((job) => job.r2_key));
    }
  }

  const statements: D1PreparedStatement[] = [];
  for (const job of deletedObjects) {
    statements.push(
      env.DB
        .prepare(
          `DELETE FROM attachment_cleanup
           WHERE user_id = ? AND account_generation = ?
             AND attachment_id = ? AND r2_key = ?
              AND NOT EXISTS (
               SELECT 1
               FROM ledger_entries e
                JOIN attachments a
                  ON a.user_id = e.user_id
                    AND a.account_generation = e.account_generation
                    AND a.id = e.attachment_id
                WHERE e.user_id = ?
                  AND e.account_generation = ?
                  AND e.attachment_id = ?
                 AND a.r2_key = ?
             )`,
        )
        .bind(
          userId,
          generation,
          job.attachment_id,
          job.r2_key,
          userId,
          generation,
          job.attachment_id,
          job.r2_key,
        ),
    );
  }
  for (const job of clearOnly) {
    statements.push(
      env.DB
        .prepare(
          `DELETE FROM attachment_cleanup
           WHERE user_id = ? AND account_generation = ?
             AND attachment_id = ? AND r2_key = ?
              AND EXISTS (
               SELECT 1
               FROM ledger_entries e
                JOIN attachments a
                  ON a.user_id = e.user_id
                    AND a.account_generation = e.account_generation
                    AND a.id = e.attachment_id
                WHERE e.user_id = ?
                  AND e.account_generation = ?
                  AND e.attachment_id = ?
                 AND a.r2_key = ?
             )`,
        )
        .bind(
          userId,
          generation,
          job.attachment_id,
          job.r2_key,
          userId,
          generation,
          job.attachment_id,
          job.r2_key,
        ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
}
