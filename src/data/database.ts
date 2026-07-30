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

export const DATABASE_NAME = "jiyibi";
export const DATABASE_SCHEMA_VERSION = 1 as const;

export class LedgerDataError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not-found"
      | "already-deleted"
      | "not-deleted"
      | "invalid-settings"
      | "attachment-mismatch",
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

  constructor(name = DATABASE_NAME) {
    super(name);
    this.version(DATABASE_SCHEMA_VERSION).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt",
      attachments: "id, entryId, createdAt",
      settings: "id",
    });
    this.on("populate", (transaction) =>
      transaction.table<AppSettings>("settings").add(createDefaultSettings()),
    );
  }
}

export const ledgerDb = new LedgerDatabase();

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
  const next: AppSettings = {
    ...(await getSettings(database)),
    initialBalanceMinor,
    updatedAt: now.toISOString(),
  };
  await database.settings.put(next);
  return next;
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

  await database.transaction("rw", database.entries, database.attachments, async () => {
    if (attachment) await database.attachments.add(attachment);
    await database.entries.add(entry);
  });
  return entry;
}

export async function updateEntry(
  entryId: string,
  draft: EntryDraft,
  database = ledgerDb,
  now = new Date(),
): Promise<LedgerEntry> {
  return database.transaction("rw", database.entries, database.attachments, async () => {
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
    return updated;
  });
}

export async function softDeleteEntry(
  entryId: string,
  database = ledgerDb,
  now = new Date(),
): Promise<LedgerEntry> {
  return database.transaction("rw", database.entries, async () => {
    const existing = await database.entries.get(entryId);
    if (!existing) throw new LedgerDataError("找不到这条记录", "not-found");
    if (existing.deletedAt) throw new LedgerDataError("这条记录已经删除", "already-deleted");
    const timestamp = now.toISOString();
    const deleted = { ...existing, deletedAt: timestamp, updatedAt: timestamp };
    await database.entries.put(deleted);
    return deleted;
  });
}

export async function undoDeleteEntry(
  entryId: string,
  database = ledgerDb,
  now = new Date(),
): Promise<LedgerEntry> {
  return database.transaction("rw", database.entries, async () => {
    const existing = await database.entries.get(entryId);
    if (!existing) throw new LedgerDataError("找不到这条记录", "not-found");
    if (!existing.deletedAt) throw new LedgerDataError("这条记录并未删除", "not-deleted");
    const restored: LedgerEntry = { ...existing, updatedAt: now.toISOString() };
    delete restored.deletedAt;
    await database.entries.put(restored);
    return restored;
  });
}

export async function purgeDeletedEntry(entryId: string, database = ledgerDb): Promise<void> {
  await database.transaction("rw", database.entries, database.attachments, async () => {
    const existing = await database.entries.get(entryId);
    if (!existing) return;
    if (!existing.deletedAt) {
      throw new LedgerDataError("只能永久清理已删除的记录", "not-deleted");
    }
    if (existing.attachmentId) {
      const attachment = await database.attachments.get(existing.attachmentId);
      if (attachment) {
        await assertExclusiveAttachmentOwner(attachment, entryId, database);
      }
      await database.attachments.delete(existing.attachmentId);
    }
    await database.entries.delete(entryId);
  });
}

export async function purgeDeletedEntries(
  deletedBefore: Date | string,
  database = ledgerDb,
): Promise<number> {
  const cutoff = typeof deletedBefore === "string" ? deletedBefore : deletedBefore.toISOString();
  return database.transaction("rw", database.entries, database.attachments, async () => {
    const entries = await database.entries.filter((entry) => Boolean(entry.deletedAt && entry.deletedAt <= cutoff)).toArray();
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
  });
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
    async () => {
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
