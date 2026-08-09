import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Attachment, EntryDraft, LedgerEntry, ProcessedImage } from "../domain/types";
import {
  BACKUP_FORMAT,
  MAX_BACKUP_ATTACHMENTS,
  MAX_BACKUP_ATTACHMENT_BYTES,
  MAX_BACKUP_ENTRIES,
  MAX_BACKUP_SOURCE_BYTES,
  createEncryptedBackup,
  decryptBackup,
  restorePreparedBackup,
  type PreparedBackup,
} from "./backup";
import {
  LedgerDatabase,
  createEntry,
  getSettings,
  setInitialBalance,
  setMonthEndBalanceGoal,
} from "./database";

interface TestEnvelope {
  format: string;
  envelopeVersion: number;
  encryption: {
    iterations: number;
    salt: string;
    iv: string;
  };
  ciphertext: string;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function blobToText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

async function rewriteEncryptedPayload(
  backup: Blob,
  password: string,
  mutate: (payload: Record<string, unknown>) => void,
): Promise<string> {
  const envelope = JSON.parse(await blobToText(backup)) as TestEnvelope;
  const salt = base64ToBytes(envelope.encryption.salt);
  const iv = base64ToBytes(envelope.encryption.iv);
  const material = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await globalThis.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: bytesToArrayBuffer(salt),
      iterations: envelope.encryption.iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const additionalData = new TextEncoder().encode("jiyibi-backup:v1");
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesToArrayBuffer(iv), additionalData },
    key,
    bytesToArrayBuffer(base64ToBytes(envelope.ciphertext)),
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
  mutate(payload);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytesToArrayBuffer(iv), additionalData },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  envelope.ciphertext = bytesToBase64(new Uint8Array(ciphertext));
  return JSON.stringify(envelope);
}

function validEntry(index: number, attachmentId?: string): LedgerEntry {
  return {
    id: `entry-${index}`,
    amountMinor: 100,
    note: "测试",
    occurredAt: "2026-07-30T08:30:00.000Z",
    localDateKey: "2026-07-30",
    localMonthKey: "2026-07",
    timezoneOffsetMinutes: 0,
    attachmentId,
    createdAt: "2026-07-30T08:30:00.000Z",
    updatedAt: "2026-07-30T08:30:00.000Z",
  };
}

function preparedWith(entries: LedgerEntry[], attachments: Attachment[]): PreparedBackup {
  return {
    preview: {
      exportedAt: "2026-07-30T10:00:00.000Z",
      entryCount: entries.length,
      attachmentCount: attachments.length,
      initialBalanceMinor: 0,
      currency: "CNY",
    },
    replacement: {
      settings: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 0,
        schemaVersion: 1,
        updatedAt: "2026-07-30T10:00:00.000Z",
      },
      entries,
      attachments,
    },
  };
}

function image(): ProcessedImage {
  // fake-indexeddb preserves Node's structured-cloneable Blob implementation.
  const blob = new NodeBlob([new Uint8Array([1, 2, 3, 4])], {
    type: "image/jpeg",
  }) as unknown as Blob;
  return { blob, mimeType: blob.type, size: blob.size, width: 2, height: 2 };
}

function draft(): EntryDraft {
  return {
    kind: "income",
    amount: "88.01",
    note: "测试收入",
    occurredAtLocal: "2026-07-30T08:30",
    image: image(),
  };
}

describe("encrypted backups", () => {
  let source: LedgerDatabase;
  let target: LedgerDatabase;
  let originalCrypto: Crypto;

  beforeAll(() => {
    originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: webcrypto,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  });

  beforeEach(async () => {
    source = new LedgerDatabase(`jiyibi-backup-source-${webcrypto.randomUUID()}`);
    target = new LedgerDatabase(`jiyibi-backup-target-${webcrypto.randomUUID()}`);
    await Promise.all([source.open(), target.open()]);
  });

  afterEach(async () => {
    source.close();
    target.close();
    await Promise.all([source.delete(), target.delete()]);
  });

  it("round trips settings, active entries and screenshots", async () => {
    await setInitialBalance(-500, source);
    await setMonthEndBalanceGoal(123_456, source);
    const active = await createEntry(draft(), source);
    const deleted = await createEntry({ ...draft(), note: "deleted" }, source);
    await source.entries.update(deleted.id, { deletedAt: "2026-07-30T09:00:00.000Z" });
    await setInitialBalance(99_999, target);
    const replaced = await createEntry({ ...draft(), note: "待替换记录" }, target);
    const replacedAttachmentId = replaced.attachmentId!;

    const backup = await createEncryptedBackup(
      "correct horse battery staple",
      source,
      new Date("2026-07-30T10:00:00.000Z"),
    );
    const prepared = await decryptBackup(backup, "correct horse battery staple");
    expect(prepared.preview).toEqual({
      exportedAt: "2026-07-30T10:00:00.000Z",
      entryCount: 1,
      attachmentCount: 1,
      initialBalanceMinor: -500,
      monthEndBalanceGoalMinor: 123_456,
      currency: "CNY",
    });

    await restorePreparedBackup(prepared, target);
    expect(await target.entries.toArray()).toEqual([
      expect.objectContaining({ id: active.id, amountMinor: 8801, note: "测试收入" }),
    ]);
    expect(await target.attachments.count()).toBe(1);
    expect(await target.entries.get(replaced.id)).toBeUndefined();
    expect(await target.attachments.get(replacedAttachmentId)).toBeUndefined();
    expect(await getSettings(target)).toMatchObject({
      initialBalanceMinor: -500,
      monthEndBalanceGoalMinor: 123_456,
    });
  });

  it("restores a legacy backup whose settings omit the month-end goal", async () => {
    await setMonthEndBalanceGoal(88_800, source);
    const backup = await createEncryptedBackup("legacy-goal-password", source);
    const legacyBackup = await rewriteEncryptedPayload(
      backup,
      "legacy-goal-password",
      (payload) => {
        delete (payload.settings as Record<string, unknown>).monthEndBalanceGoalMinor;
      },
    );
    await setMonthEndBalanceGoal(-9_900, target);

    const prepared = await decryptBackup(legacyBackup, "legacy-goal-password");
    expect(prepared.preview.monthEndBalanceGoalMinor).toBeUndefined();
    expect(prepared.replacement.settings).not.toHaveProperty("monthEndBalanceGoalMinor");

    await restorePreparedBackup(prepared, target);
    expect(await getSettings(target)).not.toHaveProperty("monthEndBalanceGoalMinor");
  });

  it("rejects a wrong password without exposing data", async () => {
    await createEntry(draft(), source);
    const backup = await createEncryptedBackup("right-password", source);
    await expect(decryptBackup(backup, "wrong-password")).rejects.toMatchObject({
      code: "decrypt-failed",
    });
  });

  it("rejects a backup with corrupted authenticated ciphertext", async () => {
    await createEntry(draft(), source);
    const backup = await createEncryptedBackup("tamper-password", source);
    const envelope = JSON.parse(await blobToText(backup)) as TestEnvelope;
    envelope.ciphertext = `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`;

    await expect(
      decryptBackup(JSON.stringify(envelope), "tamper-password"),
    ).rejects.toMatchObject({ code: "decrypt-failed" });
  });

  it("rejects an authenticated future payload schema", async () => {
    const backup = await createEncryptedBackup("future-password", source);
    const futureBackup = await rewriteEncryptedPayload(
      backup,
      "future-password",
      (payload) => { payload.schemaVersion = 999; },
    );
    await expect(decryptBackup(futureBackup, "future-password")).rejects.toMatchObject({
      code: "unsupported-version",
    });
  });

  it("rejects an unsupported future envelope version", async () => {
    const futureEnvelope = JSON.stringify({
      format: BACKUP_FORMAT,
      envelopeVersion: 999,
      encryption: {},
      ciphertext: "",
    });
    await expect(decryptBackup(futureEnvelope, "password")).rejects.toMatchObject({
      code: "unsupported-version",
    });
  });

  it("rejects a shared or cross-owned attachment before replacing existing data", async () => {
    const owner = await createEntry(draft(), source);
    const borrower = await createEntry({ ...draft(), note: "borrower", image: undefined }, source);
    const backup = await createEncryptedBackup("ownership-password", source);
    const prepared = await decryptBackup(backup, "ownership-password");
    const preparedBorrower = prepared.replacement.entries.find((entry) => entry.id === borrower.id)!;
    preparedBorrower.attachmentId = owner.attachmentId;
    const existing = await createEntry({ ...draft(), note: "现有记录" }, target);

    await expect(restorePreparedBackup(prepared, target)).rejects.toMatchObject({
      code: "invalid-payload",
    });
    expect(await target.entries.get(existing.id)).toBeDefined();
    expect(await target.attachments.get(existing.attachmentId!)).toBeDefined();
  });

  it("rejects a local date that disagrees with the instant and stored offset", async () => {
    const backup = await createEncryptedBackup("date-password", source);
    const invalidDateBackup = await rewriteEncryptedPayload(
      backup,
      "date-password",
      (payload) => {
        payload.entries = [
          {
            ...validEntry(1),
            localDateKey: "2026-07-31",
          },
        ];
      },
    );
    await expect(decryptBackup(invalidDateBackup, "date-password")).rejects.toMatchObject({
      code: "invalid-payload",
    });
  });

  it("rejects an oversized backup source before reading it", async () => {
    const oversized = { size: MAX_BACKUP_SOURCE_BYTES + 1 } as Blob;
    await expect(decryptBackup(oversized, "password")).rejects.toMatchObject({
      code: "limit-exceeded",
    });
  });

  it("enforces record and attachment count limits", async () => {
    const tooManyEntries = Array.from(
      { length: MAX_BACKUP_ENTRIES + 1 },
      (_, index) => validEntry(index),
    );
    await expect(
      restorePreparedBackup(preparedWith(tooManyEntries, []), target),
    ).rejects.toMatchObject({ code: "limit-exceeded" });

    const tinyBlob = new Blob(["x"], { type: "image/jpeg" });
    const entries: LedgerEntry[] = [];
    const attachments: Attachment[] = [];
    for (let index = 0; index <= MAX_BACKUP_ATTACHMENTS; index += 1) {
      const attachmentId = `attachment-${index}`;
      entries.push(validEntry(index, attachmentId));
      attachments.push({
        id: attachmentId,
        entryId: `entry-${index}`,
        blob: tinyBlob,
        mimeType: "image/jpeg",
        size: tinyBlob.size,
        width: 1,
        height: 1,
        createdAt: "2026-07-30T08:30:00.000Z",
      });
    }
    await expect(
      restorePreparedBackup(preparedWith(entries, attachments), target),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  it("enforces the total attachment byte limit", async () => {
    const tinyBlob = new Blob(["x"], { type: "image/jpeg" });
    const attachmentSize = 1024 * 1024;
    const count = Math.floor(MAX_BACKUP_ATTACHMENT_BYTES / attachmentSize) + 1;
    const entries: LedgerEntry[] = [];
    const attachments: Attachment[] = [];
    for (let index = 0; index < count; index += 1) {
      const attachmentId = `attachment-${index}`;
      entries.push(validEntry(index, attachmentId));
      attachments.push({
        id: attachmentId,
        entryId: `entry-${index}`,
        blob: tinyBlob,
        mimeType: "image/jpeg",
        size: attachmentSize,
        width: 1,
        height: 1,
        createdAt: "2026-07-30T08:30:00.000Z",
      });
    }
    await expect(
      restorePreparedBackup(preparedWith(entries, attachments), target),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
  });
});
