import type {
  AppSettings,
  Attachment,
  LedgerEntry,
  RecoveryAllocation,
  SavingsEvent,
} from "../domain/types";
import {
  assertSyncAccount,
  commitSyncBatch,
  getSyncOverview,
  ledgerDb,
  syncEntityKey,
  type LedgerDatabase,
  type SyncOutboxRecord,
  type SyncOverview,
} from "../data/database";
import { createSyncApiClient, type DownloadedAttachment, type SyncApiClient } from "./api";
import {
  SYNC_SCHEMA_VERSION,
  type SettingsSyncPayload,
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

async function prepareSyncProtocolRefresh(
  database: LedgerDatabase,
  expectedGeneration: number,
): Promise<boolean> {
  return database.transaction(
    "rw",
    database.syncState,
    database.entitySyncState,
    async () => {
      const state = await database.syncState.get("primary");
      if (!state || state.generation !== expectedGeneration) {
        throw new SyncGenerationChangedError();
      }
      if (state.syncProtocolVersion === SYNC_SCHEMA_VERSION) return false;
      if (state.syncProtocolRefreshPending) return true;
      await database.syncState.put({
        ...state,
        cursor: "0",
        syncProtocolRefreshPending: true,
      });
      await database.entitySyncState.clear();
      return true;
    },
  );
}

async function completeSyncProtocolRefresh(
  database: LedgerDatabase,
  expectedGeneration: number,
): Promise<void> {
  await database.transaction("rw", database.syncState, async () => {
    const state = await database.syncState.get("primary");
    if (!state || state.generation !== expectedGeneration) {
      throw new SyncGenerationChangedError();
    }
    const next = {
      ...state,
      syncProtocolVersion: SYNC_SCHEMA_VERSION,
    };
    delete next.syncProtocolRefreshPending;
    await database.syncState.put(next);
  });
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
      const outbox = await database.syncOutbox.toArray();
      const pendingConfirmationEntries = new Set(
        outbox
          .filter((mutation) => mutation.incomeConfirmation)
          .map((mutation) => mutation.incomeConfirmation!.forecastId),
      );
      const dependsOnPendingConfirmation = (mutation: SyncOutboxRecord): boolean => {
        if (mutation.entityType === "entry") {
          return pendingConfirmationEntries.has(mutation.entityId);
        }
        if (mutation.entityType === "recoveryAllocation") {
          const allocation = mutation.payload as RecoveryAllocation;
          return pendingConfirmationEntries.has(allocation.refundEntryId) ||
            pendingConfirmationEntries.has(allocation.expenseEntryId);
        }
        if (mutation.entityType === "savingsEvent") {
          const event = mutation.payload as SavingsEvent;
          return "linkedExpenseEntryId" in event &&
            event.linkedExpenseEntryId !== undefined &&
            pendingConfirmationEntries.has(event.linkedExpenseEntryId);
        }
        return false;
      };
      const pushable = outbox
        .filter((mutation) =>
          !conflicts.has(mutation.entityKey) &&
          !conflicts.has(syncEntityKey(mutation.entityType, mutation.entityId)) &&
          !dependsOnPendingConfirmation(mutation))
        .sort((left, right) => {
          const priority = (mutation: SyncOutboxRecord): number => {
            const deleted = "deletedAt" in mutation.payload && Boolean(mutation.payload.deletedAt);
            if (mutation.entityType === "entry" && mutation.baseVersion === 0) return 0;
            if (mutation.entityType === "recoveryAllocation" && deleted && mutation.baseVersion > 0) {
              return 1;
            }
            if (mutation.entityType === "entry" && deleted) return 3;
            if (mutation.entityType === "recoveryAllocation") return 2;
            return 0;
          };
          return priority(left) - priority(right)
            || left.createdAt.localeCompare(right.createdAt)
            || left.entityKey.localeCompare(right.entityKey);
        });
      const confirmations = pushable.filter((mutation) => mutation.incomeConfirmation);
      // A confirmation changes settings and may create an entry. Send one by
      // itself so its result can rebase later settings and entry edits first.
      return confirmations.length > 0
        ? confirmations.slice(0, 1)
        : pushable.slice(0, MAX_MUTATIONS_PER_ROUND);
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
  if (record.entityType === "recoveryAllocation") {
    return {
      id: record.id,
      entityType: "recoveryAllocation",
      entityId: record.entityId,
      baseVersion: record.baseVersion,
      payload: record.payload as RecoveryAllocation,
    };
  }
  if (record.entityType === "savingsEvent") {
    return {
      id: record.id,
      entityType: "savingsEvent",
      entityId: record.entityId,
      baseVersion: record.baseVersion,
      payload: record.payload as SavingsEvent,
    };
  }
  const payload = structuredClone(record.payload as AppSettings) as SettingsSyncPayload &
    Record<string, unknown>;
  delete payload.monthEndBalanceGoalMinor;
  delete payload.savingsTargetNeedsReview;
  delete payload.savingsTargetOverride;
  delete payload.cycleSavingsTargetOverride;
  if (payload.payCycle) payload.payCycle = { paydayDay: payload.payCycle.paydayDay };
  if (payload.incomeForecast) {
    payload.incomeForecast = {
      id: payload.incomeForecast.id,
      targetPaydayDateKey: payload.incomeForecast.targetPaydayDateKey,
      expectedIncomeMinor: payload.incomeForecast.expectedIncomeMinor,
    };
  }
  if (record.clearPayCycle) payload.payCycle = null;
  if (record.clearIncomeForecast) payload.incomeForecast = null;
  if (record.clearSavingsGoal) payload.savingsGoal = null;
  if (record.clearLastExpectedIncomeMinor) payload.lastExpectedIncomeMinor = null;
  if (record.clearSavingsGoalNeedsSetup ||
      (payload.savingsGoal && payload.savingsGoalNeedsSetup === undefined)) {
    payload.savingsGoalNeedsSetup = null;
  }
  if (record.incomeConfirmation) {
    payload.incomeConfirmation = structuredClone(record.incomeConfirmation);
  }
  return {
    id: record.id,
    entityType: "settings",
    entityId: record.entityId,
    baseVersion: record.baseVersion,
    payload,
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
  let protocolRefreshing = await prepareSyncProtocolRefresh(database, generation);
  let completed = false;

  for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
    const state = await database.syncState.get("primary");
    if (!state) {
      completed = true;
      break;
    }
    if (state.generation !== generation) throw new SyncGenerationChangedError();
    const outbox = protocolRefreshing
      ? []
      : await listPushableMutations(database, generation);
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
      ...response.results.flatMap((result): SyncChange[] =>
        result.status !== "conflict" &&
        result.incomeConfirmation?.entry &&
        result.incomeConfirmation.entryVersion !== undefined
          ? [{
              seq: "0",
              entityType: "entry",
              entityId: result.incomeConfirmation.entry.id,
              version: result.incomeConfirmation.entryVersion,
              payload: result.incomeConfirmation.entry,
            }]
          : []),
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

    if (protocolRefreshing && !response.hasMore) {
      await completeSyncProtocolRefresh(database, generation);
      protocolRefreshing = false;
    }

    if (
      !response.hasMore &&
      !protocolRefreshing &&
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
