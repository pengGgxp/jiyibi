import { handleAuthenticated, jsonResponse, methodNotAllowed } from "../lib/http";
import type { Env } from "../lib/types";

interface SessionStatsRow {
  has_data: number;
  entry_count: number;
  attachment_count: number;
  cursor: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
  return handleAuthenticated(context, async (user, syncState) => {
    const stats = await context.env.DB
      .prepare(
        `SELECT
           CASE WHEN
             EXISTS(SELECT 1 FROM ledger_settings WHERE user_id = ? AND account_generation = ?)
             OR EXISTS(SELECT 1 FROM ledger_entries WHERE user_id = ? AND account_generation = ?)
             OR EXISTS(SELECT 1 FROM attachments WHERE user_id = ? AND account_generation = ?)
           THEN 1 ELSE 0 END AS has_data,
           (SELECT COUNT(*) FROM ledger_entries
            WHERE user_id = ? AND account_generation = ? AND deleted_at IS NULL) AS entry_count,
           (SELECT COUNT(*) FROM attachments
            WHERE user_id = ? AND account_generation = ? AND status = 'ready') AS attachment_count,
           (SELECT CAST(COALESCE(MAX(seq), 0) AS TEXT) FROM sync_changes
            WHERE user_id = ? AND account_generation = ?) AS cursor`,
      )
      .bind(
        user.id,
        syncState.generation,
        user.id,
        syncState.generation,
        user.id,
        syncState.generation,
        user.id,
        syncState.generation,
        user.id,
        syncState.generation,
        user.id,
        syncState.generation,
      )
      .first<SessionStatsRow>();
    if (!stats) throw new Error("Session statistics query returned no row");
    return jsonResponse({
      schemaVersion: 1,
      user: { id: user.id, email: user.email },
      cloud: {
        syncStatus: syncState.status,
        generation: syncState.generation,
        hasData: stats.has_data === 1,
        entryCount: stats.entry_count,
        attachmentCount: stats.attachment_count,
        cursor: stats.cursor,
      },
    });
  }, { allowSyncDisabled: true, allowDeletionInProgress: true });
};
