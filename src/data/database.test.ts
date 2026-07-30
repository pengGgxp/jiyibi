import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntryDraft, LedgerEntry, ProcessedImage } from "../domain/types";
import {
  LedgerDatabase,
  createDefaultSettings,
  createEntry,
  getAttachment,
  getLedgerSummary,
  getSettings,
  listActiveEntries,
  purgeDeletedEntry,
  replaceLedgerData,
  setInitialBalance,
  softDeleteEntry,
  undoDeleteEntry,
  updateEntry,
} from "./database";

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return {
    kind: "expense",
    amount: "12.34",
    note: "午餐",
    occurredAtLocal: "2026-07-30T12:30",
    ...overrides,
  };
}

function image(contents = "image"): ProcessedImage {
  const blob = new Blob([contents], { type: "image/jpeg" });
  return { blob, mimeType: blob.type, size: blob.size, width: 100, height: 80 };
}

describe("LedgerDatabase", () => {
  let database: LedgerDatabase;

  beforeEach(async () => {
    database = new LedgerDatabase(`jiyibi-test-${crypto.randomUUID()}`);
    await database.open();
  });

  afterEach(async () => {
    database.close();
    await database.delete();
  });

  it("creates the initial CNY/zero settings", async () => {
    await expect(getSettings(database)).resolves.toMatchObject({
      id: "primary",
      currency: "CNY",
      initialBalanceMinor: 0,
      schemaVersion: 1,
    });
  });

  it("creates, edits and summarizes signed entries", async () => {
    const created = await createEntry(draft(), database);
    expect(created.amountMinor).toBe(-1234);

    await setInitialBalance(5_000, database);
    await updateEntry(created.id, draft({ kind: "income", amount: "20", note: "退款" }), database);

    expect(await listActiveEntries(database)).toHaveLength(1);
    await expect(getLedgerSummary("2026-07", database)).resolves.toEqual({
      balanceMinor: 7_000,
      monthIncomeMinor: 2_000,
      monthExpenseMinor: 0,
    });
  });

  it("keeps an attachment during undo and removes it only after purge", async () => {
    const created = await createEntry(draft({ note: "", image: image() }), database);
    expect(created.attachmentId).toBeTruthy();
    const attachmentId = created.attachmentId!;

    await softDeleteEntry(created.id, database, new Date("2026-07-30T12:31:00.000Z"));
    expect(await listActiveEntries(database)).toEqual([]);
    expect(await getAttachment(attachmentId, database)).toBeDefined();

    await undoDeleteEntry(created.id, database);
    expect(await listActiveEntries(database)).toHaveLength(1);
    await softDeleteEntry(created.id, database);
    await purgeDeletedEntry(created.id, database);
    expect(await database.entries.get(created.id)).toBeUndefined();
    expect(await getAttachment(attachmentId, database)).toBeUndefined();
  });

  it("replaces and removes screenshots transactionally during edit", async () => {
    const created = await createEntry(draft({ image: image("old") }), database);
    const oldAttachmentId = created.attachmentId!;
    const updated = await updateEntry(created.id, draft({ image: image("new") }), database);

    expect(updated.attachmentId).not.toBe(oldAttachmentId);
    expect(await getAttachment(oldAttachmentId, database)).toBeUndefined();
    expect(await getAttachment(updated.attachmentId!, database)).toBeDefined();

    const withoutImage = await updateEntry(
      created.id,
      draft({ image: undefined, removeExistingImage: true }),
      database,
    );
    expect(withoutImage.attachmentId).toBeUndefined();
    expect(await database.attachments.count()).toBe(0);
  });

  it("refuses to edit or purge a cross-owned attachment", async () => {
    const owner = await createEntry(draft({ image: image("owned") }), database);
    const borrower = await createEntry(draft({ note: "borrower" }), database);
    await database.entries.update(borrower.id, { attachmentId: owner.attachmentId });

    await expect(updateEntry(owner.id, draft({ note: "owner edited" }), database)).rejects.toMatchObject({
      code: "attachment-mismatch",
    });
    await softDeleteEntry(borrower.id, database);
    await expect(purgeDeletedEntry(borrower.id, database)).rejects.toMatchObject({
      code: "attachment-mismatch",
    });
    expect(await getAttachment(owner.attachmentId!, database)).toBeDefined();
  });

  it("rolls back settings, entries and attachments when replacement fails", async () => {
    const original = await createEntry(draft({ image: image("original") }), database);
    await setInitialBalance(5_000, database);
    const originalAttachment = await getAttachment(original.attachmentId!, database);
    const replacementEntry: LedgerEntry = {
      ...original,
      id: "replacement-entry",
      attachmentId: "replacement-attachment",
    };
    const replacementAttachment = {
      ...originalAttachment!,
      id: "replacement-attachment",
      entryId: replacementEntry.id,
    };
    const settings = {
      ...createDefaultSettings(),
      initialBalanceMinor: -500,
    };

    await expect(
      replaceLedgerData({
        settings,
        entries: [replacementEntry],
        attachments: [replacementAttachment, replacementAttachment],
      }, database),
    ).rejects.toBeDefined();
    await expect(database.entries.toArray()).resolves.toEqual([original]);
    expect((await getSettings(database)).initialBalanceMinor).toBe(5_000);
    await expect(database.attachments.toArray()).resolves.toEqual([originalAttachment]);
  });
});
