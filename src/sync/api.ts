import { MAX_AMOUNT_MINOR } from "../domain/amount";
import { resolveNextPaydayDateKey } from "../domain/date";
import {
  isConfirmationStatus,
  isEntryTreatment,
  treatmentMatchesAmount,
} from "../domain/entry-treatment";
import type {
  AppSettings,
  Attachment,
  IncomeForecast,
  LedgerEntry,
  PayCyclePlan,
  RecoveryAllocation,
  SavingsGoal,
  SavingsEvent,
} from "../domain/types";
import { MAX_IMAGE_DIMENSION, MAX_PROCESSED_IMAGE_BYTES } from "../lib/image";
import {
  API_SCHEMA_VERSION,
  SYNC_SCHEMA_VERSION,
  type CloudAccountDeletionResponse,
  type SessionResponse,
  type SyncChange,
  type SyncMutationResult,
  type SyncRequest,
  type SyncResponse,
} from "./contracts";

type SyncSettingsResponsePayload = AppSettings & {
  _legacyMonthlySalaryMinor?: number;
};

export type SyncApiErrorCode =
  | "unauthorized"
  | "network"
  | "invalid-response"
  | "quota"
  | "stale_cloud_generation"
  | "cloud_sync_disabled"
  | "account_deletion_in_progress"
  | "upgrade_required";

export class SyncApiError extends Error {
  constructor(
    public readonly code: SyncApiErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SyncApiError";
  }
}

export interface SyncApiClient {
  getSession(): Promise<SessionResponse>;
  enableCloudSync(generation: number): Promise<number>;
  deleteCloudData(generation: number): Promise<void>;
  sync(request: SyncRequest, generation: number): Promise<SyncResponse>;
  putAttachment(attachment: Attachment, generation: number): Promise<void>;
  getAttachment(
    attachmentId: string,
    generation: number,
  ): Promise<DownloadedAttachment | undefined>;
}

export type DownloadedAttachment = Pick<
  Attachment,
  "blob" | "entryId" | "mimeType" | "size" | "width" | "height"
>;

export type SyncFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SyncWait = (milliseconds: number) => Promise<void>;

const waitForRetry: SyncWait = (milliseconds) =>
  new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

const ATTACHMENT_DOWNLOAD_RETRY_WINDOW_MS = 60_000;
const ATTACHMENT_DOWNLOAD_INITIAL_RETRY_MS = 1_000;
const ATTACHMENT_DOWNLOAD_MAX_RETRY_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const MAX_CLOUD_GENERATION = 9_000_000_000_000_000;
const SYNC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isCloudGeneration(value: unknown, allowZero = true): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= (allowZero ? 0 : 1) &&
    Number(value) <= MAX_CLOUD_GENERATION
  );
}

function requireCloudGeneration(value: number, allowZero = true): number {
  if (!isCloudGeneration(value, allowZero)) {
    throw responseError("The cloud generation is invalid.");
  }
  return value;
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

function hasConsistentLocalDate(entry: LedgerEntry): boolean {
  const instant = new Date(entry.occurredAt).getTime();
  const localWallTime = new Date(instant - entry.timezoneOffsetMinutes * 60_000);
  const expectedDateKey = localWallTime.toISOString().slice(0, 10);
  return (
    entry.localDateKey === expectedDateKey &&
    entry.localMonthKey === expectedDateKey.slice(0, 7)
  );
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "id",
        "amountMinor",
        "note",
        "occurredAt",
        "localDateKey",
        "localMonthKey",
        "timezoneOffsetMinutes",
        "treatment",
        "confirmationStatus",
        "createdAt",
        "updatedAt",
      ],
      ["attachmentId", "deletedAt", "detectionRuleVersion", "promptedRevision"],
    )
  ) {
    return false;
  }

  const structurallyValid =
    typeof value.id === "string" && SYNC_ID_PATTERN.test(value.id) &&
    Number.isSafeInteger(value.amountMinor) &&
    value.amountMinor !== 0 &&
    Math.abs(Number(value.amountMinor)) <= MAX_AMOUNT_MINOR &&
    typeof value.note === "string" &&
    value.note.length <= 200 &&
    isIsoDate(value.occurredAt) &&
    isLocalDateKey(value.localDateKey) &&
    typeof value.localMonthKey === "string" &&
    /^\d{4}-\d{2}$/.test(value.localMonthKey) &&
    Number.isInteger(value.timezoneOffsetMinutes) &&
    Math.abs(Number(value.timezoneOffsetMinutes)) <= 14 * 60 &&
    (value.attachmentId === undefined || (
      typeof value.attachmentId === "string" && SYNC_ID_PATTERN.test(value.attachmentId)
    )) &&
    isEntryTreatment(value.treatment) &&
    treatmentMatchesAmount(value.treatment, Number(value.amountMinor)) &&
    isConfirmationStatus(value.confirmationStatus) &&
    (value.detectionRuleVersion === undefined || (
      Number.isSafeInteger(value.detectionRuleVersion) && Number(value.detectionRuleVersion) >= 0
    )) &&
    (value.promptedRevision === undefined || isIsoDate(value.promptedRevision)) &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt) &&
    new Date(value.updatedAt).getTime() >= new Date(value.createdAt).getTime() &&
    (value.deletedAt === undefined || (
      isIsoDate(value.deletedAt) && value.deletedAt === value.updatedAt
    ));

  if (!structurallyValid) return false;
  return hasConsistentLocalDate(value as unknown as LedgerEntry);
}

function isAppSettings(value: unknown): value is SyncSettingsResponsePayload {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["id", "currency", "initialBalanceMinor", "schemaVersion", "updatedAt"],
      [
        "monthEndBalanceGoalMinor",
        "payCycle",
        "incomeForecast",
        "savingsGoal",
        "lastExpectedIncomeMinor",
        "savingsGoalNeedsSetup",
        "savingsTargetOverride",
        "_legacyMonthlySalaryMinor",
      ],
    ) &&
    value.id === "primary" &&
    value.currency === "CNY" &&
    Number.isSafeInteger(value.initialBalanceMinor) &&
    Math.abs(Number(value.initialBalanceMinor)) <= MAX_AMOUNT_MINOR &&
    (value.monthEndBalanceGoalMinor === undefined ||
      (Number.isSafeInteger(value.monthEndBalanceGoalMinor) &&
        Math.abs(Number(value.monthEndBalanceGoalMinor)) <= MAX_AMOUNT_MINOR)) &&
    (value.payCycle === undefined || isPayCyclePlan(value.payCycle)) &&
    (value.incomeForecast === undefined ||
      (value.payCycle !== undefined && isIncomeForecast(value.incomeForecast))) &&
    (value.savingsGoal === undefined || isSavingsGoal(value.savingsGoal)) &&
    (value.savingsTargetOverride === undefined || isLegacySavingsTargetOverride(
      value.savingsTargetOverride,
    )) &&
    (value.lastExpectedIncomeMinor === undefined || (
      Number.isSafeInteger(value.lastExpectedIncomeMinor) &&
      Number(value.lastExpectedIncomeMinor) >= 0 &&
      Number(value.lastExpectedIncomeMinor) <= MAX_AMOUNT_MINOR
    )) &&
    (value.savingsGoalNeedsSetup === undefined || value.savingsGoalNeedsSetup === true) &&
    (value._legacyMonthlySalaryMinor === undefined || (
      Number.isSafeInteger(value._legacyMonthlySalaryMinor) &&
      Number(value._legacyMonthlySalaryMinor) > 0 &&
      Number(value._legacyMonthlySalaryMinor) <= MAX_AMOUNT_MINOR &&
      value.payCycle !== undefined &&
      value.incomeForecast === undefined
    )) &&
    value.schemaVersion === 1 &&
    isIsoDate(value.updatedAt)
  );
}

function isPayCyclePlan(value: unknown): value is PayCyclePlan {
  return (
    isRecord(value) &&
    Number.isInteger(value.paydayDay) &&
    Number(value.paydayDay) >= 1 &&
    Number(value.paydayDay) <= 31 &&
    (
      hasExactKeys(value, ["paydayDay"]) ||
      (hasExactKeys(value, ["paydayDay", "defaultSavingsTargetMinor"]) &&
        Number.isSafeInteger(value.defaultSavingsTargetMinor) &&
        Number(value.defaultSavingsTargetMinor) >= 0 &&
        Number(value.defaultSavingsTargetMinor) <= MAX_AMOUNT_MINOR) ||
      (hasExactKeys(value, ["paydayDay", "cycleEndBalanceGoalMinor"]) &&
        Number.isSafeInteger(value.cycleEndBalanceGoalMinor) &&
        Math.abs(Number(value.cycleEndBalanceGoalMinor)) <= MAX_AMOUNT_MINOR)
    )
  );
}

function isLegacySavingsTargetOverride(value: unknown): boolean {
  return isRecord(value) &&
    hasExactKeys(value, ["targetPaydayDateKey", "targetMinor"]) &&
    isLocalDateKey(value.targetPaydayDateKey) &&
    Number.isSafeInteger(value.targetMinor) &&
    Number(value.targetMinor) >= 0 &&
    Number(value.targetMinor) <= MAX_AMOUNT_MINOR;
}

function isSavingsGoal(value: unknown): value is SavingsGoal {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetDateKey", "targetMinor"]) &&
    isLocalDateKey(value.targetDateKey) &&
    Number.isSafeInteger(value.targetMinor) &&
    Number(value.targetMinor) > 0 &&
    Number(value.targetMinor) <= MAX_AMOUNT_MINOR
  );
}

function isIncomeForecast(value: unknown): value is IncomeForecast {
  return (
    isRecord(value) &&
    (hasExactKeys(value, ["id", "targetPaydayDateKey", "expectedIncomeMinor"]) ||
      (hasExactKeys(value, [
        "id",
        "targetPaydayDateKey",
        "minimumIncomeMinor",
        "expectedIncomeMinor",
      ]) &&
        Number.isSafeInteger(value.minimumIncomeMinor) &&
        Number(value.minimumIncomeMinor) >= 0 &&
        Number(value.minimumIncomeMinor) <= MAX_AMOUNT_MINOR &&
        Number(value.minimumIncomeMinor) <= Number(value.expectedIncomeMinor))) &&
    typeof value.id === "string" &&
    SYNC_ID_PATTERN.test(value.id) &&
    isLocalDateKey(value.targetPaydayDateKey) &&
    Number.isSafeInteger(value.expectedIncomeMinor) &&
    Number(value.expectedIncomeMinor) >= 0 &&
    Number(value.expectedIncomeMinor) <= MAX_AMOUNT_MINOR
  );
}

function isRecoveryAllocation(value: unknown): value is RecoveryAllocation {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["id", "refundEntryId", "expenseEntryId", "amountMinor", "createdAt", "updatedAt"],
      ["deletedAt"],
    ) &&
    typeof value.id === "string" && SYNC_ID_PATTERN.test(value.id) &&
    typeof value.refundEntryId === "string" && SYNC_ID_PATTERN.test(value.refundEntryId) &&
    typeof value.expenseEntryId === "string" && SYNC_ID_PATTERN.test(value.expenseEntryId) &&
    value.refundEntryId !== value.expenseEntryId &&
    Number.isSafeInteger(value.amountMinor) &&
    Number(value.amountMinor) > 0 &&
    Number(value.amountMinor) <= MAX_AMOUNT_MINOR &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt) &&
    new Date(value.updatedAt).getTime() >= new Date(value.createdAt).getTime() &&
    (value.deletedAt === undefined || (
      isIsoDate(value.deletedAt) && value.deletedAt === value.updatedAt
    ))
  );
}

function isSavingsEvent(value: unknown): value is SavingsEvent {
  if (!isRecord(value) || typeof value.id !== "string" ||
      !SYNC_ID_PATTERN.test(value.id) ||
      !hasExactKeys(value, [
        "id", "kind", "amountMinor", "note", "occurredAt", "localDateKey",
        "localMonthKey", "timezoneOffsetMinutes", "createdAt", "updatedAt",
      ], [
        "deletedAt", "linkedExpenseEntryId", "cycleStartDateKey", "cycleEndDateKey",
        "goalMinorSnapshot", "openingRetainedMinor", "closingRetainedMinor",
        "netGrowthMinor", "transferToRetainedMinor",
      ])) return false;
  const isSettlement = value.kind === "cycle_settlement";
  if (!(["opening", "reserve", "release", "cycle_settlement"] as unknown[]).includes(value.kind)) return false;
  if (!Number.isSafeInteger(value.amountMinor) ||
      Number(value.amountMinor) < (isSettlement ? 0 : 1) ||
      Number(value.amountMinor) > MAX_AMOUNT_MINOR ||
      typeof value.note !== "string" || value.note.length > 200 ||
      !isIsoDate(value.occurredAt) || !isLocalDateKey(value.localDateKey) ||
      value.localMonthKey !== value.localDateKey.slice(0, 7) ||
      !Number.isInteger(value.timezoneOffsetMinutes) ||
      Math.abs(Number(value.timezoneOffsetMinutes)) > 14 * 60 ||
      !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt) ||
      new Date(value.updatedAt).getTime() < new Date(value.createdAt).getTime() ||
      (value.deletedAt !== undefined && (!isIsoDate(value.deletedAt) || value.deletedAt !== value.updatedAt))) {
    return false;
  }
  if (!hasConsistentLocalDate(value as unknown as LedgerEntry)) return false;
  if (value.kind === "release" && value.linkedExpenseEntryId !== undefined &&
      (typeof value.linkedExpenseEntryId !== "string" ||
        !SYNC_ID_PATTERN.test(value.linkedExpenseEntryId))) return false;
  if (value.kind !== "release" && value.linkedExpenseEntryId !== undefined) return false;
  if (!isSettlement) {
    return value.cycleStartDateKey === undefined && value.cycleEndDateKey === undefined &&
      value.goalMinorSnapshot === undefined && value.openingRetainedMinor === undefined &&
      value.closingRetainedMinor === undefined && value.netGrowthMinor === undefined &&
      value.transferToRetainedMinor === undefined;
  }
  return isLocalDateKey(value.cycleStartDateKey) &&
    isLocalDateKey(value.cycleEndDateKey) &&
    value.cycleStartDateKey <= value.cycleEndDateKey &&
    Number.isSafeInteger(value.goalMinorSnapshot) && Number(value.goalMinorSnapshot) >= 0 &&
    Number(value.goalMinorSnapshot) <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(value.openingRetainedMinor) &&
    Math.abs(Number(value.openingRetainedMinor)) <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(value.closingRetainedMinor) &&
    Math.abs(Number(value.closingRetainedMinor)) <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(value.netGrowthMinor) &&
    Math.abs(Number(value.netGrowthMinor)) <= MAX_AMOUNT_MINOR &&
    Number(value.netGrowthMinor) === Number(value.closingRetainedMinor) - Number(value.openingRetainedMinor) &&
    (value.transferToRetainedMinor === undefined || value.transferToRetainedMinor === value.amountMinor);
}

function isSyncChange(value: unknown): value is SyncChange {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["seq", "entityType", "entityId", "version", "payload"]) ||
    typeof value.seq !== "string" ||
    !isNonEmptyString(value.entityId) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  ) {
    return false;
  }

  if (value.entityType === "entry") {
    return isLedgerEntry(value.payload) && value.payload.id === value.entityId;
  }
  if (value.entityType === "settings") {
    return isAppSettings(value.payload) && value.payload.id === value.entityId;
  }
  if (value.entityType === "recoveryAllocation") {
    return isRecoveryAllocation(value.payload) && value.payload.id === value.entityId;
  }
  if (value.entityType === "savingsEvent") {
    return isSavingsEvent(value.payload) && value.payload.id === value.entityId;
  }
  return false;
}

function isSyncMutationResult(value: unknown): value is SyncMutationResult {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return false;

  if (value.status === "applied" || value.status === "duplicate") {
    const hasConfirmation = Object.hasOwn(value, "incomeConfirmation");
    const confirmation = value.incomeConfirmation;
    const validConfirmation = !hasConfirmation || (
      isRecord(confirmation) &&
      hasExactKeys(
        confirmation,
        confirmation.entry === undefined
          ? ["confirmationId", "forecastId", "actualIncomeMinor"]
          : ["confirmationId", "forecastId", "actualIncomeMinor", "entryVersion", "entry"],
      ) &&
      isNonEmptyString(confirmation.confirmationId) &&
      isNonEmptyString(confirmation.forecastId) &&
      Number.isSafeInteger(confirmation.actualIncomeMinor) &&
      Number(confirmation.actualIncomeMinor) >= 0 &&
      (
        confirmation.entry === undefined
          ? confirmation.actualIncomeMinor === 0
          : Number(confirmation.actualIncomeMinor) > 0 &&
             Number.isSafeInteger(confirmation.entryVersion) &&
             Number(confirmation.entryVersion) >= 1 &&
             isLedgerEntry(confirmation.entry) &&
            confirmation.entry.id === confirmation.forecastId
       )
     );
    return (
      hasExactKeys(
        value,
        hasConfirmation
          ? ["id", "status", "version", "incomeConfirmation"]
          : ["id", "status", "version"],
      ) &&
      Number.isSafeInteger(value.version) &&
      Number(value.version) >= 1 &&
      validConfirmation
    );
  }
  if (value.status === "conflict") {
    return hasExactKeys(value, ["id", "status", "remote"]) && isSyncChange(value.remote);
  }
  return false;
}

function isSessionResponse(value: unknown): value is SessionResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "user", "cloud"]) ||
    value.schemaVersion !== API_SCHEMA_VERSION ||
    !isRecord(value.user) ||
    !hasExactKeys(value.user, ["id", "email"]) ||
    !isNonEmptyString(value.user.id) ||
    !isNonEmptyString(value.user.email) ||
    !isRecord(value.cloud) ||
    !hasExactKeys(value.cloud, [
      "syncStatus",
      "generation",
      "hasData",
      "entryCount",
      "attachmentCount",
      "cursor",
    ])
  ) {
    return false;
  }

  return (
    (
      value.cloud.syncStatus === "disabled" ||
      value.cloud.syncStatus === "enabled" ||
      value.cloud.syncStatus === "deleting"
    ) &&
    isCloudGeneration(
      value.cloud.generation,
      value.cloud.syncStatus === "disabled",
    ) &&
    typeof value.cloud.hasData === "boolean" &&
    Number.isSafeInteger(value.cloud.entryCount) &&
    Number(value.cloud.entryCount) >= 0 &&
    Number.isSafeInteger(value.cloud.attachmentCount) &&
    Number(value.cloud.attachmentCount) >= 0 &&
    typeof value.cloud.cursor === "string"
  );
}

function isEnableCloudSyncResponse(value: unknown): value is {
  schemaVersion: typeof API_SCHEMA_VERSION;
  syncStatus: "enabled";
  generation: number;
} {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "syncStatus", "generation"]) &&
    value.schemaVersion === API_SCHEMA_VERSION &&
    value.syncStatus === "enabled" &&
    isCloudGeneration(value.generation, false)
  );
}

function isCloudAccountDeletionResponse(
  value: unknown,
): value is CloudAccountDeletionResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "complete",
      "deletedObjects",
      "remainingObjects",
    ]) &&
    value.schemaVersion === API_SCHEMA_VERSION &&
    typeof value.complete === "boolean" &&
    Number.isSafeInteger(value.deletedObjects) &&
    Number(value.deletedObjects) >= 0 &&
    Number.isSafeInteger(value.remainingObjects) &&
    Number(value.remainingObjects) >= 0
  );
}

function isSyncResponse(value: unknown): value is SyncResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "results", "changes", "nextCursor", "hasMore"]) &&
    value.schemaVersion === SYNC_SCHEMA_VERSION &&
    Array.isArray(value.results) &&
    value.results.every(isSyncMutationResult) &&
    Array.isArray(value.changes) &&
    value.changes.every(isSyncChange) &&
    typeof value.nextCursor === "string" &&
    typeof value.hasMore === "boolean"
  );
}

function normalizeLegacySettingsChange(change: SyncChange, now: Date): SyncChange {
  if (change.entityType !== "settings") return change;
  const raw = change.payload as SyncSettingsResponsePayload;
  const legacySalary = raw._legacyMonthlySalaryMinor;
  const settings = { ...raw };
  delete settings._legacyMonthlySalaryMinor;
  delete settings.monthEndBalanceGoalMinor;
  delete settings.savingsTargetOverride;
  delete settings.cycleSavingsTargetOverride;
  const oldCycleTarget = settings.payCycle?.defaultSavingsTargetMinor ??
    settings.payCycle?.cycleEndBalanceGoalMinor;
  if (settings.payCycle) settings.payCycle = { paydayDay: settings.payCycle.paydayDay };
  if (settings.incomeForecast) {
    settings.incomeForecast = {
      id: settings.incomeForecast.id,
      targetPaydayDateKey: settings.incomeForecast.targetPaydayDateKey,
      expectedIncomeMinor: settings.incomeForecast.expectedIncomeMinor,
    };
  }
  if (legacySalary !== undefined && !settings.incomeForecast) {
    const targetPaydayDateKey = resolveNextPaydayDateKey(settings.payCycle!.paydayDay, now);
    settings.incomeForecast = {
      id: `legacy-income-${targetPaydayDateKey}`,
      targetPaydayDateKey,
      expectedIncomeMinor: legacySalary,
    };
  }
  if (settings.incomeForecast && settings.lastExpectedIncomeMinor === undefined) {
    settings.lastExpectedIncomeMinor = settings.incomeForecast.expectedIncomeMinor;
  }
  if (oldCycleTarget !== undefined && oldCycleTarget !== 0 && !settings.savingsGoal) {
    settings.savingsGoalNeedsSetup = true;
  }
  if (settings.savingsGoal) delete settings.savingsGoalNeedsSetup;
  return {
    ...change,
    payload: settings,
    ...(legacySalary !== undefined ? { claimLegacyIncomeForecast: true as const } : {}),
    ...(oldCycleTarget !== undefined && oldCycleTarget !== 0
      ? { claimLegacySavingsTarget: true as const }
      : {}),
  };
}

function normalizeLegacySettingsResponse(response: SyncResponse, now: Date): SyncResponse {
  return {
    ...response,
    results: response.results.map((result) => result.status === "conflict"
      ? { ...result, remote: normalizeLegacySettingsChange(result.remote, now) }
      : result),
    changes: response.changes.map((change) => normalizeLegacySettingsChange(change, now)),
  };
}

function validateSyncResponseForRequest(
  response: SyncResponse,
  request: SyncRequest,
): SyncResponse {
  const mutations = new Map(request.mutations.map((mutation) => [mutation.id, mutation]));
  const resultIds = new Set<string>();
  for (const result of response.results) {
    const mutation = mutations.get(result.id);
    if (!mutation || resultIds.has(result.id)) {
      throw responseError("The sync service returned results for unknown mutations.");
    }
    resultIds.add(result.id);
    if (
      result.status === "conflict" &&
      (
        result.remote.entityType !== mutation.entityType ||
        result.remote.entityId !== mutation.entityId
      )
    ) {
      throw responseError("The sync service returned a conflict for another entity.");
    }
    if (
      result.status !== "conflict" &&
      mutation.entityType === "settings" &&
      (
        (mutation.payload.incomeConfirmation !== undefined) !==
          (result.incomeConfirmation !== undefined) ||
        (result.incomeConfirmation !== undefined &&
          mutation.payload.incomeConfirmation?.forecastId !==
            result.incomeConfirmation.forecastId)
      )
    ) {
      throw responseError("The sync service returned an unrelated income confirmation.");
    }
  }
  if (resultIds.size !== request.mutations.length) {
    throw responseError("The sync service omitted mutation results.");
  }
  return response;
}

interface AttachmentUploadResponse {
  schemaVersion: typeof API_SCHEMA_VERSION;
  attachment: {
    id: string;
    entryId: string;
    mimeType: string;
    size: number;
    width: number;
    height: number;
    sha256: string;
  };
}

function isAttachmentUploadResponse(value: unknown): value is AttachmentUploadResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "attachment"]) ||
    value.schemaVersion !== API_SCHEMA_VERSION ||
    !isRecord(value.attachment) ||
    !hasExactKeys(value.attachment, [
      "id",
      "entryId",
      "mimeType",
      "size",
      "width",
      "height",
      "sha256",
    ])
  ) {
    return false;
  }
  return (
    isNonEmptyString(value.attachment.id) &&
    isNonEmptyString(value.attachment.entryId) &&
    value.attachment.mimeType === "image/jpeg" &&
    Number.isSafeInteger(value.attachment.size) &&
    Number(value.attachment.size) >= 1 &&
    Number(value.attachment.size) <= MAX_PROCESSED_IMAGE_BYTES &&
    Number.isSafeInteger(value.attachment.width) &&
    Number(value.attachment.width) >= 1 &&
    Number(value.attachment.width) <= MAX_IMAGE_DIMENSION &&
    Number.isSafeInteger(value.attachment.height) &&
    Number(value.attachment.height) >= 1 &&
    Number(value.attachment.height) <= MAX_IMAGE_DIMENSION &&
    typeof value.attachment.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.attachment.sha256)
  );
}

function responseError(message: string, cause?: unknown): SyncApiError {
  return new SyncApiError("invalid-response", message, { cause });
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", await blobToArrayBuffer(blob)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parsePositiveHeader(
  response: Response,
  name: string,
  maximum: number,
): number | undefined {
  const value = response.headers.get(name);
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : undefined;
}

async function parseJsonResponse<T>(
  response: Response,
  validate: (value: unknown) => value is T,
): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw responseError("The sync service returned malformed JSON.", error);
  }
  if (!validate(value)) {
    throw responseError("The sync service returned an unsupported response.");
  }
  return value;
}

async function requestError(response: Response): Promise<SyncApiError> {
  if (response.status === 401 || response.status === 403) {
    return new SyncApiError("unauthorized", "Sign in is required to sync this ledger.");
  }
  if (response.status === 507) {
    return new SyncApiError("quota", "Cloud attachment storage quota has been reached.");
  }
  if (response.status === 409) {
    try {
      const value = await response.json() as unknown;
      if (isRecord(value) && isRecord(value.error) && typeof value.error.code === "string") {
        const code = value.error.code;
        if (
          code === "stale_cloud_generation" ||
          code === "cloud_sync_disabled" ||
          code === "account_deletion_in_progress" ||
          code === "upgrade_required"
        ) {
          const message = typeof value.error.message === "string"
            ? value.error.message
            : "Cloud sync state changed.";
          return new SyncApiError(code, message);
        }
      }
    } catch {
      // Fall through to the generic HTTP error when the error body is malformed.
    }
  }
  return new SyncApiError(
    "network",
    `The sync service returned HTTP ${response.status}.`,
  );
}

async function request(
  fetcher: SyncFetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    const response = await fetcher(input, { ...init, credentials: "same-origin" });
    if (!response.ok) throw await requestError(response);
    return response;
  } catch (error) {
    if (error instanceof SyncApiError) throw error;
    throw new SyncApiError("network", "The sync service could not be reached.", { cause: error });
  }
}

export function createSyncApiClient(
  fetcher: SyncFetch = globalThis.fetch.bind(globalThis),
  wait: SyncWait = waitForRetry,
  now: () => Date = () => new Date(),
): SyncApiClient {
  return {
    async getSession() {
      const response = await request(fetcher, "/api/session", {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      return parseJsonResponse(response, isSessionResponse);
    },

    async enableCloudSync(expectedGeneration) {
      const generation = requireCloudGeneration(expectedGeneration);
      const response = await request(fetcher, "/api/account/enable", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmation: "ENABLE", generation }),
      });
      const result = await parseJsonResponse(response, isEnableCloudSyncResponse);
      if (
        result.generation !== generation &&
        result.generation !== generation + 1
      ) {
        throw responseError("The sync service enabled an unexpected cloud generation.");
      }
      return result.generation;
    },

    async deleteCloudData(expectedGeneration) {
      const generation = requireCloudGeneration(expectedGeneration, false);
      for (let page = 0; page < 10_000; page += 1) {
        const response = await request(fetcher, "/api/account", {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ confirmation: "DELETE", generation }),
        });
        const result = await parseJsonResponse(response, isCloudAccountDeletionResponse);
        if (result.complete) {
          if (response.status !== 200 || result.remainingObjects !== 0) {
            throw responseError("The cloud deletion service returned an inconsistent completion response.");
          }
          return;
        }
        if (response.status !== 202 || result.remainingObjects === 0) {
          throw responseError("The cloud deletion service stopped making progress.");
        }
        const retryAfterSeconds = parsePositiveHeader(response, "Retry-After", 60);
        if (retryAfterSeconds === undefined) {
          throw responseError("The cloud deletion service returned an invalid retry interval.");
        }
        await wait(retryAfterSeconds * 1_000);
      }
      throw responseError("The cloud deletion service exceeded its page limit.");
    },

    async sync(syncRequest, expectedGeneration) {
      const generation = requireCloudGeneration(expectedGeneration, false);
      const response = await request(fetcher, "/api/sync", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Jiyibi-Sync-Generation": String(generation),
        },
        body: JSON.stringify(syncRequest),
      });
      return validateSyncResponseForRequest(normalizeLegacySettingsResponse(
        await parseJsonResponse(response, isSyncResponse),
        now(),
      ), syncRequest);
    },

    async putAttachment(attachment, expectedGeneration) {
      const generation = requireCloudGeneration(expectedGeneration, false);
      const sha256 = await sha256Hex(attachment.blob);
      const response = await request(
        fetcher,
        `/api/attachments/${encodeURIComponent(attachment.id)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": attachment.mimeType,
            "X-Content-Sha256": sha256,
            "X-Entry-Id": attachment.entryId,
            "X-Height": String(attachment.height),
            "X-Jiyibi-Sync-Generation": String(generation),
            "X-Width": String(attachment.width),
          },
          body: attachment.blob,
        },
      );
      const uploaded = await parseJsonResponse(response, isAttachmentUploadResponse);
      if (
        uploaded.attachment.id !== attachment.id ||
        uploaded.attachment.entryId !== attachment.entryId ||
        uploaded.attachment.mimeType !== attachment.mimeType ||
        uploaded.attachment.size !== attachment.size ||
        uploaded.attachment.width !== attachment.width ||
        uploaded.attachment.height !== attachment.height ||
        uploaded.attachment.sha256 !== sha256
      ) {
        throw responseError("The sync service confirmed different attachment metadata.");
      }
    },

    async getAttachment(attachmentId, expectedGeneration) {
      const generation = requireCloudGeneration(expectedGeneration, false);
      let response: Response | undefined;
      let retryAttempt = 0;
      let waitedMilliseconds = 0;
      while (true) {
        try {
          response = await fetcher(`/api/attachments/${encodeURIComponent(attachmentId)}`, {
            method: "GET",
            credentials: "same-origin",
            headers: {
              Accept: "image/*",
              "X-Jiyibi-Sync-Generation": String(generation),
            },
          });
        } catch (error) {
          throw new SyncApiError("network", "The sync service could not be reached.", {
            cause: error,
          });
        }

        if (response.status !== 503 || waitedMilliseconds >= ATTACHMENT_DOWNLOAD_RETRY_WINDOW_MS) {
          break;
        }

        const remainingMilliseconds = ATTACHMENT_DOWNLOAD_RETRY_WINDOW_MS - waitedMilliseconds;
        const retryAfterSeconds = parsePositiveHeader(response, "Retry-After", 60);
        const retryAfterMilliseconds = retryAfterSeconds === undefined
          ? 0
          : retryAfterSeconds * 1_000;
        const backoffMilliseconds = Math.min(
          ATTACHMENT_DOWNLOAD_INITIAL_RETRY_MS * 2 ** retryAttempt,
          ATTACHMENT_DOWNLOAD_MAX_RETRY_MS,
        );
        const delayMilliseconds = Math.min(
          Math.max(backoffMilliseconds, retryAfterMilliseconds),
          remainingMilliseconds,
        );
        await wait(delayMilliseconds);
        waitedMilliseconds += delayMilliseconds;
        retryAttempt += 1;
      }

      if (!response) throw responseError("The sync service did not return an attachment response.");
      if (response.status === 404) return undefined;
      if (!response.ok) throw await requestError(response);

      const mimeType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const size = parsePositiveHeader(response, "content-length", MAX_PROCESSED_IMAGE_BYTES);
      const width = parsePositiveHeader(response, "x-width", MAX_IMAGE_DIMENSION);
      const height = parsePositiveHeader(response, "x-height", MAX_IMAGE_DIMENSION);
      const entryId = response.headers.get("x-entry-id");
      const expectedSha256 = response.headers.get("x-content-sha256")?.toLowerCase();
      if (
        mimeType !== "image/jpeg" ||
        size === undefined ||
        width === undefined ||
        height === undefined ||
        !isNonEmptyString(entryId) ||
        !expectedSha256 ||
        !/^[a-f0-9]{64}$/.test(expectedSha256)
      ) {
        throw responseError("The sync service returned invalid attachment metadata.");
      }

      let blob: Blob;
      try {
        blob = await response.blob();
      } catch (error) {
        throw new SyncApiError("network", "The synced attachment could not be downloaded.", {
          cause: error,
        });
      }
      if (blob.size !== size || blob.type.toLowerCase() !== mimeType) {
        throw responseError("The synced attachment did not match its metadata.");
      }

      let actualSha256: string;
      try {
        actualSha256 = await sha256Hex(blob);
      } catch (error) {
        throw responseError("The synced attachment could not be verified.", error);
      }
      if (actualSha256 !== expectedSha256) {
        throw responseError("The synced attachment failed its integrity check.");
      }
      return { blob, entryId, mimeType, size, width, height };
    },
  };
}
