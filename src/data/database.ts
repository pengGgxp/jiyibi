import Dexie, { type EntityTable } from "dexie";
import { MAX_AMOUNT_MINOR } from "../domain/amount";
import { currentLocalMonthKey } from "../domain/date";
import { calculateLedgerSummary } from "../domain/stats";
import type {
  AppSettings,
  Attachment,
  EntryDraft,
  LedgerEntry,
  LedgerSummary,
  ProcessedImage,
} from "../domain/types";
import { validateEntryDraft } from "../domain/validation";
import { createId } from "../lib/id";
import type {
  SessionResponse,
  SyncChange,
  SyncEntityType,
  SyncResult,
} from "../sync/contracts";

export const DATABASE_NAME = "jiyibi";
export const DATABASE_SCHEMA_VERSION = 1 as const;
export const INDEXED_DB_VERSION = 2 as const;

export type EntitySyncStatus = "clean" | "pending" | "conflict";

export interface SyncState {
  id: "primary";
  accountId: string;
  accountEmail: string;
  generation: number;
  cursor: string;
  uploadApproved: boolean;
  linkedAt: string;
  lastSyncedAt?: string;
}

export interface EntitySyncState {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  serverVersion: number;
  status: EntitySyncStatus;
  tombstoneAcknowledged?: boolean;
  updatedAt: string;
}

export interface SyncOutboxRecord {
  /** Stable primary key used to coalesce edits for one entity. */
  entityKey: string;
  /** Idempotency key sent to the server; replaced whenever the payload changes. */
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  baseVersion: number;
  payload: LedgerEntry | AppSettings;
  createdAt: string;
  updatedAt: string;
}

export interface SyncConflict {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  localPayload: LedgerEntry | AppSettings;
  remotePayload: LedgerEntry | AppSettings;
  remoteVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface SyncOverview {
  linked: boolean;
  accountId?: string;
  accountEmail?: string;
  generation?: number;
  uploadApproved: boolean;
  cursor: string;
  pendingCount: number;
  conflictCount: number;
  lastSyncedAt?: string;
}

export class LedgerDataError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not-found"
      | "already-deleted"
      | "not-deleted"
      | "invalid-settings"
      | "attachment-mismatch"
      | "account-mismatch"
      | "sync-generation-mismatch"
      | "not-linked"
      | "sync-conflict"
      | "sync-linked"
      | "sync-tombstone-missing",
  ) {
    super(message);
    this.name = "LedgerDataError";
  }
}

export function createDefaultSettings(now = new Date()): AppSettings {
  return {
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    schemaVersion: DATABASE_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
  };
}

export class LedgerDatabase extends Dexie {
  entries!: EntityTable<LedgerEntry, "id">;
  attachments!: EntityTable<Attachment, "id">;
  settings!: EntityTable<AppSettings, "id">;
  syncState!: EntityTable<SyncState, "id">;
  entitySyncState!: EntityTable<EntitySyncState, "id">;
  syncOutbox!: EntityTable<SyncOutboxRecord, "entityKey">;
  syncConflicts!: EntityTable<SyncConflict, "id">;

  constructor(name = DATABASE_NAME) {
    super(name);
    this.version(DATABASE_SCHEMA_VERSION).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt",
      attachments: "id, entryId, createdAt",
      settings: "id",
    });
    this.version(INDEXED_DB_VERSION).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt",
      attachments: "id, entryId, createdAt",
      settings: "id",
      syncState: "id, accountId",
      entitySyncState: "id, [entityType+entityId], status",
      syncOutbox: "entityKey, &id, [entityType+entityId], createdAt",
      syncConflicts: "id, [entityType+entityId], createdAt",
    });
    this.on("populate", (transaction) =>
      transaction.table<AppSettings>("settings").add(createDefaultSettings()),
    );
  }
}

export const ledgerDb = new LedgerDatabase();

export function syncEntityKey(entityType: SyncEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function isDefaultSettings(settings: AppSettings): boolean {
  return (
    settings.id === "primary" &&
    settings.currency === "CNY" &&
    settings.schemaVersion === DATABASE_SCHEMA_VERSION &&
    settings.initialBalanceMinor === 0
  );
}

function syncPayloadFor(
  entityType: SyncEntityType,
  payload: LedgerEntry | AppSettings,
): LedgerEntry | AppSettings {
  const syncPayload = structuredClone(payload);
  if (entityType === "entry" && "deletedAt" in syncPayload && syncPayload.deletedAt) {
    delete syncPayload.attachmentId;
  }
  return syncPayload;
}

async function queueSyncMutation(
  entityType: SyncEntityType,
  entityId: string,
  payload: LedgerEntry | AppSettings,
  database: LedgerDatabase,
  nowIso: string,
): Promise<SyncOutboxRecord | undefined> {
  const link = await database.syncState.get("primary");
  if (!link?.uploadApproved) return undefined;

  const entityKey = syncEntityKey(entityType, entityId);
  const [existing, entityState, conflict] = await Promise.all([
    database.syncOutbox.get(entityKey),
    database.entitySyncState.get(entityKey),
    database.syncConflicts.get(entityKey),
  ]);
  const outbox: SyncOutboxRecord = {
    entityKey,
    id: createId("mutation"),
    entityType,
    entityId,
    baseVersion: existing?.baseVersion ?? entityState?.serverVersion ?? 0,
    payload: syncPayloadFor(entityType, payload),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  await database.syncOutbox.put(outbox);
  await database.entitySyncState.put({
    id: entityKey,
    entityType,
    entityId,
    serverVersion: entityState?.serverVersion ?? 0,
    status: conflict ? "conflict" : "pending",
    tombstoneAcknowledged: false,
    updatedAt: nowIso,
  });
  if (conflict) {
    await database.syncConflicts.put({
      ...conflict,
      localPayload: structuredClone(payload),
      updatedAt: nowIso,
    });
  }
  return outbox;
}

export async function getSyncOverview(database = ledgerDb): Promise<SyncOverview> {
  const [state, pendingCount, conflictCount] = await database.transaction(
    "r",
    database.syncState,
    database.syncOutbox,
    database.syncConflicts,
    async () => Promise.all([
      database.syncState.get("primary"),
      database.syncOutbox.count(),
      database.syncConflicts.count(),
    ]),
  );
  return {
    linked: Boolean(state),
    accountId: state?.accountId,
    accountEmail: state?.accountEmail,
    generation: state?.generation,
    uploadApproved: state?.uploadApproved ?? false,
    cursor: state?.cursor ?? "0",
    pendingCount,
    conflictCount,
    lastSyncedAt: state?.lastSyncedAt,
  };
}

export async function assertSyncAccount(
  accountId: string,
  database = ledgerDb,
  expectedGeneration?: number,
): Promise<SyncState> {
  const state = await database.syncState.get("primary");
  if (!state) throw new LedgerDataError("The local ledger is not linked", "not-linked");
  if (state.accountId !== accountId) {
    throw new LedgerDataError(
      "This local ledger is linked to a different cloud account",
      "account-mismatch",
    );
  }
  if (
    expectedGeneration !== undefined &&
    state.generation !== expectedGeneration
  ) {
    throw new LedgerDataError(
      "The local ledger is linked to a different cloud generation",
      "sync-generation-mismatch",
    );
  }
  return state;
}

export async function linkSyncAccount(
  session: SessionResponse,
  uploadApproved: boolean,
  database = ledgerDb,
  now = new Date(),
): Promise<SyncState> {
  const nowIso = now.toISOString();
  return database.transaction(
    "rw",
    [
      database.entries,
      database.settings,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      if (
        session.cloud.syncStatus !== "enabled" ||
        !Number.isSafeInteger(session.cloud.generation) ||
        session.cloud.generation < 1
      ) {
        throw new LedgerDataError(
          "Cloud sync must be enabled for a valid generation before linking",
          "sync-generation-mismatch",
        );
      }
      const existing = await database.syncState.get("primary");
      if (existing && existing.accountId !== session.user.id) {
        throw new LedgerDataError(
          "This local ledger is linked to a different cloud account",
          "account-mismatch",
        );
      }
      if (existing && existing.generation !== session.cloud.generation) {
        throw new LedgerDataError(
          "Explicitly relink the ledger after the cloud generation changes",
          "sync-generation-mismatch",
        );
      }
      const state: SyncState = {
        id: "primary",
        accountId: session.user.id,
        accountEmail: session.user.email,
        generation: session.cloud.generation,
        cursor: existing?.cursor ?? "0",
        uploadApproved,
        linkedAt: existing?.linkedAt ?? nowIso,
        lastSyncedAt: existing?.lastSyncedAt,
      };
      await database.syncState.put(state);

      if (uploadApproved) {
        const entries = await database.entries.filter((entry) => !entry.deletedAt).toArray();
        for (const entry of entries) {
          await queueSyncMutation("entry", entry.id, entry, database, nowIso);
        }
        const settings = await database.settings.get("primary");
        if (settings && !(session.cloud.hasData && isDefaultSettings(settings))) {
          await queueSyncMutation("settings", settings.id, settings, database, nowIso);
        }
      }
      return state;
    },
  );
}

export async function unlinkSyncAccount(
  accountId: string,
  database = ledgerDb,
): Promise<void> {
  await database.transaction(
    "rw",
    database.syncState,
    database.entitySyncState,
    database.syncOutbox,
    database.syncConflicts,
    async () => {
      await assertSyncAccount(accountId, database);
      await Promise.all([
        database.syncState.clear(),
        database.entitySyncState.clear(),
        database.syncOutbox.clear(),
        database.syncConflicts.clear(),
      ]);
    },
  );
}

export async function getSettings(database = ledgerDb): Promise<AppSettings> {
  const existing = await database.settings.get("primary");
  if (existing) return existing;
  const defaults = createDefaultSettings();
  await database.settings.put(defaults);
  return defaults;
}

export async function setInitialBalance(
  initialBalanceMinor: number,
  database = ledgerDb,
  now = new Date(),
): Promise<AppSettings> {
  if (
    !Number.isSafeInteger(initialBalanceMinor) ||
    Math.abs(initialBalanceMinor) > MAX_AMOUNT_MINOR
  ) {
    throw new LedgerDataError("初始余额必须是有效的整数分", "invalid-settings");
  }
  return database.transaction(
    "rw",
    database.settings,
    database.syncState,
    database.entitySyncState,
    database.syncOutbox,
    database.syncConflicts,
    async () => {
      const nowIso = now.toISOString();
      const next: AppSettings = {
        ...((await database.settings.get("primary")) ?? createDefaultSettings(now)),
        initialBalanceMinor,
        updatedAt: nowIso,
      };
      await database.settings.put(next);
      await queueSyncMutation("settings", next.id, next, database, nowIso);
      return next;
    },
  );
}

function attachmentFromImage(
  image: ProcessedImage,
  entryId: string,
  nowIso: string,
): Attachment {
  return {
    id: createId("attachment"),
    entryId,
    blob: image.blob,
    mimeType: image.mimeType,
    size: image.size,
    width: image.width,
    height: image.height,
    createdAt: nowIso,
  };
}

async function assertExclusiveAttachmentOwner(
  attachment: Attachment,
  entryId: string,
  database: LedgerDatabase,
): Promise<void> {
  if (attachment.entryId !== entryId) {
    throw new LedgerDataError("截图不属于这条记录", "attachment-mismatch");
  }
  const sharedReference = await database.entries
    .filter((entry) => entry.id !== entryId && entry.attachmentId === attachment.id)
    .first();
  if (sharedReference) {
    throw new LedgerDataError("多条记录引用了同一张截图", "attachment-mismatch");
  }
}

export async function createEntry(
  draft: EntryDraft,
  database = ledgerDb,
  now = new Date(),
): Promise<LedgerEntry> {
  const valid = validateEntryDraft(draft);
  const nowIso = now.toISOString();
  const entryId = createId("entry");
  const attachment = valid.image
    ? attachmentFromImage(valid.image, entryId, nowIso)
    : undefined;
  const entry: LedgerEntry = {
    id: entryId,
    amountMinor: valid.amountMinor,
    note: valid.note,
    occurredAt: valid.occurredAt,
    localDateKey: valid.localDateKey,
    localMonthKey: valid.localMonthKey,
    timezoneOffsetMinutes: valid.timezoneOffsetMinutes,
    attachmentId: attachment?.id,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await database.transaction(
    "rw",
    [
      database.entries,
      database.attachments,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      if (attachment) await database.attachments.add(attachment);
      await database.entries.add(entry);
      await queueSyncMutation("entry", entry.id, entry, database, nowIso);
    },
  );
  return entry;
}

export async function updateEntry(
  entryId: string,
  draft: EntryDraft,
  database = ledgerDb,
  now = new Date(),
): Promise<LedgerEntry> {
  return database.transaction(
    "rw",
    [
      database.entries,
      database.attachments,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
    const existing = await database.entries.get(entryId);
    if (!existing) throw new LedgerDataError("找不到这条记录", "not-found");
    if (existing.deletedAt) throw new LedgerDataError("已删除的记录不能编辑", "already-deleted");

    const existingAttachment = existing.attachmentId
      ? await database.attachments.get(existing.attachmentId)
      : undefined;
    if (existingAttachment) {
      await assertExclusiveAttachmentOwner(existingAttachment, entryId, database);
    }
    const valid = validateEntryDraft(draft, Boolean(existingAttachment));
    const nowIso = now.toISOString();
    let attachmentId = existingAttachment?.id;

    if (valid.image) {
      const replacement = attachmentFromImage(valid.image, entryId, nowIso);
      await database.attachments.add(replacement);
      if (existingAttachment) await database.attachments.delete(existingAttachment.id);
      attachmentId = replacement.id;
    } else if (valid.removeExistingImage && existingAttachment) {
      await database.attachments.delete(existingAttachment.id);
      attachmentId = undefined;
    }

    const updated: LedgerEntry = {
      ...existing,
      amountMinor: valid.amountMinor,
      note: valid.note,
      occurredAt: valid.occurredAt,
      localDateKey: valid.localDateKey,
      localMonthKey: valid.localMonthKey,
      timezoneOffsetMinutes: valid.timezoneOffsetMinutes,
      attachmentId,
      updatedAt: nowIso,
    };
    await database.entries.put(updated);
    await queueSyncMutation("entry", updated.id, updated, database, nowIso);
    return updated;
    },
  );
}

export async function softDeleteEntry(
  entryId: string,
  database = ledgerDb,
  now = new Date(),
): Promise<LedgerEntry> {
  return database.transaction(
    "rw",
    database.entries,
    database.syncState,
    database.entitySyncState,
    database.syncOutbox,
    database.syncConflicts,
    async () => {
    const existing = await database.entries.get(entryId);
    if (!existing) throw new LedgerDataError("找不到这条记录", "not-found");
    if (existing.deletedAt) throw new LedgerDataError("这条记录已经删除", "already-deleted");
    const timestamp = now.toISOString();
    const deleted = { ...existing, deletedAt: timestamp, updatedAt: timestamp };
    await database.entries.put(deleted);
    await queueSyncMutation("entry", deleted.id, deleted, database, timestamp);
    return deleted;
    },
  );
}

export async function undoDeleteEntry(
  entryId: string,
  database = ledgerDb,
  now = new Date(),
): Promise<LedgerEntry> {
  return database.transaction(
    "rw",
    database.entries,
    database.syncState,
    database.entitySyncState,
    database.syncOutbox,
    database.syncConflicts,
    async () => {
    const existing = await database.entries.get(entryId);
    if (!existing) throw new LedgerDataError("找不到这条记录", "not-found");
    if (!existing.deletedAt) throw new LedgerDataError("这条记录并未删除", "not-deleted");
    const nowIso = now.toISOString();
    const restored: LedgerEntry = { ...existing, updatedAt: nowIso };
    delete restored.deletedAt;
    await database.entries.put(restored);
    await queueSyncMutation("entry", restored.id, restored, database, nowIso);
    return restored;
    },
  );
}

export async function purgeDeletedEntry(entryId: string, database = ledgerDb): Promise<void> {
  await database.transaction(
    "rw",
    database.entries,
    database.attachments,
    database.syncState,
    database.entitySyncState,
    database.syncOutbox,
    async () => {
    const existing = await database.entries.get(entryId);
    if (!existing) return;
    if (!existing.deletedAt) {
      throw new LedgerDataError("只能永久清理已删除的记录", "not-deleted");
    }
    await assertDurableTombstone(existing, database);
    if (existing.attachmentId) {
      const attachment = await database.attachments.get(existing.attachmentId);
      if (attachment) {
        await assertExclusiveAttachmentOwner(attachment, entryId, database);
      }
      await database.attachments.delete(existing.attachmentId);
    }
    await database.entries.delete(entryId);
    },
  );
}

async function assertDurableTombstone(
  entry: LedgerEntry,
  database: LedgerDatabase,
): Promise<void> {
  const state = await database.syncState.get("primary");
  if (!state?.uploadApproved) return;
  const outbox = await database.syncOutbox.get(syncEntityKey("entry", entry.id));
  const entityState = await database.entitySyncState.get(syncEntityKey("entry", entry.id));
  if (
    !entityState?.tombstoneAcknowledged &&
    (
      outbox?.entityType !== "entry" ||
      !("deletedAt" in outbox.payload) ||
      !outbox.payload.deletedAt
    )
  ) {
    throw new LedgerDataError(
      "The cloud deletion must be durable before local data is purged",
      "sync-tombstone-missing",
    );
  }
}

export async function purgeDeletedEntries(
  deletedBefore: Date | string,
  database = ledgerDb,
): Promise<number> {
  const cutoff = typeof deletedBefore === "string" ? deletedBefore : deletedBefore.toISOString();
  return database.transaction(
    "rw",
    database.entries,
    database.attachments,
    database.syncState,
    database.entitySyncState,
    database.syncOutbox,
    async () => {
    const entries = await database.entries.filter((entry) => Boolean(entry.deletedAt && entry.deletedAt <= cutoff)).toArray();
    for (const entry of entries) await assertDurableTombstone(entry, database);
    const ownersByAttachmentId = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.attachmentId) continue;
      if (ownersByAttachmentId.has(entry.attachmentId)) {
        throw new LedgerDataError("多条记录引用了同一张截图", "attachment-mismatch");
      }
      ownersByAttachmentId.set(entry.attachmentId, entry.id);
    }
    const attachmentIds = [...ownersByAttachmentId.keys()];
    const deletingEntryIds = new Set(entries.map((entry) => entry.id));
    const externalReference = await database.entries
      .filter((entry) =>
        !deletingEntryIds.has(entry.id) &&
        Boolean(entry.attachmentId && ownersByAttachmentId.has(entry.attachmentId)))
      .first();
    if (externalReference) {
      throw new LedgerDataError("待清理截图仍被其他记录引用", "attachment-mismatch");
    }
    const attachments = await database.attachments.bulkGet(attachmentIds);
    for (let index = 0; index < attachmentIds.length; index += 1) {
      const attachment = attachments[index];
      if (attachment && attachment.entryId !== ownersByAttachmentId.get(attachmentIds[index])) {
        throw new LedgerDataError("截图不属于待清理的记录", "attachment-mismatch");
      }
    }
    await database.attachments.bulkDelete(attachmentIds);
    await database.entries.bulkDelete(entries.map((entry) => entry.id));
    return entries.length;
    },
  );
}

export async function listActiveEntries(database = ledgerDb): Promise<LedgerEntry[]> {
  const entries = await database.entries.orderBy("occurredAt").reverse().toArray();
  return entries.filter((entry) => !entry.deletedAt);
}

export async function getEntry(entryId: string, database = ledgerDb): Promise<LedgerEntry | undefined> {
  return database.entries.get(entryId);
}

export async function getAttachment(
  attachmentId: string,
  database = ledgerDb,
): Promise<Attachment | undefined> {
  return database.attachments.get(attachmentId);
}

export async function getLedgerSummary(
  monthKey = currentLocalMonthKey(),
  database = ledgerDb,
): Promise<LedgerSummary> {
  await getSettings(database);
  const [entries, settings] = await database.transaction(
    "r",
    database.entries,
    database.settings,
    async () => Promise.all([
      database.entries.toArray(),
      database.settings.get("primary"),
    ]),
  );
  if (!settings) {
    throw new LedgerDataError("找不到应用设置", "invalid-settings");
  }
  return calculateLedgerSummary(entries, settings, monthKey);
}

function currentLocalPayload(
  entityType: SyncEntityType,
  entityId: string,
  database: LedgerDatabase,
): Promise<LedgerEntry | AppSettings | undefined> {
  return entityType === "entry"
    ? database.entries.get(entityId)
    : database.settings.get("primary");
}

async function applyRemotePayload(
  change: {
    entityType: SyncEntityType;
    entityId: string;
    payload: LedgerEntry | AppSettings;
  },
  database: LedgerDatabase,
): Promise<void> {
  if (change.entityType === "settings") {
    await database.settings.put(change.payload as AppSettings);
    return;
  }

  const entry = change.payload as LedgerEntry;
  const existing = await database.entries.get(change.entityId);
  if (entry.deletedAt) {
    const attachmentId = existing?.attachmentId ?? entry.attachmentId;
    await database.entries.delete(change.entityId);
    if (attachmentId) {
      const attachment = await database.attachments.get(attachmentId);
      if (attachment) await assertExclusiveAttachmentOwner(attachment, change.entityId, database);
      await database.attachments.delete(attachmentId);
    }
    return;
  }
  if (entry.attachmentId) {
    const remoteAttachment = await database.attachments.get(entry.attachmentId);
    if (remoteAttachment && remoteAttachment.entryId !== entry.id) {
      throw new LedgerDataError("Remote attachment ownership does not match", "attachment-mismatch");
    }
    const sharedReference = await database.entries
      .filter((candidate) =>
        candidate.id !== entry.id && candidate.attachmentId === entry.attachmentId)
      .first();
    if (sharedReference) {
      throw new LedgerDataError("Remote attachment is already referenced", "attachment-mismatch");
    }
  }
  if (existing?.attachmentId && existing.attachmentId !== entry.attachmentId) {
    const oldAttachment = await database.attachments.get(existing.attachmentId);
    if (oldAttachment) await assertExclusiveAttachmentOwner(oldAttachment, entry.id, database);
    await database.attachments.delete(existing.attachmentId);
  }
  await database.entries.put(entry);
}

async function recordConflict(
  change: SyncChange,
  localPayload: LedgerEntry | AppSettings,
  database: LedgerDatabase,
  nowIso: string,
): Promise<void> {
  const id = syncEntityKey(change.entityType, change.entityId);
  const existing = await database.syncConflicts.get(id);
  await database.syncConflicts.put({
    id,
    entityType: change.entityType,
    entityId: change.entityId,
    localPayload: structuredClone(localPayload),
    remotePayload: structuredClone(change.payload),
    remoteVersion: change.version,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  });
  const entityState = await database.entitySyncState.get(id);
  await database.entitySyncState.put({
    id,
    entityType: change.entityType,
    entityId: change.entityId,
    serverVersion: Math.max(entityState?.serverVersion ?? 0, change.version),
    status: "conflict",
    tombstoneAcknowledged: entityState?.tombstoneAcknowledged,
    updatedAt: nowIso,
  });
}

async function applyRemoteChangesInTransaction(
  changes: readonly SyncChange[],
  nextCursor: string,
  remoteAttachments: readonly Attachment[],
  database: LedgerDatabase,
  nowIso: string,
  expectedGeneration?: number,
): Promise<void> {
  const link = await database.syncState.get("primary");
  if (!link) throw new LedgerDataError("The local ledger is not linked", "not-linked");
  if (
    expectedGeneration !== undefined &&
    link.generation !== expectedGeneration
  ) {
    throw new LedgerDataError(
      "The local cloud generation changed while applying sync results",
      "sync-generation-mismatch",
    );
  }

  for (const change of changes) {
    const id = syncEntityKey(change.entityType, change.entityId);
    const [entityState, pending, existingConflict] = await Promise.all([
      database.entitySyncState.get(id),
      database.syncOutbox.get(id),
      database.syncConflicts.get(id),
    ]);
    if (change.version <= (entityState?.serverVersion ?? 0) && !existingConflict) continue;

    if (pending || existingConflict) {
      const localPayload = await currentLocalPayload(
        change.entityType,
        change.entityId,
        database,
      ) ?? pending?.payload;
      if (localPayload) {
        await recordConflict(change, localPayload, database, nowIso);
        continue;
      }
    }

    await applyRemotePayload(change, database);
    await database.syncConflicts.delete(id);
    await database.entitySyncState.put({
      id,
      entityType: change.entityType,
      entityId: change.entityId,
      serverVersion: change.version,
      status: "clean",
      tombstoneAcknowledged:
        change.entityType === "entry" && "deletedAt" in change.payload
          ? Boolean(change.payload.deletedAt)
          : false,
      updatedAt: nowIso,
    });
  }

  for (const attachment of remoteAttachments) {
    const owner = await database.entries.get(attachment.entryId);
    const conflict = await database.syncConflicts.get(
      syncEntityKey("entry", attachment.entryId),
    );
    const conflictAttachmentId =
      conflict?.entityType === "entry" && "attachmentId" in conflict.remotePayload
        ? conflict.remotePayload.attachmentId
        : undefined;
    if (owner?.attachmentId !== attachment.id && conflictAttachmentId !== attachment.id) continue;
    const existing = await database.attachments.get(attachment.id);
    if (existing && existing.entryId !== attachment.entryId) {
      throw new LedgerDataError(
        "Remote attachment ownership does not match",
        "attachment-mismatch",
      );
    }
    await database.attachments.put(attachment);
  }

  await database.syncState.put({
    ...link,
    cursor: nextCursor,
    lastSyncedAt: nowIso,
  });
}

export async function applyRemoteChanges(
  changes: SyncChange[],
  nextCursor: string,
  database = ledgerDb,
  now = new Date(),
  remoteAttachments: readonly Attachment[] = [],
): Promise<void> {
  const nowIso = now.toISOString();
  await database.transaction(
    "rw",
    [
      database.entries,
      database.attachments,
      database.settings,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    () => applyRemoteChangesInTransaction(
      changes,
      nextCursor,
      remoteAttachments,
      database,
      nowIso,
      undefined,
    ),
  );
}

async function markPushResultsInTransaction(
  sentMutations: readonly SyncOutboxRecord[],
  results: readonly SyncResult[],
  database: LedgerDatabase,
  nowIso: string,
): Promise<void> {
  const sentById = new Map(sentMutations.map((mutation) => [mutation.id, mutation]));
  for (const result of results) {
    const sent = sentById.get(result.id);
    if (!sent) continue;
    const current = await database.syncOutbox.get(sent.entityKey);
    if (current?.id !== result.id) continue;

    if (result.status === "conflict") {
      if (
        result.remote.entityType !== sent.entityType ||
        result.remote.entityId !== sent.entityId
      ) {
        throw new LedgerDataError(
          "The server returned a conflict for another entity",
          "sync-conflict",
        );
      }
      const localPayload = await currentLocalPayload(
        sent.entityType,
        sent.entityId,
        database,
      ) ?? sent.payload;
      await recordConflict(result.remote, localPayload, database, nowIso);
      continue;
    }

    await database.syncOutbox.delete(sent.entityKey);
    await database.syncConflicts.delete(sent.entityKey);
    await database.entitySyncState.put({
      id: sent.entityKey,
      entityType: sent.entityType,
      entityId: sent.entityId,
      serverVersion: result.version,
      status: "clean",
      tombstoneAcknowledged:
        sent.entityType === "entry" && "deletedAt" in sent.payload
          ? Boolean(sent.payload.deletedAt)
          : false,
      updatedAt: nowIso,
    });
  }
}

export async function markPushResults(
  sentMutations: readonly SyncOutboxRecord[],
  results: readonly SyncResult[],
  database = ledgerDb,
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  await database.transaction(
    "rw",
    database.entries,
    database.settings,
    database.entitySyncState,
    database.syncOutbox,
    database.syncConflicts,
    () => markPushResultsInTransaction(sentMutations, results, database, nowIso),
  );
}

export async function commitSyncBatch(
  sentMutations: readonly SyncOutboxRecord[],
  results: readonly SyncResult[],
  changes: readonly SyncChange[],
  nextCursor: string,
  remoteAttachments: readonly Attachment[],
  expectedGeneration: number,
  database = ledgerDb,
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  await database.transaction(
    "rw",
    [
      database.entries,
      database.attachments,
      database.settings,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      await markPushResultsInTransaction(sentMutations, results, database, nowIso);
      await applyRemoteChangesInTransaction(
        changes,
        nextCursor,
        remoteAttachments,
        database,
        nowIso,
        expectedGeneration,
      );
    },
  );
}

export type ConflictResolution = "keep-local" | "use-cloud";

export async function resolveSyncConflict(
  entityType: SyncEntityType,
  entityId: string,
  resolution: ConflictResolution,
  database = ledgerDb,
  now = new Date(),
): Promise<void> {
  const id = syncEntityKey(entityType, entityId);
  const nowIso = now.toISOString();
  await database.transaction(
    "rw",
    [
      database.entries,
      database.attachments,
      database.settings,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const conflict = await database.syncConflicts.get(id);
      if (!conflict) throw new LedgerDataError("The sync conflict no longer exists", "sync-conflict");

      if (resolution === "use-cloud") {
        const remoteAttachmentId =
          entityType === "entry" && "attachmentId" in conflict.remotePayload
            ? conflict.remotePayload.attachmentId
            : undefined;
        if (remoteAttachmentId && !(await database.attachments.get(remoteAttachmentId))) {
          throw new LedgerDataError(
            "Download the cloud attachment before using the cloud version",
            "sync-conflict",
          );
        }
        await applyRemotePayload({
          entityType,
          entityId,
          payload: conflict.remotePayload,
        }, database);
        await database.syncOutbox.delete(id);
        await database.syncConflicts.delete(id);
        await database.entitySyncState.put({
          id,
          entityType,
          entityId,
          serverVersion: conflict.remoteVersion,
          status: "clean",
          tombstoneAcknowledged:
            entityType === "entry" && "deletedAt" in conflict.remotePayload
              ? Boolean(conflict.remotePayload.deletedAt)
              : false,
          updatedAt: nowIso,
        });
        return;
      }

      const localPayload = await currentLocalPayload(entityType, entityId, database)
        ?? conflict.localPayload;
      const localAttachmentId =
        entityType === "entry" && "attachmentId" in localPayload
          ? localPayload.attachmentId
          : undefined;
      const remoteAttachmentId =
        entityType === "entry" && "attachmentId" in conflict.remotePayload
          ? conflict.remotePayload.attachmentId
          : undefined;
      const existingOutbox = await database.syncOutbox.get(id);
      await database.syncOutbox.put({
        entityKey: id,
        id: createId("mutation"),
        entityType,
        entityId,
        baseVersion: conflict.remoteVersion,
        payload: syncPayloadFor(entityType, localPayload),
        createdAt: existingOutbox?.createdAt ?? nowIso,
        updatedAt: nowIso,
      });
      await database.syncConflicts.delete(id);
      if (remoteAttachmentId && remoteAttachmentId !== localAttachmentId) {
        const remoteAttachment = await database.attachments.get(remoteAttachmentId);
        if (remoteAttachment) {
          await assertExclusiveAttachmentOwner(remoteAttachment, entityId, database);
          await database.attachments.delete(remoteAttachmentId);
        }
      }
      await database.entitySyncState.put({
        id,
        entityType,
        entityId,
        serverVersion: conflict.remoteVersion,
        status: "pending",
        tombstoneAcknowledged: false,
        updatedAt: nowIso,
      });
    },
  );
}

export async function cacheRemoteAttachment(
  attachment: Attachment,
  expectedGeneration: number,
  database = ledgerDb,
): Promise<void> {
  await database.transaction(
    "rw",
    database.entries,
    database.attachments,
    database.syncState,
    async () => {
      const link = await database.syncState.get("primary");
      if (!link || link.generation !== expectedGeneration) {
        throw new LedgerDataError(
          "The local cloud generation changed while caching an attachment",
          "sync-generation-mismatch",
        );
      }
      const entry = await database.entries.get(attachment.entryId);
      if (!entry || entry.attachmentId !== attachment.id) {
        throw new LedgerDataError(
          "Remote attachment ownership does not match",
          "attachment-mismatch",
        );
      }
      const existing = await database.attachments.get(attachment.id);
      if (existing && existing.entryId !== attachment.entryId) {
        throw new LedgerDataError(
          "Remote attachment ownership does not match",
          "attachment-mismatch",
        );
      }
      await database.attachments.put(attachment);
    },
  );
}

export interface LedgerReplacement {
  settings: AppSettings;
  entries: LedgerEntry[];
  attachments: Attachment[];
}

export async function replaceLedgerData(
  replacement: LedgerReplacement,
  database = ledgerDb,
): Promise<void> {
  await database.transaction(
    "rw",
    database.settings,
    database.entries,
    database.attachments,
    database.syncState,
    async () => {
      if (await database.syncState.get("primary")) {
        throw new LedgerDataError(
          "Unlink cloud sync before replacing the entire local ledger",
          "sync-linked",
        );
      }
      await database.attachments.clear();
      await database.entries.clear();
      await database.settings.clear();
      await database.settings.add(replacement.settings);
      if (replacement.entries.length) await database.entries.bulkAdd(replacement.entries);
      if (replacement.attachments.length) {
        await database.attachments.bulkAdd(replacement.attachments);
      }
    },
  );
}
