import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  Attachment,
  EntryDraft,
  LedgerEntry,
  ProcessedImage,
  RecoveryAllocation,
  SavingsEvent,
} from "../domain/types";
import {
  BACKUP_FORMAT,
  BACKUP_PAYLOAD_SCHEMA_VERSION,
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
  listActiveSavingsEvents,
  releaseSavings,
  reserveSavings,
  setInitialBalance,
  setInitialSavings,
  setIncomeForecast,
  setMonthEndBalanceGoal,
  setPayCyclePlan,
  setSavingsGoal,
  upsertRecoveryAllocation,
  updateEntryTreatment,
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
    treatment: "ordinary_income",
    confirmationStatus: "not_needed",
    createdAt: "2026-07-30T08:30:00.000Z",
    updatedAt: "2026-07-30T08:30:00.000Z",
  };
}

function preparedWith(
  entries: LedgerEntry[],
  attachments: Attachment[],
  recoveryAllocations: RecoveryAllocation[] = [],
  savingsEvents: SavingsEvent[] = [],
): PreparedBackup {
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
      recoveryAllocations,
      savingsEvents,
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
    const payCycle = {
      paydayDay: 10,
    };
    const planNow = new Date(2026, 6, 30, 10);
    await setPayCyclePlan(payCycle, source, planNow);
    const forecastSettings = await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 800_000,
    }, source, planNow);
    const incomeForecast = forecastSettings.incomeForecast;
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
      monthEndBalanceGoalMinor: undefined,
      payCycle: { paydayDay: 10 },
      incomeForecast,
      savingsEventCount: 0,
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
      payCycle: { paydayDay: 10 },
      incomeForecast,
    });
  });

  it("round trips treatment metadata and recovery allocations", async () => {
    const expense = await createEntry({
      ...draft(),
      kind: "expense",
      amount: "100.00",
      note: "可报销支出",
      image: undefined,
    }, source, new Date("2026-07-30T08:30:00.000Z"));
    const refund = await createEntry({
      ...draft(),
      amount: "60.00",
      note: "报销到账",
      image: undefined,
    }, source, new Date("2026-07-30T08:31:00.000Z"));
    await updateEntryTreatment(expense.id, "reimbursable_expense", {
      confirmationStatus: "confirmed",
      detectionRuleVersion: 1,
      markPrompted: true,
    }, source, new Date("2026-07-30T09:00:00.000Z"));
    await updateEntryTreatment(refund.id, "refund_reimbursement", {
      confirmationStatus: "confirmed",
    }, source, new Date("2026-07-30T09:01:00.000Z"));
    const allocation = await upsertRecoveryAllocation({
      refundEntryId: refund.id,
      expenseEntryId: expense.id,
      amountMinor: 6_000,
    }, source, new Date("2026-07-30T09:02:00.000Z"));

    const backup = await createEncryptedBackup("treatment-password", source);
    const prepared = await decryptBackup(backup, "treatment-password");
    expect(prepared.replacement.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expense.id, treatment: "reimbursable_expense" }),
      expect.objectContaining({ id: refund.id, treatment: "refund_reimbursement" }),
    ]));
    expect(prepared.replacement.recoveryAllocations).toEqual([allocation]);

    await restorePreparedBackup(prepared, target);
    expect(await target.recoveryAllocations.toArray()).toEqual([allocation]);
  });

  it("round trips a savings goal and retained-money events in payload v5", async () => {
    const now = new Date(2026, 7, 9, 10);
    await setInitialBalance(100_000, source, now);
    await setPayCyclePlan({
      paydayDay: 10,
    }, source, now);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 80_000,
    }, source, now);
    await setSavingsGoal({ targetDateKey: "2026-12-31", targetMinor: 250_000 }, source, now);
    await setInitialSavings(30_000, source, new Date(2026, 6, 1, 9));
    await reserveSavings({ amountMinor: 5_000, note: "本周期追加" }, source, now);
    await releaseSavings({ amountMinor: 2_000, note: "临时取用" }, source, now);

    const backup = await createEncryptedBackup("savings-round-trip", source, now);
    const envelope = JSON.parse(await blobToText(backup)) as TestEnvelope;
    expect(envelope.envelopeVersion).toBe(1);

    const prepared = await decryptBackup(backup, "savings-round-trip");
    expect(prepared.preview).toMatchObject({
      savingsEventCount: 3,
      payCycle: { paydayDay: 10 },
      savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 250_000 },
    });
    expect(prepared.replacement.savingsEvents).toHaveLength(3);

    await restorePreparedBackup(prepared, target);
    expect(await getSettings(target)).toMatchObject({
      payCycle: { paydayDay: 10 },
      savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 250_000 },
    });
    expect(await listActiveSavingsEvents(target)).toEqual(
      expect.arrayContaining(prepared.replacement.savingsEvents as SavingsEvent[]),
    );
  });

  it("migrates a payload v3 balance floor without inventing savings history", async () => {
    const backup = await createEncryptedBackup("legacy-savings", source);
    const legacy = await rewriteEncryptedPayload(backup, "legacy-savings", (payload) => {
      payload.schemaVersion = 3;
      delete payload.savingsEvents;
      const settings = payload.settings as Record<string, unknown>;
      settings.payCycle = {
        paydayDay: 10,
        cycleEndBalanceGoalMinor: -12_345,
      };
      delete settings.savingsTargetOverride;
    });

    const prepared = await decryptBackup(legacy, "legacy-savings");
    expect(prepared.replacement.settings).toMatchObject({
      payCycle: { paydayDay: 10 },
      savingsGoalNeedsSetup: true,
    });
    expect(prepared.replacement.savingsEvents).toEqual([]);

    await restorePreparedBackup(prepared, target);
    expect(await getSettings(target)).toMatchObject({
      payCycle: { paydayDay: 10 },
      savingsGoalNeedsSetup: true,
    });
    expect(await target.savingsEvents.count()).toBe(0);
  });

  it("normalizes v2 entries conservatively and restores no allocations", async () => {
    const backup = await createEncryptedBackup("legacy-v2-password", source);
    const legacy = await rewriteEncryptedPayload(backup, "legacy-v2-password", (payload) => {
      payload.schemaVersion = 2;
      delete payload.recoveryAllocations;
      payload.entries = [{
        ...validEntry(1),
        amountMinor: -100,
        note: "旧支出",
        treatment: undefined,
        confirmationStatus: undefined,
      }];
    });

    const prepared = await decryptBackup(legacy, "legacy-v2-password");
    expect(prepared.replacement.entries[0]).toMatchObject({
      treatment: "ordinary_expense",
      confirmationStatus: "not_needed",
    });
    expect(prepared.replacement.recoveryAllocations).toEqual([]);
  });

  it("rejects invalid recovery allocations before replacing existing data", async () => {
    const refund = { ...validEntry(1), amountMinor: 5_000, treatment: "refund_reimbursement" as const };
    const expense = { ...validEntry(2), amountMinor: -10_000, treatment: "ordinary_expense" as const };
    const existing = await createEntry({ ...draft(), note: "现有记录", image: undefined }, target);
    const invalidAllocation: RecoveryAllocation = {
      id: "recovery-invalid",
      refundEntryId: refund.id,
      expenseEntryId: expense.id,
      amountMinor: 5_001,
      createdAt: "2026-07-30T09:00:00.000Z",
      updatedAt: "2026-07-30T09:00:00.000Z",
    };

    await expect(restorePreparedBackup(
      preparedWith([refund, expense], [], [invalidAllocation]),
      target,
    )).rejects.toMatchObject({ code: "invalid-payload" });
    expect(await target.entries.get(existing.id)).toBeDefined();
  });

  it("rejects linked savings releases whose total exceeds the expense", async () => {
    const expense = {
      ...validEntry(2),
      amountMinor: -10_000,
      treatment: "one_time_expense" as const,
    };
    const existing = await createEntry({ ...draft(), note: "现有记录", image: undefined }, target);
    const release = (id: string, amountMinor: number): SavingsEvent => ({
      id,
      kind: "release",
      amountMinor,
      note: "关联取用",
      occurredAt: "2026-07-30T08:30:00.000Z",
      localDateKey: "2026-07-30",
      localMonthKey: "2026-07",
      timezoneOffsetMinutes: 0,
      linkedExpenseEntryId: expense.id,
      createdAt: "2026-07-30T08:30:00.000Z",
      updatedAt: "2026-07-30T08:30:00.000Z",
    });

    await expect(restorePreparedBackup(
      preparedWith(
        [expense],
        [],
        [],
        [release("savings-release-a", 6_000), release("savings-release-b", 5_000)],
      ),
      target,
    )).rejects.toMatchObject({ code: "invalid-payload" });
    expect(await target.entries.get(existing.id)).toBeDefined();
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

  it("migrates a v1 monthly salary into a one-time expected income", async () => {
    const backup = await createEncryptedBackup("legacy-income-password", source);
    const legacyBackup = await rewriteEncryptedPayload(
      backup,
      "legacy-income-password",
      (payload) => {
        payload.schemaVersion = 1;
        const settings = payload.settings as Record<string, unknown>;
        settings.payCycle = {
          paydayDay: 31,
          monthlySalaryMinor: 800_000,
          cycleEndBalanceGoalMinor: 100_000,
        };
        delete settings.incomeForecast;
      },
    );
    const restoreNow = new Date(2026, 1, 28, 12);

    const prepared = await decryptBackup(
      legacyBackup,
      "legacy-income-password",
      restoreNow,
    );
    expect(prepared.preview).toMatchObject({
      payCycle: { paydayDay: 31 },
      incomeForecast: {
        id: "legacy-income-2026-02-28",
        targetPaydayDateKey: "2026-02-28",
        expectedIncomeMinor: 800_000,
      },
    });
    expect(prepared.preview.payCycle).not.toHaveProperty("monthlySalaryMinor");

    await restorePreparedBackup(prepared, target);
    expect(await getSettings(target)).toMatchObject({
      payCycle: { paydayDay: 31 },
      savingsGoalNeedsSetup: true,
      lastExpectedIncomeMinor: 800_000,
      incomeForecast: {
        targetPaydayDateKey: "2026-02-28",
        expectedIncomeMinor: 800_000,
      },
    });
  });

  it("rejects a v5 backup that mixes a pay-cycle with a legacy target", async () => {
    await setPayCyclePlan({
      paydayDay: 10,
    }, source);
    const backup = await createEncryptedBackup("partial-plan-password", source);
    const partial = await rewriteEncryptedPayload(
      backup,
      "partial-plan-password",
      (payload) => {
        (payload.settings as Record<string, unknown>).payCycle = {
          paydayDay: 10,
          defaultSavingsTargetMinor: 100_000,
        };
      },
    );

    await expect(decryptBackup(partial, "partial-plan-password")).rejects.toMatchObject({
      code: "invalid-payload",
    });
  });

  it("rejects a v5 backup that marks an existing goal as needing setup", async () => {
    await setSavingsGoal(
      { targetDateKey: "2026-12-31", targetMinor: 100_000 },
      source,
    );
    const backup = await createEncryptedBackup("contradictory-goal", source);
    const contradictory = await rewriteEncryptedPayload(
      backup,
      "contradictory-goal",
      (payload) => {
        (payload.settings as Record<string, unknown>).savingsGoalNeedsSetup = true;
      },
    );

    await expect(decryptBackup(contradictory, "contradictory-goal")).rejects.toMatchObject({
      code: "invalid-payload",
    });
  });

  it("rejects an income forecast id that cloud sync cannot store", async () => {
    const planNow = new Date(2026, 6, 30, 10);
    await setPayCyclePlan({
      paydayDay: 10,
    }, source, planNow);
    await setIncomeForecast({
      targetPaydayDateKey: "2026-08-10",
      expectedIncomeMinor: 800_000,
    }, source, planNow);
    const backup = await createEncryptedBackup("invalid-forecast-id", source);
    const invalid = await rewriteEncryptedPayload(
      backup,
      "invalid-forecast-id",
      (payload) => {
        const settings = payload.settings as Record<string, unknown>;
        (settings.incomeForecast as Record<string, unknown>).id = "f".repeat(129);
      },
    );

    await expect(decryptBackup(invalid, "invalid-forecast-id")).rejects.toMatchObject({
      code: "invalid-payload",
    });
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
      (payload) => { payload.schemaVersion = BACKUP_PAYLOAD_SCHEMA_VERSION + 997; },
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
