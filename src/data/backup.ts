import type {
  AppSettings,
  Attachment,
  BalanceAdjustment,
  CycleSavingsTargetOverride,
  IncomeForecast,
  LedgerEntry,
  PayCyclePlan,
  RecoveryAllocation,
  SavingsGoal,
  SavingsEvent,
} from "../domain/types";
import { MAX_AMOUNT_MINOR } from "../domain/amount";
import {
  assertRecoveryAllocationValid,
  isConfirmationStatus,
  isEntryTreatment,
  normalizeLedgerEntry,
  treatmentMatchesAmount,
} from "../domain/entry-treatment";
import { MAX_IMAGE_DIMENSION, MAX_PROCESSED_IMAGE_BYTES } from "../lib/image";
import {
  DATABASE_SCHEMA_VERSION,
  type LedgerDatabase,
  type LedgerReplacement,
  ledgerDb,
  migrateLegacySavingsSettings,
  replaceLedgerData,
} from "./database";

export const BACKUP_FORMAT = "jiyibi-encrypted-backup" as const;
export const BACKUP_ENVELOPE_VERSION = 1 as const;
export const BACKUP_PAYLOAD_FORMAT = "jiyibi-ledger" as const;
export const BACKUP_PAYLOAD_SCHEMA_VERSION = 6 as const;
export const PBKDF2_ITERATIONS = 310_000;
export const MAX_BACKUP_SOURCE_BYTES = 96 * 1024 * 1024;
export const MAX_BACKUP_ENTRIES = 25_000;
export const MAX_BACKUP_RECOVERY_ALLOCATIONS = 25_000;
export const MAX_BACKUP_SAVINGS_EVENTS = 25_000;
export const MAX_BACKUP_BALANCE_ADJUSTMENTS = 25_000;
export const MAX_BACKUP_ATTACHMENTS = 2_500;
export const MAX_BACKUP_ATTACHMENT_BYTES = 40 * 1024 * 1024;

const SYNC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MIN_ACCEPTED_ITERATIONS = 100_000;
const MAX_ACCEPTED_ITERATIONS = 2_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ADDITIONAL_DATA = "jiyibi-backup:v1";

export type BackupErrorCode =
  | "password-required"
  | "invalid-envelope"
  | "unsupported-version"
  | "limit-exceeded"
  | "decrypt-failed"
  | "invalid-payload"
  | "restore-failed";

export class BackupError extends Error {
  constructor(message: string, public readonly code: BackupErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupError";
  }
}

interface BackupEnvelopeV1 {
  format: typeof BACKUP_FORMAT;
  envelopeVersion: typeof BACKUP_ENVELOPE_VERSION;
  encryption: {
    algorithm: "AES-256-GCM";
    keyDerivation: "PBKDF2-SHA-256";
    iterations: number;
    salt: string;
    iv: string;
  };
  ciphertext: string;
}

interface SerializedAttachment extends Omit<Attachment, "blob"> {
  dataBase64: string;
}

interface LegacyPayCyclePlan extends PayCyclePlan {
  monthlySalaryMinor: number;
}

type LegacyAppSettings = Omit<AppSettings, "payCycle" | "incomeForecast"> & {
  payCycle?: LegacyPayCyclePlan;
};

interface BackupPayloadV1 {
  format: typeof BACKUP_PAYLOAD_FORMAT;
  schemaVersion: typeof DATABASE_SCHEMA_VERSION;
  exportedAt: string;
  settings: LegacyAppSettings;
  entries: LedgerEntry[];
  attachments: SerializedAttachment[];
}

interface BackupPayloadV2 {
  format: typeof BACKUP_PAYLOAD_FORMAT;
  schemaVersion: 2;
  exportedAt: string;
  settings: AppSettings;
  entries: LedgerEntry[];
  attachments: SerializedAttachment[];
}

interface BackupPayloadV6 {
  format: typeof BACKUP_PAYLOAD_FORMAT;
  schemaVersion: typeof BACKUP_PAYLOAD_SCHEMA_VERSION;
  exportedAt: string;
  settings: AppSettings;
  entries: LedgerEntry[];
  attachments: SerializedAttachment[];
  recoveryAllocations: RecoveryAllocation[];
  savingsEvents: SavingsEvent[];
  balanceAdjustments: BalanceAdjustment[];
}

export interface BackupPreview {
  exportedAt: string;
  entryCount: number;
  attachmentCount: number;
  savingsEventCount?: number;
  balanceAdjustmentCount?: number;
  initialBalanceMinor: number;
  monthEndBalanceGoalMinor?: number;
  payCycle?: PayCyclePlan;
  incomeForecast?: IncomeForecast;
  savingsGoal?: SavingsGoal;
  currency: "CNY";
}

export interface PreparedBackup {
  readonly preview: BackupPreview;
  readonly replacement: LedgerReplacement;
}

function getCrypto(): Crypto {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new BackupError("当前浏览器不支持加密备份", "invalid-envelope");
  }
  return cryptoApi;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function base64ToBytes(value: string, code: BackupErrorCode): Uint8Array {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new BackupError("备份文件中的二进制数据无效", code);
  }
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    throw new BackupError("备份文件中的二进制数据无效", code, { cause: error });
  }
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof Response === "function") {
    try {
      return new Uint8Array(await new Response(blob).arrayBuffer());
    } catch {
      // Older browsers can expose Response without accepting Blob bodies.
    }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

function exceedsUtf8ByteLimit(value: string, limit: number): boolean {
  if (value.length > limit) return true;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

async function sourceToText(source: Blob | string): Promise<string> {
  if (typeof source === "string") {
    if (exceedsUtf8ByteLimit(source, MAX_BACKUP_SOURCE_BYTES)) {
      throw new BackupError("备份文件超过 96 MiB 限制", "limit-exceeded");
    }
    return source;
  }
  if (source.size > MAX_BACKUP_SOURCE_BYTES) {
    throw new BackupError("备份文件超过 96 MiB 限制", "limit-exceeded");
  }
  if (typeof source.text === "function") return source.text();
  if (typeof FileReader === "function" && source instanceof Blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(source, "utf-8");
    });
  }
  if (typeof Response === "function") {
    try {
      return await new Response(source).text();
    } catch {
      // Fall through to FileReader for older browser implementations.
    }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(source, "utf-8");
  });
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const cryptoApi = getCrypto();
  const material = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: bytesToArrayBuffer(salt),
      iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(text: string): BackupEnvelopeV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new BackupError("这不是有效的记一笔备份文件", "invalid-envelope", { cause: error });
  }
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) {
    throw new BackupError("这不是有效的记一笔备份文件", "invalid-envelope");
  }
  if (value.envelopeVersion !== BACKUP_ENVELOPE_VERSION) {
    throw new BackupError("该备份版本高于当前应用支持的版本", "unsupported-version");
  }
  if (!isRecord(value.encryption)) {
    throw new BackupError("备份文件缺少加密参数", "invalid-envelope");
  }
  const encryption = value.encryption;
  if (
    encryption.algorithm !== "AES-256-GCM" ||
    encryption.keyDerivation !== "PBKDF2-SHA-256" ||
    !Number.isInteger(encryption.iterations) ||
    Number(encryption.iterations) < MIN_ACCEPTED_ITERATIONS ||
    Number(encryption.iterations) > MAX_ACCEPTED_ITERATIONS ||
    typeof encryption.salt !== "string" ||
    typeof encryption.iv !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
    throw new BackupError("备份文件的加密参数无效", "invalid-envelope");
  }
  return value as unknown as BackupEnvelopeV1;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isLocalDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function hasConsistentLocalDate(
  occurredAt: string,
  timezoneOffsetMinutes: number,
  localDateKey: string,
  localMonthKey: string,
): boolean {
  const instant = new Date(occurredAt).getTime();
  const localWallTime = new Date(instant - timezoneOffsetMinutes * 60_000);
  const expectedDateKey = localWallTime.toISOString().slice(0, 10);
  return localDateKey === expectedDateKey && localMonthKey === expectedDateKey.slice(0, 7);
}

function validateLegacyPayCycleBase(value: unknown): value is PayCyclePlan {
  return (
    isRecord(value) &&
    Number.isInteger(value.paydayDay) &&
    Number(value.paydayDay) >= 1 &&
    Number(value.paydayDay) <= 31 &&
    Number.isSafeInteger(value.cycleEndBalanceGoalMinor) &&
    Math.abs(Number(value.cycleEndBalanceGoalMinor)) <= MAX_AMOUNT_MINOR
  );
}

function validatePreSavingsPayCycle(value: unknown): value is PayCyclePlan {
  return (
    validateLegacyPayCycleBase(value) &&
    !Object.prototype.hasOwnProperty.call(value, "monthlySalaryMinor")
  );
}

function validatePayCycleV4(value: unknown): value is PayCyclePlan {
  return (
    isRecord(value) &&
    Number.isInteger(value.paydayDay) &&
    Number(value.paydayDay) >= 1 &&
    Number(value.paydayDay) <= 31 &&
    Number.isSafeInteger(value.defaultSavingsTargetMinor) &&
    Number(value.defaultSavingsTargetMinor) >= 0 &&
    Number(value.defaultSavingsTargetMinor) <= MAX_AMOUNT_MINOR &&
    !Object.prototype.hasOwnProperty.call(value, "cycleEndBalanceGoalMinor") &&
    !Object.prototype.hasOwnProperty.call(value, "monthlySalaryMinor")
  );
}

function validateLegacySalaryPayCycle(value: unknown): value is LegacyPayCyclePlan {
  return (
    validateLegacyPayCycleBase(value) &&
    isRecord(value) &&
    Number.isSafeInteger(value.monthlySalaryMinor) &&
    Number(value.monthlySalaryMinor) > 0 &&
    Number(value.monthlySalaryMinor) <= MAX_AMOUNT_MINOR
  );
}

function validateSavingsTargetOverride(value: unknown): value is CycleSavingsTargetOverride {
  return (
    isRecord(value) &&
    isLocalDateKey(value.targetPaydayDateKey) &&
    Number.isSafeInteger(value.targetMinor) &&
    Number(value.targetMinor) >= 0 &&
    Number(value.targetMinor) <= MAX_AMOUNT_MINOR
  );
}

function validateIncomeForecastV4(value: unknown): value is IncomeForecast {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    SYNC_ID_PATTERN.test(value.id) &&
    isLocalDateKey(value.targetPaydayDateKey) &&
    Number.isSafeInteger(value.minimumIncomeMinor) &&
    Number(value.minimumIncomeMinor) >= 0 &&
    Number(value.minimumIncomeMinor) <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(value.expectedIncomeMinor) &&
    Number(value.expectedIncomeMinor) >= 0 &&
    Number(value.expectedIncomeMinor) <= MAX_AMOUNT_MINOR &&
    Number(value.minimumIncomeMinor) <= Number(value.expectedIncomeMinor)
  );
}

function validateSettingsV4(value: unknown): value is AppSettings {
  return (
    isRecord(value) &&
    value.id === "primary" &&
    value.currency === "CNY" &&
    value.schemaVersion === DATABASE_SCHEMA_VERSION &&
    Number.isSafeInteger(value.initialBalanceMinor) &&
    Math.abs(Number(value.initialBalanceMinor)) <= MAX_AMOUNT_MINOR &&
    (value.monthEndBalanceGoalMinor === undefined ||
      (Number.isSafeInteger(value.monthEndBalanceGoalMinor) &&
        Math.abs(Number(value.monthEndBalanceGoalMinor)) <= MAX_AMOUNT_MINOR)) &&
    (value.payCycle === undefined || validatePayCycleV4(value.payCycle)) &&
    (value.incomeForecast === undefined ||
      (value.payCycle !== undefined && validateIncomeForecastV4(value.incomeForecast))) &&
    (value.savingsTargetOverride === undefined ||
      (value.payCycle !== undefined &&
        validateSavingsTargetOverride(value.savingsTargetOverride))) &&
    (value.savingsTargetNeedsReview === undefined || value.savingsTargetNeedsReview === true) &&
    value.cycleSavingsTargetOverride === undefined &&
    isIsoDate(value.updatedAt)
  );
}

function validateCanonicalPayCycle(value: unknown): value is PayCyclePlan {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Number.isInteger(value.paydayDay) &&
    Number(value.paydayDay) >= 1 &&
    Number(value.paydayDay) <= 31
  );
}

function validateCanonicalIncomeForecast(value: unknown): value is IncomeForecast {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["id", "targetPaydayDateKey", "expectedIncomeMinor"].includes(key)) &&
    typeof value.id === "string" &&
    SYNC_ID_PATTERN.test(value.id) &&
    isLocalDateKey(value.targetPaydayDateKey) &&
    Number.isSafeInteger(value.expectedIncomeMinor) &&
    Number(value.expectedIncomeMinor) >= 0 &&
    Number(value.expectedIncomeMinor) <= MAX_AMOUNT_MINOR
  );
}

function validateSavingsGoal(value: unknown): value is SavingsGoal {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isLocalDateKey(value.targetDateKey) &&
    Number.isSafeInteger(value.targetMinor) &&
    Number(value.targetMinor) > 0 &&
    Number(value.targetMinor) <= MAX_AMOUNT_MINOR
  );
}

function validateSettingsV5(value: unknown): value is AppSettings {
  return (
    isRecord(value) &&
    value.id === "primary" &&
    value.currency === "CNY" &&
    value.schemaVersion === DATABASE_SCHEMA_VERSION &&
    Number.isSafeInteger(value.initialBalanceMinor) &&
    Math.abs(Number(value.initialBalanceMinor)) <= MAX_AMOUNT_MINOR &&
    (value.monthEndBalanceGoalMinor === undefined ||
      (Number.isSafeInteger(value.monthEndBalanceGoalMinor) &&
        Math.abs(Number(value.monthEndBalanceGoalMinor)) <= MAX_AMOUNT_MINOR)) &&
    (value.payCycle === undefined || validateCanonicalPayCycle(value.payCycle)) &&
    (value.incomeForecast === undefined ||
      (value.payCycle !== undefined && validateCanonicalIncomeForecast(value.incomeForecast))) &&
    (value.savingsGoal === undefined || validateSavingsGoal(value.savingsGoal)) &&
    (value.lastExpectedIncomeMinor === undefined ||
      (Number.isSafeInteger(value.lastExpectedIncomeMinor) &&
        Number(value.lastExpectedIncomeMinor) >= 0 &&
        Number(value.lastExpectedIncomeMinor) <= MAX_AMOUNT_MINOR)) &&
    (value.savingsGoalNeedsSetup === undefined || value.savingsGoalNeedsSetup === true) &&
    !(value.savingsGoal !== undefined && value.savingsGoalNeedsSetup === true) &&
    value.savingsTargetOverride === undefined &&
    value.savingsTargetNeedsReview === undefined &&
    value.cycleSavingsTargetOverride === undefined &&
    isIsoDate(value.updatedAt)
  );
}

function validateSettingsV6(value: unknown): value is AppSettings {
  return validateSettingsV5(value) && (
    value.initialBalanceLockedAt === undefined || isIsoDate(value.initialBalanceLockedAt)
  );
}

function migrateBackupSettingsToV5(
  settings: AppSettings | LegacyAppSettings,
  now: Date,
): AppSettings {
  const migrated = migrateLegacySavingsSettings(settings, now);
  const legacyPlan = migrated.payCycle;
  const legacyTarget = legacyPlan?.defaultSavingsTargetMinor
    ?? legacyPlan?.cycleEndBalanceGoalMinor;
  const legacyOverride = migrated.savingsTargetOverride
    ?? migrated.cycleSavingsTargetOverride;
  const needsSetup = migrated.savingsGoalNeedsSetup === true
    || migrated.savingsTargetNeedsReview === true
    || (legacyTarget !== undefined && legacyTarget !== 0)
    || (legacyOverride !== undefined && legacyOverride.targetMinor !== 0);

  const next = structuredClone(migrated);
  if (legacyPlan) next.payCycle = { paydayDay: legacyPlan.paydayDay };
  if (next.incomeForecast) {
    next.incomeForecast = {
      id: next.incomeForecast.id,
      targetPaydayDateKey: next.incomeForecast.targetPaydayDateKey,
      expectedIncomeMinor: next.incomeForecast.expectedIncomeMinor,
    };
    if (next.lastExpectedIncomeMinor === undefined) {
      next.lastExpectedIncomeMinor = next.incomeForecast.expectedIncomeMinor;
    }
  }
  if (needsSetup && !next.savingsGoal) next.savingsGoalNeedsSetup = true;
  delete next.savingsTargetOverride;
  delete next.cycleSavingsTargetOverride;
  delete next.savingsTargetNeedsReview;
  return next;
}

function validatePreSavingsSettings(value: unknown): value is AppSettings {
  return (
    isRecord(value) &&
    value.id === "primary" &&
    value.currency === "CNY" &&
    value.schemaVersion === DATABASE_SCHEMA_VERSION &&
    Number.isSafeInteger(value.initialBalanceMinor) &&
    Math.abs(Number(value.initialBalanceMinor)) <= MAX_AMOUNT_MINOR &&
    (value.monthEndBalanceGoalMinor === undefined ||
      (Number.isSafeInteger(value.monthEndBalanceGoalMinor) &&
        Math.abs(Number(value.monthEndBalanceGoalMinor)) <= MAX_AMOUNT_MINOR)) &&
    (value.payCycle === undefined || validatePreSavingsPayCycle(value.payCycle)) &&
    (value.incomeForecast === undefined ||
      (value.payCycle !== undefined && validateIncomeForecastV4(value.incomeForecast))) &&
    value.savingsTargetOverride === undefined &&
    value.cycleSavingsTargetOverride === undefined &&
    isIsoDate(value.updatedAt)
  );
}

function validateLegacySettings(value: unknown): value is LegacyAppSettings {
  return (
    isRecord(value) &&
    value.id === "primary" &&
    value.currency === "CNY" &&
    value.schemaVersion === DATABASE_SCHEMA_VERSION &&
    Number.isSafeInteger(value.initialBalanceMinor) &&
    Math.abs(Number(value.initialBalanceMinor)) <= MAX_AMOUNT_MINOR &&
    (value.monthEndBalanceGoalMinor === undefined ||
      (Number.isSafeInteger(value.monthEndBalanceGoalMinor) &&
        Math.abs(Number(value.monthEndBalanceGoalMinor)) <= MAX_AMOUNT_MINOR)) &&
    (value.payCycle === undefined || validateLegacySalaryPayCycle(value.payCycle)) &&
    value.incomeForecast === undefined &&
    isIsoDate(value.updatedAt)
  );
}

function validateEntry(value: unknown, requireAnalysisFields: boolean): value is LedgerEntry {
  const structurallyValid = (
    isRecord(value) &&
    typeof value.id === "string" &&
    SYNC_ID_PATTERN.test(value.id) &&
    Number.isSafeInteger(value.amountMinor) &&
    value.amountMinor !== 0 &&
    Math.abs(Number(value.amountMinor)) <= MAX_AMOUNT_MINOR &&
    typeof value.note === "string" &&
    value.note.length <= 200 &&
    isIsoDate(value.occurredAt) &&
    isLocalDateKey(value.localDateKey) &&
    typeof value.localMonthKey === "string" &&
    /^\d{4}-\d{2}$/.test(value.localMonthKey) &&
    value.localDateKey.startsWith(value.localMonthKey) &&
    Number.isInteger(value.timezoneOffsetMinutes) &&
    Math.abs(Number(value.timezoneOffsetMinutes)) <= 14 * 60 &&
    (value.attachmentId === undefined ||
      (typeof value.attachmentId === "string" && SYNC_ID_PATTERN.test(value.attachmentId))) &&
    (!requireAnalysisFields || (
      isEntryTreatment(value.treatment) &&
      treatmentMatchesAmount(value.treatment, Number(value.amountMinor)) &&
      isConfirmationStatus(value.confirmationStatus) &&
      (value.detectionRuleVersion === undefined || (
        Number.isSafeInteger(value.detectionRuleVersion) &&
        Number(value.detectionRuleVersion) >= 0
      )) &&
      (value.promptedRevision === undefined || isIsoDate(value.promptedRevision))
    )) &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt) &&
    new Date(value.updatedAt).getTime() >= new Date(value.createdAt).getTime() &&
    value.deletedAt === undefined
  );
  return (
    structurallyValid &&
    hasConsistentLocalDate(
      value.occurredAt as string,
      value.timezoneOffsetMinutes as number,
      value.localDateKey as string,
      value.localMonthKey as string,
    )
  );
}

function normalizeBackupEntry(value: LedgerEntry): LedgerEntry {
  return normalizeLedgerEntry(value);
}

function validateRecoveryAllocationShape(value: unknown): value is RecoveryAllocation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    SYNC_ID_PATTERN.test(value.id) &&
    typeof value.refundEntryId === "string" &&
    SYNC_ID_PATTERN.test(value.refundEntryId) &&
    typeof value.expenseEntryId === "string" &&
    SYNC_ID_PATTERN.test(value.expenseEntryId) &&
    value.refundEntryId !== value.expenseEntryId &&
    Number.isSafeInteger(value.amountMinor) &&
    Number(value.amountMinor) > 0 &&
    Number(value.amountMinor) <= MAX_AMOUNT_MINOR &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt) &&
    new Date(value.updatedAt).getTime() >= new Date(value.createdAt).getTime() &&
    value.deletedAt === undefined
  );
}

function validateRecoveryAllocations(
  values: unknown[],
  entriesById: ReadonlyMap<string, LedgerEntry>,
): RecoveryAllocation[] {
  if (values.length > MAX_BACKUP_RECOVERY_ALLOCATIONS) {
    throw new BackupError(
      `备份恢复分摊不能超过 ${MAX_BACKUP_RECOVERY_ALLOCATIONS} 条`,
      "limit-exceeded",
    );
  }
  const allocations: RecoveryAllocation[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    if (!validateRecoveryAllocationShape(value) || ids.has(value.id)) {
      throw new BackupError("备份中的恢复分摊无效", "invalid-payload");
    }
    const refund = entriesById.get(value.refundEntryId);
    const expense = entriesById.get(value.expenseEntryId);
    if (!refund || !expense) {
      throw new BackupError("备份中的恢复分摊引用了不存在的账目", "invalid-payload");
    }
    try {
      assertRecoveryAllocationValid(value.amountMinor, {
        refund,
        expense,
        existing: allocations,
      });
    } catch (error) {
      throw new BackupError("备份中的恢复分摊金额或关联无效", "invalid-payload", {
        cause: error,
      });
    }
    ids.add(value.id);
    allocations.push(structuredClone(value));
  }
  return allocations;
}

function validateSavingsEventShape(value: unknown): value is SavingsEvent {
  if (!isRecord(value) || typeof value.id !== "string" || !SYNC_ID_PATTERN.test(value.id)) {
    return false;
  }
  const common =
    (value.kind === "opening" || value.kind === "reserve" ||
      value.kind === "release" || value.kind === "cycle_settlement") &&
    Number.isSafeInteger(value.amountMinor) &&
    Number(value.amountMinor) >= (value.kind === "cycle_settlement" ? 0 : 1) &&
    Number(value.amountMinor) <= MAX_AMOUNT_MINOR &&
    typeof value.note === "string" &&
    value.note.length <= 200 &&
    isIsoDate(value.occurredAt) &&
    isLocalDateKey(value.localDateKey) &&
    value.localMonthKey === value.localDateKey.slice(0, 7) &&
    Number.isInteger(value.timezoneOffsetMinutes) &&
    Math.abs(Number(value.timezoneOffsetMinutes)) <= 14 * 60 &&
    hasConsistentLocalDate(
      value.occurredAt as string,
      value.timezoneOffsetMinutes as number,
      value.localDateKey as string,
      value.localMonthKey as string,
    ) &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt) &&
    new Date(value.updatedAt).getTime() >= new Date(value.createdAt).getTime() &&
    value.deletedAt === undefined;
  if (!common) return false;
  if (value.kind === "release" && value.linkedExpenseEntryId !== undefined &&
      (typeof value.linkedExpenseEntryId !== "string" || !SYNC_ID_PATTERN.test(value.linkedExpenseEntryId))) {
    return false;
  }
  if (value.kind !== "release" && value.linkedExpenseEntryId !== undefined) return false;
  if (value.kind !== "cycle_settlement") {
    return value.cycleStartDateKey === undefined &&
      value.cycleEndDateKey === undefined &&
      value.goalMinorSnapshot === undefined &&
      value.openingRetainedMinor === undefined &&
      value.closingRetainedMinor === undefined &&
      value.netGrowthMinor === undefined &&
      value.transferToRetainedMinor === undefined;
  }
  return (
    isLocalDateKey(value.cycleStartDateKey) &&
    isLocalDateKey(value.cycleEndDateKey) &&
    value.cycleStartDateKey <= value.cycleEndDateKey &&
    Number.isSafeInteger(value.goalMinorSnapshot) &&
    Number(value.goalMinorSnapshot) >= 0 &&
    Number(value.goalMinorSnapshot) <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(value.openingRetainedMinor) &&
    Math.abs(Number(value.openingRetainedMinor)) <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(value.closingRetainedMinor) &&
    Math.abs(Number(value.closingRetainedMinor)) <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(value.netGrowthMinor) &&
    Number(value.netGrowthMinor) ===
      Number(value.closingRetainedMinor) - Number(value.openingRetainedMinor) &&
    (value.transferToRetainedMinor === undefined ||
      (Number.isSafeInteger(value.transferToRetainedMinor) &&
        Number(value.transferToRetainedMinor) === Number(value.amountMinor)))
  );
}

function validateSavingsEvents(
  values: unknown[],
  entriesById: ReadonlyMap<string, LedgerEntry>,
): SavingsEvent[] {
  if (values.length > MAX_BACKUP_SAVINGS_EVENTS) {
    throw new BackupError(
      `备份留存事件不能超过 ${MAX_BACKUP_SAVINGS_EVENTS} 条`,
      "limit-exceeded",
    );
  }
  const ids = new Set<string>();
  let hasOpening = false;
  const settlementCycles = new Set<string>();
  const linkedReleaseTotals = new Map<string, bigint>();
  const events: SavingsEvent[] = [];
  for (const value of values) {
    if (!validateSavingsEventShape(value) || ids.has(value.id)) {
      throw new BackupError("备份中的留存事件无效", "invalid-payload");
    }
    if (value.kind === "opening") {
      if (hasOpening) {
        throw new BackupError("备份中存在多个初始留存事件", "invalid-payload");
      }
      hasOpening = true;
    }
    if (value.kind === "cycle_settlement") {
      if (settlementCycles.has(value.cycleStartDateKey)) {
        throw new BackupError("同一周期存在多个留存结算", "invalid-payload");
      }
      settlementCycles.add(value.cycleStartDateKey);
    }
    if (value.kind === "release" && value.linkedExpenseEntryId) {
      const linked = entriesById.get(value.linkedExpenseEntryId);
      if (!linked || linked.amountMinor >= 0) {
        throw new BackupError("留存取用关联的支出不存在", "invalid-payload");
      }
      const linkedTotal = (linkedReleaseTotals.get(linked.id) ?? 0n)
        + BigInt(value.amountMinor);
      if (linkedTotal > -BigInt(linked.amountMinor)) {
        throw new BackupError("留存取用金额超过关联支出", "invalid-payload");
      }
      linkedReleaseTotals.set(linked.id, linkedTotal);
    }
    ids.add(value.id);
    events.push(structuredClone(value));
  }
  return events;
}

function validateBalanceAdjustments(values: unknown[]): BalanceAdjustment[] {
  if (values.length > MAX_BACKUP_BALANCE_ADJUSTMENTS) {
    throw new BackupError(
      `备份余额调整不能超过 ${MAX_BACKUP_BALANCE_ADJUSTMENTS} 条`,
      "limit-exceeded",
    );
  }
  const ids = new Set<string>();
  const rows: BalanceAdjustment[] = [];
  for (const value of values) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      !SYNC_ID_PATTERN.test(value.id) ||
      ids.has(value.id) ||
      (value.kind !== "reconciliation" && value.kind !== "opening_correction") ||
      !Number.isSafeInteger(value.amountMinor) ||
      Math.abs(Number(value.amountMinor)) > MAX_AMOUNT_MINOR ||
      typeof value.note !== "string" ||
      value.note.length > 200 ||
      !isIsoDate(value.occurredAt) ||
      !isLocalDateKey(value.localDateKey) ||
      typeof value.localMonthKey !== "string" ||
      !/^\d{4}-\d{2}$/.test(value.localMonthKey) ||
      !value.localDateKey.startsWith(value.localMonthKey) ||
      !Number.isInteger(value.timezoneOffsetMinutes) ||
      Math.abs(Number(value.timezoneOffsetMinutes)) > 14 * 60 ||
      !hasConsistentLocalDate(
        value.occurredAt as string,
        value.timezoneOffsetMinutes as number,
        value.localDateKey as string,
        value.localMonthKey as string,
      ) ||
      !isIsoDate(value.createdAt) ||
      !isIsoDate(value.updatedAt) ||
      new Date(value.updatedAt).getTime() < new Date(value.createdAt).getTime() ||
      (value.deletedAt !== undefined && (
        !isIsoDate(value.deletedAt) ||
        new Date(value.deletedAt).getTime() < new Date(value.createdAt).getTime()
      ))
    ) {
      throw new BackupError("备份中的余额调整无效", "invalid-payload");
    }

    const amountMinor = Number(value.amountMinor);
    if (value.kind === "reconciliation") {
      if (
        !Number.isSafeInteger(value.balanceBeforeMinor) ||
        Math.abs(Number(value.balanceBeforeMinor)) > MAX_AMOUNT_MINOR ||
        !Number.isSafeInteger(value.observedBalanceMinor) ||
        Math.abs(Number(value.observedBalanceMinor)) > MAX_AMOUNT_MINOR ||
        BigInt(amountMinor) !==
          BigInt(Number(value.observedBalanceMinor)) - BigInt(Number(value.balanceBeforeMinor))
      ) {
        throw new BackupError("备份中的余额校准快照无效", "invalid-payload");
      }
    } else if (
      !Number.isSafeInteger(value.previousOpeningMinor) ||
      Math.abs(Number(value.previousOpeningMinor)) > MAX_AMOUNT_MINOR ||
      !Number.isSafeInteger(value.nextOpeningMinor) ||
      Math.abs(Number(value.nextOpeningMinor)) > MAX_AMOUNT_MINOR ||
      BigInt(amountMinor) !==
        BigInt(Number(value.nextOpeningMinor)) - BigInt(Number(value.previousOpeningMinor))
    ) {
      throw new BackupError("备份中的起点更正快照无效", "invalid-payload");
    }
    ids.add(value.id);
    rows.push(structuredClone(value) as unknown as BalanceAdjustment);
  }
  return rows;
}

function parsePayload(value: unknown, now = new Date()): BackupPayloadV6 {
  if (!isRecord(value) || value.format !== BACKUP_PAYLOAD_FORMAT) {
    throw new BackupError("备份内容格式无效", "invalid-payload");
  }
  const schemaVersion = value.schemaVersion;
  const supportedSchema = schemaVersion === DATABASE_SCHEMA_VERSION
    || schemaVersion === 2
    || schemaVersion === 3
    || schemaVersion === 4
    || schemaVersion === 5
    || schemaVersion === BACKUP_PAYLOAD_SCHEMA_VERSION;
  if (!supportedSchema) {
    throw new BackupError("该账目数据版本高于当前应用支持的版本", "unsupported-version");
  }
  const settingsAreValid = schemaVersion === DATABASE_SCHEMA_VERSION
    ? validateLegacySettings(value.settings)
    : schemaVersion < 4
      ? validatePreSavingsSettings(value.settings)
      : schemaVersion === 4
        ? validateSettingsV4(value.settings)
        : schemaVersion === 5
          ? validateSettingsV5(value.settings)
          : validateSettingsV6(value.settings);
  if (
    !isIsoDate(value.exportedAt) ||
    !settingsAreValid ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.attachments) ||
    (schemaVersion >= 3 && !Array.isArray(value.recoveryAllocations)) ||
    (schemaVersion >= 4 &&
      !Array.isArray(value.savingsEvents)) ||
    (schemaVersion >= 6 && !Array.isArray(value.balanceAdjustments))
  ) {
    throw new BackupError("备份中的账目或设置无效", "invalid-payload");
  }

  if (value.entries.length > MAX_BACKUP_ENTRIES) {
    throw new BackupError(`备份记录不能超过 ${MAX_BACKUP_ENTRIES} 条`, "limit-exceeded");
  }
  if (value.attachments.length > MAX_BACKUP_ATTACHMENTS) {
    throw new BackupError(`备份截图不能超过 ${MAX_BACKUP_ATTACHMENTS} 张`, "limit-exceeded");
  }
  const requireAnalysisFields = schemaVersion >= 3;
  if (!value.entries.every((entry) => validateEntry(entry, requireAnalysisFields))) {
    throw new BackupError("备份中的账目或设置无效", "invalid-payload");
  }

  const entryIds = new Set<string>();
  const entriesById = new Map<string, LedgerEntry>();
  const normalizedEntries: LedgerEntry[] = [];
  for (const entry of value.entries) {
    if (entryIds.has(entry.id)) {
      throw new BackupError("备份中存在重复账目", "invalid-payload");
    }
    entryIds.add(entry.id);
    const normalized = normalizeBackupEntry(entry);
    entriesById.set(entry.id, normalized);
    normalizedEntries.push(normalized);
  }

  const attachmentsById = new Map<string, SerializedAttachment>();
  let totalAttachmentBytes = 0;
  for (const attachment of value.attachments) {
    if (
      !isRecord(attachment) ||
      typeof attachment.id !== "string" ||
      attachment.id.length === 0 ||
      typeof attachment.entryId !== "string" ||
      !entryIds.has(attachment.entryId) ||
      typeof attachment.mimeType !== "string" ||
      !attachment.mimeType.startsWith("image/") ||
      !Number.isInteger(attachment.size) ||
      Number(attachment.size) < 1 ||
      Number(attachment.size) > MAX_PROCESSED_IMAGE_BYTES ||
      !Number.isInteger(attachment.width) ||
      Number(attachment.width) < 1 ||
      !Number.isInteger(attachment.height) ||
      Number(attachment.height) < 1 ||
      Math.max(Number(attachment.width), Number(attachment.height)) > MAX_IMAGE_DIMENSION ||
      !isIsoDate(attachment.createdAt) ||
      typeof attachment.dataBase64 !== "string" ||
      attachmentsById.has(attachment.id)
    ) {
      throw new BackupError("备份中的截图无效", "invalid-payload");
    }
    totalAttachmentBytes += Number(attachment.size);
    if (
      !Number.isSafeInteger(totalAttachmentBytes) ||
      totalAttachmentBytes > MAX_BACKUP_ATTACHMENT_BYTES
    ) {
      throw new BackupError("备份截图总大小超过 40 MiB 限制", "limit-exceeded");
    }
    attachmentsById.set(attachment.id, attachment as unknown as SerializedAttachment);
  }

  const referencedAttachmentIds = new Set<string>();
  for (const entry of value.entries) {
    if (entry.attachmentId) {
      const attachment = attachmentsById.get(entry.attachmentId);
      if (
        !attachment ||
        attachment.entryId !== entry.id ||
        referencedAttachmentIds.has(entry.attachmentId)
      ) {
        throw new BackupError("备份中的截图归属关系无效", "invalid-payload");
      }
      referencedAttachmentIds.add(entry.attachmentId);
    }
    if (!entry.note && !entry.attachmentId) {
      throw new BackupError("备份中存在没有文字或截图的账目", "invalid-payload");
    }
  }
  for (const attachment of attachmentsById.values()) {
    const entry = entriesById.get(attachment.entryId);
    if (entry?.attachmentId !== attachment.id) {
      throw new BackupError("备份中包含未关联的截图", "invalid-payload");
    }
  }

  const recoveryAllocations = validateRecoveryAllocations(
    schemaVersion >= 3
      ? value.recoveryAllocations as unknown[]
      : [],
    entriesById,
  );
  const savingsEvents = validateSavingsEvents(
    schemaVersion >= 4
      ? value.savingsEvents as unknown[]
      : [],
    entriesById,
  );
  const balanceAdjustments = validateBalanceAdjustments(
    schemaVersion >= 6 ? value.balanceAdjustments as unknown[] : [],
  );
  const settings = schemaVersion < 5
    ? migrateBackupSettingsToV5(
      schemaVersion === DATABASE_SCHEMA_VERSION
        ? (value as unknown as BackupPayloadV1).settings
        : value.settings as AppSettings,
      now,
    )
    : structuredClone(value.settings as AppSettings);
  if (
    !settings.initialBalanceLockedAt &&
    (normalizedEntries.length > 0 || savingsEvents.length > 0 || balanceAdjustments.length > 0)
  ) {
    const factTimes = [...normalizedEntries, ...savingsEvents, ...balanceAdjustments]
      .map((fact) => fact.createdAt)
      .filter(isIsoDate)
      .sort();
    settings.initialBalanceLockedAt = factTimes[0] ?? now.toISOString();
  }
  return {
    format: BACKUP_PAYLOAD_FORMAT,
    schemaVersion: BACKUP_PAYLOAD_SCHEMA_VERSION,
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : now.toISOString(),
    settings,
    entries: normalizedEntries,
    attachments: value.attachments as BackupPayloadV2["attachments"],
    recoveryAllocations,
    savingsEvents,
    balanceAdjustments,
  };
}

async function serializeDatabase(database: LedgerDatabase, now: Date): Promise<BackupPayloadV6> {
  const snapshot = await database.transaction(
    "r",
    [
      database.settings,
      database.entries,
      database.attachments,
      database.recoveryAllocations,
      database.savingsEvents,
      database.balanceAdjustments,
    ],
    async () => {
      const settings = await database.settings.get("primary");
      const entries = (await database.entries.toArray()).filter((entry) => !entry.deletedAt);
      const entryIds = new Set(entries.map((entry) => entry.id));
      const attachmentIds = new Set(entries.flatMap((entry) => entry.attachmentId ? [entry.attachmentId] : []));
      const attachments = (await database.attachments.toArray()).filter((attachment) => attachmentIds.has(attachment.id));
      const recoveryAllocations = (await database.recoveryAllocations.toArray()).filter(
        (allocation) => !allocation.deletedAt
          && entryIds.has(allocation.refundEntryId)
          && entryIds.has(allocation.expenseEntryId),
      );
      const savingsEvents = (await database.savingsEvents.toArray()).filter(
        (event) => !event.deletedAt,
      );
      const balanceAdjustments = await database.balanceAdjustments.toArray();
      return {
        settings,
        entries,
        attachments,
        recoveryAllocations,
        savingsEvents,
        balanceAdjustments,
      };
    },
  );
  if (!snapshot.settings || !validateSettingsV6(snapshot.settings)) {
    throw new BackupError("本地设置无效，无法导出", "invalid-payload");
  }
  if (snapshot.entries.length > MAX_BACKUP_ENTRIES) {
    throw new BackupError(`本地记录不能超过 ${MAX_BACKUP_ENTRIES} 条`, "limit-exceeded");
  }
  if (snapshot.attachments.length > MAX_BACKUP_ATTACHMENTS) {
    throw new BackupError(`本地截图不能超过 ${MAX_BACKUP_ATTACHMENTS} 张`, "limit-exceeded");
  }
  if (snapshot.savingsEvents.length > MAX_BACKUP_SAVINGS_EVENTS) {
    throw new BackupError(`本地留存事件不能超过 ${MAX_BACKUP_SAVINGS_EVENTS} 条`, "limit-exceeded");
  }
  const validatedBalanceAdjustments = validateBalanceAdjustments(
    snapshot.balanceAdjustments,
  );
  const entriesById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const validatedSavingsEvents = validateSavingsEvents(
    snapshot.savingsEvents,
    entriesById,
  );
  const attachmentsById = new Map(snapshot.attachments.map((attachment) => [attachment.id, attachment]));
  let totalAttachmentBytes = 0;
  for (const attachment of snapshot.attachments) {
    totalAttachmentBytes += attachment.size;
    const owner = entriesById.get(attachment.entryId);
    if (owner?.attachmentId !== attachment.id) {
      throw new BackupError("本地截图归属关系无效，无法导出", "invalid-payload");
    }
  }
  if (totalAttachmentBytes > MAX_BACKUP_ATTACHMENT_BYTES) {
    throw new BackupError("本地截图总大小超过 40 MiB 限制", "limit-exceeded");
  }
  for (const entry of snapshot.entries) {
    const attachment = entry.attachmentId
      ? attachmentsById.get(entry.attachmentId)
      : undefined;
    if (entry.attachmentId && attachment?.entryId !== entry.id) {
      throw new BackupError("本地截图归属关系无效，无法导出", "invalid-payload");
    }
  }

  const attachments: SerializedAttachment[] = [];
  for (const attachment of snapshot.attachments) {
    const bytes = await blobToBytes(attachment.blob);
    if (bytes.length !== attachment.size || attachment.blob.type !== attachment.mimeType) {
      throw new BackupError("本地截图数据不完整，无法导出", "invalid-payload");
    }
    attachments.push({
      id: attachment.id,
      entryId: attachment.entryId,
      mimeType: attachment.mimeType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
      createdAt: attachment.createdAt,
      dataBase64: bytesToBase64(bytes),
    });
  }
  return {
    format: BACKUP_PAYLOAD_FORMAT,
    schemaVersion: BACKUP_PAYLOAD_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    settings: snapshot.settings,
    entries: snapshot.entries,
    attachments,
    recoveryAllocations: snapshot.recoveryAllocations,
    savingsEvents: validatedSavingsEvents,
    balanceAdjustments: validatedBalanceAdjustments,
  };
}

export async function createEncryptedBackup(
  password: string,
  database = ledgerDb,
  now = new Date(),
): Promise<Blob> {
  if (!password) throw new BackupError("请输入备份密码", "password-required");
  const cryptoApi = getCrypto();
  const payload = await serializeDatabase(database, now);
  parsePayload(payload);
  const salt = cryptoApi.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bytesToArrayBuffer(iv),
      additionalData: new TextEncoder().encode(ADDITIONAL_DATA),
    },
    key,
    plaintext,
  );
  const envelope: BackupEnvelopeV1 = {
    format: BACKUP_FORMAT,
    envelopeVersion: BACKUP_ENVELOPE_VERSION,
    encryption: {
      algorithm: "AES-256-GCM",
      keyDerivation: "PBKDF2-SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
  const backup = new Blob([JSON.stringify(envelope)], {
    type: "application/vnd.jiyibi.backup+json",
  });
  if (backup.size > MAX_BACKUP_SOURCE_BYTES) {
    throw new BackupError("生成的备份文件超过 96 MiB 限制", "limit-exceeded");
  }
  return backup;
}

export async function decryptBackup(
  source: Blob | string,
  password: string,
  now = new Date(),
): Promise<PreparedBackup> {
  if (!password) throw new BackupError("请输入备份密码", "password-required");
  let envelope: BackupEnvelopeV1;
  try {
    envelope = parseEnvelope(await sourceToText(source));
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("无法读取备份文件", "invalid-envelope", { cause: error });
  }

  const salt = base64ToBytes(envelope.encryption.salt, "invalid-envelope");
  const iv = base64ToBytes(envelope.encryption.iv, "invalid-envelope");
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) {
    throw new BackupError("备份文件的加密参数无效", "invalid-envelope");
  }
  const ciphertext = base64ToBytes(envelope.ciphertext, "invalid-envelope");
  const key = await deriveKey(password, salt, envelope.encryption.iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await getCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesToArrayBuffer(iv),
        additionalData: new TextEncoder().encode(ADDITIONAL_DATA),
      },
      key,
      bytesToArrayBuffer(ciphertext),
    );
  } catch (error) {
    throw new BackupError("密码错误或备份文件已损坏", "decrypt-failed", { cause: error });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch (error) {
    throw new BackupError("备份内容已损坏", "invalid-payload", { cause: error });
  }
  const payload = parsePayload(decoded, now);
  const attachments: Attachment[] = payload.attachments.map((attachment) => {
    const bytes = base64ToBytes(attachment.dataBase64, "invalid-payload");
    if (bytes.length !== attachment.size) {
      throw new BackupError("备份中的截图大小不匹配", "invalid-payload");
    }
    return {
      id: attachment.id,
      entryId: attachment.entryId,
      blob: new Blob([bytesToArrayBuffer(bytes)], { type: attachment.mimeType }),
      mimeType: attachment.mimeType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
      createdAt: attachment.createdAt,
    };
  });
  return {
    preview: {
      exportedAt: payload.exportedAt,
      entryCount: payload.entries.length,
      attachmentCount: attachments.length,
      savingsEventCount: payload.savingsEvents.length,
      balanceAdjustmentCount: payload.balanceAdjustments.length,
      initialBalanceMinor: payload.settings.initialBalanceMinor,
      monthEndBalanceGoalMinor: payload.settings.monthEndBalanceGoalMinor,
      ...(payload.settings.payCycle
        ? { payCycle: structuredClone(payload.settings.payCycle) }
        : {}),
      ...(payload.settings.incomeForecast
        ? { incomeForecast: structuredClone(payload.settings.incomeForecast) }
        : {}),
      ...(payload.settings.savingsGoal
        ? { savingsGoal: structuredClone(payload.settings.savingsGoal) }
        : {}),
      currency: payload.settings.currency,
    },
    replacement: {
      settings: structuredClone(payload.settings),
      entries: structuredClone(payload.entries),
      attachments,
      recoveryAllocations: structuredClone(payload.recoveryAllocations),
      savingsEvents: structuredClone(payload.savingsEvents),
      balanceAdjustments: structuredClone(payload.balanceAdjustments),
    },
  };
}

export async function restorePreparedBackup(
  prepared: PreparedBackup,
  database = ledgerDb,
): Promise<void> {
  const payload = {
    format: BACKUP_PAYLOAD_FORMAT,
    schemaVersion: BACKUP_PAYLOAD_SCHEMA_VERSION,
    exportedAt: prepared.preview.exportedAt,
    settings: prepared.replacement.settings,
    entries: prepared.replacement.entries,
    attachments: prepared.replacement.attachments.map((attachment) => ({
      id: attachment.id,
      entryId: attachment.entryId,
      mimeType: attachment.mimeType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
      createdAt: attachment.createdAt,
      dataBase64: "AA==",
    })),
    recoveryAllocations: prepared.replacement.recoveryAllocations,
    savingsEvents: prepared.replacement.savingsEvents ?? [],
    balanceAdjustments: prepared.replacement.balanceAdjustments ?? [],
  };
  try {
    parsePayload(payload);
    for (let index = 0; index < prepared.replacement.attachments.length; index += 1) {
      const attachment = prepared.replacement.attachments[index];
      if (
        attachment.blob.size !== attachment.size ||
        attachment.blob.type !== attachment.mimeType
      ) {
        throw new BackupError("待恢复的截图大小不匹配", "invalid-payload");
      }
    }
    await replaceLedgerData(prepared.replacement, database);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("恢复失败，原有账目未被替换", "restore-failed", { cause: error });
  }
}

export async function restoreEncryptedBackup(
  source: Blob | string,
  password: string,
  database = ledgerDb,
  now = new Date(),
): Promise<BackupPreview> {
  const prepared = await decryptBackup(source, password, now);
  await restorePreparedBackup(prepared, database);
  return prepared.preview;
}

export function createBackupFileName(now = new Date()): string {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return `jiyibi-backup-${date}.jiyibi`;
}
