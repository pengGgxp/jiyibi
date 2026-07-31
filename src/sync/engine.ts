import type { AppSettings, Attachment, LedgerEntry } from "../domain/types";
import {
  assertSyncAccount,
  commitSyncBatch,
  getSyncOverview,
  ledgerDb,
  type LedgerDatabase,
  type SyncOutboxRecord,
  type SyncOverview,
} from "../data/database";
import { createSyncApiClient, type DownloadedAttachment, type SyncApiClient } from "./api";
import {
  SYNC_SCHEMA_VERSION,
  type SyncChange,
  type SyncMutation,
} from "./contracts";

export const SYNC_LOCAL_CHANGE_EVENT = "jiyibi:local-sync-change" as const;
const MAX_SYNC_ROUNDS = 10;
const MAX_MUTATIONS_PER_ROUND = 50;
const fallbackLockTails = new Map<string, Promise<void>>();

export class SyncIncompleteError extends Error {
  constructor() {
    super("Cloud sync has more changes than one pass can safely process");
    this.name = "SyncIncompleteError";
  }
}

export class SyncGenerationChangedError extends Error {
  constructor() {
    super("Cloud sync generation changed; explicit consent is required");
    this.name = "SyncGenerationChangedError";
  }
}

export function notifyLocalSyncChange(): void {
  if (typeof globalThis.dispatchEvent === "function" && typeof Event === "function") {
    globalThis.dispatchEvent(new Event(SYNC_LOCAL_CHANGE_EVENT));
  }
}

async function withFallbackLock<T>(name: string, callback: () => Promise<T>): Promise<T> {
  const previous = fallbackLockTails.get(name) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  fallbackLockTails.set(name, tail);
  await previous.catch(() => undefined);
  try {
    return await callback();
  } finally {
    release();
    if (fallbackLockTails.get(name) === tail) fallbackLockTails.delete(name);
  }
}

function withSyncLock<T>(database: LedgerDatabase, callback: () => Promise<T>): Promise<T> {
  const name = `jiyibi-sync:${database.name}`;
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request(name, { mode: "exclusive" }, callback);
  return withFallbackLock(name, callback);
}

async function listPushableMutations(
  database: LedgerDatabase,
  expectedGeneration: number,
): Promise<SyncOutboxRecord[]> {
  return database.transaction(
    "r",
    database.syncState,
    database.syncOutbox,
    database.syncConflicts,
    async () => {
      const link = await database.syncState.get("primary");
      if (link?.generation !== expectedGeneration) {
        throw new SyncGenerationChangedError();
      }
      if (!link?.uploadApproved) return [];
      const conflicts = new Set((await database.syncConflicts.toArray()).map(({ id }) => id));
      const outbox = await database.syncOutbox.orderBy("createdAt").toArray();
      return outbox
        .filter((mutation) => !conflicts.has(mutation.entityKey))
        .slice(0, MAX_MUTATIONS_PER_ROUND);
    },
  );
}

function toMutation(record: SyncOutboxRecord): SyncMutation {
  if (record.entityType === "entry") {
    return {
      id: record.id,
      entityType: "entry",
      entityId: record.entityId,
      baseVersion: record.baseVersion,
      payload: record.payload as LedgerEntry,
    };
  }
  return {
    id: record.id,
    entityType: "settings",
    entityId: record.entityId,
    baseVersion: record.baseVersion,
    payload: record.payload as AppSettings,
  };
}

async function uploadReferencedAttachments(
  mutations: readonly SyncOutboxRecord[],
  database: LedgerDatabase,
  api: SyncApiClient,
  generation: number,
): Promise<void> {
  const uploaded = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.entityType !== "entry") continue;
    const entry = mutation.payload as LedgerEntry;
    if (entry.deletedAt || !entry.attachmentId || uploaded.has(entry.attachmentId)) continue;
    const attachment = await database.attachments.get(entry.attachmentId);
    if (!attachment) {
      if (mutation.baseVersion === 0) {
        throw new Error(`Local attachment ${entry.attachmentId} is missing`);
      }
      continue;
    }
    await api.putAttachment(attachment, generation);
    uploaded.add(attachment.id);
  }
}

interface PendingDownload {
  id: string;
  createdAt: string;
  remote: DownloadedAttachment;
}

async function downloadRemoteAttachments(
  changes: readonly SyncChange[],
  database: LedgerDatabase,
  api: SyncApiClient,
  generation: number,
): Promise<PendingDownload[]> {
  const downloads = new Map<string, PendingDownload>();
  for (const change of changes) {
    if (change.entityType !== "entry") continue;
    const entry = change.payload;
    if (entry.deletedAt || !entry.attachmentId || downloads.has(entry.attachmentId)) continue;

    const existing = await database.attachments.get(entry.attachmentId);
    if (existing) continue;
    const remote = await api.getAttachment(entry.attachmentId, generation);
    if (!remote || remote.entryId !== entry.id) {
      throw new Error(`Remote attachment ${entry.attachmentId} is unavailable`);
    }
    downloads.set(entry.attachmentId, {
      id: entry.attachmentId,
      createdAt: entry.createdAt,
      remote,
    });
  }
  return [...downloads.values()];
}

function downloadedAttachments(
  downloads: readonly PendingDownload[],
): Attachment[] {
  return downloads.map((download) => {
    const attachment: Attachment = {
      id: download.id,
      entryId: download.remote.entryId,
      blob: download.remote.blob,
      mimeType: download.remote.mimeType,
      size: download.remote.size,
      width: download.remote.width,
      height: download.remote.height,
      createdAt: download.createdAt,
    };
    return attachment;
  });
}

async function runSync(database: LedgerDatabase, api: SyncApiClient): Promise<SyncOverview> {
  const initialState = await database.syncState.get("primary");
  if (!initialState) return getSyncOverview(database);
  const generation = initialState.generation;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new SyncGenerationChangedError();
  }

  const session = await api.getSession();
  await assertSyncAccount(session.user.id, database, generation);
  if (
    session.cloud.syncStatus !== "enabled" ||
    session.cloud.generation !== generation
  ) {
    throw new SyncGenerationChangedError();
  }
  let completed = false;

  for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
    const state = await database.syncState.get("primary");
    if (!state) {
      completed = true;
      break;
    }
    if (state.generation !== generation) throw new SyncGenerationChangedError();
    const outbox = await listPushableMutations(database, generation);
    await uploadReferencedAttachments(outbox, database, api, generation);
    const response = await api.sync({
      schemaVersion: SYNC_SCHEMA_VERSION,
      cursor: state.cursor,
      mutations: outbox.map(toMutation),
    }, generation);

    const attachmentChanges = [
      ...response.changes,
      ...response.results.flatMap((result) =>
        result.status === "conflict" ? [result.remote] : []),
    ];
    const downloads = await downloadRemoteAttachments(
      attachmentChanges,
      database,
      api,
      generation,
    );
    await commitSyncBatch(
      outbox,
      response.results,
      response.changes,
      response.nextCursor,
      downloadedAttachments(downloads),
      generation,
      database,
    );

    if (
      !response.hasMore &&
      (await listPushableMutations(database, generation)).length === 0
    ) {
      completed = true;
      break;
    }
  }
  if (!completed) throw new SyncIncompleteError();
  return getSyncOverview(database);
}

export function syncNow(
  database: LedgerDatabase = ledgerDb,
  api: SyncApiClient = createSyncApiClient(),
): Promise<SyncOverview> {
  return withSyncLock(database, () => runSync(database, api));
}
