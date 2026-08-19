import { ApiError } from "./errors";
import type {
  LedgerEntryPayload,
  RecoveryAllocationPayload,
  SavingsEventPayload,
  SettingsMutationPayload,
  SyncMutation,
  SyncProtocolVersion,
  SyncRequestBody,
} from "./types";

export const MAX_AMOUNT_MINOR = 9_000_000_000_000_000;
export const MAX_MUTATIONS = 50;
export const MAX_SYNC_BODY_BYTES = 256 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_TIMEZONE_OFFSET_MINUTES = 14 * 60;
const MAX_VERSION = 9_000_000_000_000_000;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_PATTERN = /^(?:0|[1-9]\d{0,18})$/;
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

export function isValidId(value: unknown, prefix?: string): value is string {
  return (
    typeof value === "string" &&
    value.length > (prefix?.length ?? 0) &&
    value.length <= MAX_ID_LENGTH &&
    ID_PATTERN.test(value) &&
    (prefix === undefined || value.startsWith(prefix))
  );
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
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function hasConsistentLocalDate(entry: LedgerEntryPayload): boolean {
  const localInstant = new Date(entry.occurredAt).getTime() - entry.timezoneOffsetMinutes * 60_000;
  const expectedDateKey = new Date(localInstant).toISOString().slice(0, 10);
  return entry.localDateKey === expectedDateKey && entry.localMonthKey === expectedDateKey.slice(0, 7);
}

const ENTRY_TREATMENTS = new Set([
  "ordinary_expense",
  "one_time_expense",
  "reimbursable_expense",
  "ordinary_income",
  "refund_reimbursement",
  "account_transfer",
]);
const CONFIRMATION_STATUSES = new Set(["not_needed", "pending", "confirmed"]);
const SAVINGS_EVENT_KINDS = new Set(["opening", "reserve", "release", "cycle_settlement"]);

function treatmentMatchesAmount(treatment: unknown, amountMinor: number): boolean {
  if (treatment === "account_transfer") return amountMinor !== 0;
  if (
    treatment === "ordinary_expense" ||
    treatment === "one_time_expense" ||
    treatment === "reimbursable_expense"
  ) {
    return amountMinor < 0;
  }
  return amountMinor > 0;
}

function validateEntryPayload(
  value: unknown,
  entityId: string,
  protocolVersion: SyncProtocolVersion,
): LedgerEntryPayload {
  const required = [
    "id",
    "amountMinor",
    "note",
    "occurredAt",
    "localDateKey",
    "localMonthKey",
    "timezoneOffsetMinutes",
    "createdAt",
    "updatedAt",
  ] as const;
  const requiredAnalysis = protocolVersion >= 5
    ? ["treatment", "confirmationStatus"]
    : [];
  const optionalAnalysis = protocolVersion >= 5
    ? ["detectionRuleVersion", "promptedRevision"]
    : [];
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [...required, ...requiredAnalysis],
      ["attachmentId", "deletedAt", ...optionalAnalysis],
    )
  ) {
    throw new ApiError(400, "invalid_entry", "Entry payload has invalid fields");
  }
  const entry = value as unknown as LedgerEntryPayload;
  if (
    !isValidId(entry.id) ||
    entry.id !== entityId ||
    !Number.isSafeInteger(entry.amountMinor) ||
    entry.amountMinor === 0 ||
    Math.abs(entry.amountMinor) > MAX_AMOUNT_MINOR ||
    typeof entry.note !== "string" ||
    entry.note.length > 200 ||
    !isIsoDate(entry.occurredAt) ||
    !isLocalDateKey(entry.localDateKey) ||
    typeof entry.localMonthKey !== "string" ||
    !/^\d{4}-\d{2}$/.test(entry.localMonthKey) ||
    !Number.isInteger(entry.timezoneOffsetMinutes) ||
    Math.abs(entry.timezoneOffsetMinutes) > MAX_TIMEZONE_OFFSET_MINUTES ||
    (entry.attachmentId !== undefined && !isValidId(entry.attachmentId)) ||
    (protocolVersion >= 5 &&
      (entry.treatment === undefined ||
        entry.confirmationStatus === undefined ||
        !ENTRY_TREATMENTS.has(entry.treatment) ||
        !treatmentMatchesAmount(entry.treatment, entry.amountMinor) ||
        !CONFIRMATION_STATUSES.has(entry.confirmationStatus) ||
        (entry.detectionRuleVersion !== undefined &&
          (!Number.isSafeInteger(entry.detectionRuleVersion) ||
            entry.detectionRuleVersion < 0)) ||
        (entry.promptedRevision !== undefined && !isIsoDate(entry.promptedRevision)))) ||
    !isIsoDate(entry.createdAt) ||
    !isIsoDate(entry.updatedAt) ||
    (entry.deletedAt !== undefined && !isIsoDate(entry.deletedAt)) ||
    new Date(entry.updatedAt).getTime() < new Date(entry.createdAt).getTime() ||
    (entry.deletedAt !== undefined && new Date(entry.deletedAt).getTime() > new Date(entry.updatedAt).getTime()) ||
    (!entry.deletedAt && !entry.note.trim() && !entry.attachmentId) ||
    !hasConsistentLocalDate(entry)
  ) {
    throw new ApiError(400, "invalid_entry", "Entry payload is invalid");
  }
  if (entry.deletedAt && entry.attachmentId) {
    const tombstone = { ...entry };
    delete tombstone.attachmentId;
    return tombstone;
  }
  return entry;
}

function validateRecoveryAllocationPayload(
  value: unknown,
  entityId: string,
): RecoveryAllocationPayload {
  const required = [
    "id",
    "refundEntryId",
    "expenseEntryId",
    "amountMinor",
    "createdAt",
    "updatedAt",
  ] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, required, ["deletedAt"])) {
    throw new ApiError(
      400,
      "invalid_recovery_allocation",
      "Recovery allocation payload has invalid fields",
    );
  }
  const allocation = value as unknown as RecoveryAllocationPayload;
  if (
    !isValidId(allocation.id) ||
    allocation.id !== entityId ||
    !isValidId(allocation.refundEntryId) ||
    !isValidId(allocation.expenseEntryId) ||
    allocation.refundEntryId === allocation.expenseEntryId ||
    !Number.isSafeInteger(allocation.amountMinor) ||
    allocation.amountMinor <= 0 ||
    allocation.amountMinor > MAX_AMOUNT_MINOR ||
    !isIsoDate(allocation.createdAt) ||
    !isIsoDate(allocation.updatedAt) ||
    (allocation.deletedAt !== undefined && !isIsoDate(allocation.deletedAt)) ||
    new Date(allocation.updatedAt).getTime() < new Date(allocation.createdAt).getTime() ||
    (allocation.deletedAt !== undefined && allocation.deletedAt !== allocation.updatedAt)
  ) {
    throw new ApiError(
      400,
      "invalid_recovery_allocation",
      "Recovery allocation payload is invalid",
    );
  }
  return allocation;
}

function validateSavingsEventPayload(
  value: unknown,
  entityId: string,
): SavingsEventPayload {
  const commonRequired = [
    "id",
    "kind",
    "amountMinor",
    "note",
    "occurredAt",
    "localDateKey",
    "localMonthKey",
    "timezoneOffsetMinutes",
    "createdAt",
    "updatedAt",
  ] as const;
  const settlementFields = [
    "cycleStartDateKey",
    "cycleEndDateKey",
    "goalMinorSnapshot",
    "openingRetainedMinor",
    "closingRetainedMinor",
    "netGrowthMinor",
  ] as const;
  if (!isRecord(value) || !SAVINGS_EVENT_KINDS.has(value.kind as string)) {
    throw new ApiError(400, "invalid_savings_event", "Savings event payload is invalid");
  }
  const isSettlement = value.kind === "cycle_settlement";
  if (!hasOnlyKeys(
    value,
    isSettlement ? [...commonRequired, ...settlementFields] : commonRequired,
    isSettlement
      ? ["transferToRetainedMinor", "deletedAt"]
      : value.kind === "release"
        ? ["linkedExpenseEntryId", "deletedAt"]
        : ["deletedAt"],
  )) {
    throw new ApiError(
      400,
      "invalid_savings_event",
      "Savings event payload has invalid fields",
    );
  }
  const event = value as unknown as SavingsEventPayload;
  const hasValidAmount = Number.isSafeInteger(event.amountMinor)
    && event.amountMinor >= (isSettlement ? 0 : 1)
    && event.amountMinor <= MAX_AMOUNT_MINOR;
  const hasValidSettlement = !isSettlement || (
    isLocalDateKey(event.cycleStartDateKey) &&
    isLocalDateKey(event.cycleEndDateKey) &&
    event.cycleStartDateKey! <= event.cycleEndDateKey! &&
    Number.isSafeInteger(event.goalMinorSnapshot) &&
    Number(event.goalMinorSnapshot) >= 0 &&
    Number(event.goalMinorSnapshot) <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(event.openingRetainedMinor) &&
    Math.abs(Number(event.openingRetainedMinor)) <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(event.closingRetainedMinor) &&
    Math.abs(Number(event.closingRetainedMinor)) <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(event.netGrowthMinor) &&
    Math.abs(Number(event.netGrowthMinor)) <= MAX_AMOUNT_MINOR &&
    Number(event.netGrowthMinor) ===
      Number(event.closingRetainedMinor) - Number(event.openingRetainedMinor) &&
    (event.transferToRetainedMinor === undefined || (
      Number.isSafeInteger(event.transferToRetainedMinor) &&
      Number(event.transferToRetainedMinor) === event.amountMinor
    ))
  );
  if (
    !isValidId(event.id) ||
    event.id !== entityId ||
    !hasValidAmount ||
    typeof event.note !== "string" ||
    event.note.length > 200 ||
    !isIsoDate(event.occurredAt) ||
    !isLocalDateKey(event.localDateKey) ||
    typeof event.localMonthKey !== "string" ||
    !/^\d{4}-\d{2}$/.test(event.localMonthKey) ||
    !Number.isInteger(event.timezoneOffsetMinutes) ||
    Math.abs(event.timezoneOffsetMinutes) > MAX_TIMEZONE_OFFSET_MINUTES ||
    !hasConsistentLocalDate(event as unknown as LedgerEntryPayload) ||
    (event.linkedExpenseEntryId !== undefined && !isValidId(event.linkedExpenseEntryId)) ||
    !hasValidSettlement ||
    !isIsoDate(event.createdAt) ||
    !isIsoDate(event.updatedAt) ||
    (event.deletedAt !== undefined && !isIsoDate(event.deletedAt)) ||
    new Date(event.updatedAt).getTime() < new Date(event.createdAt).getTime() ||
    (event.deletedAt !== undefined && event.deletedAt !== event.updatedAt)
  ) {
    throw new ApiError(400, "invalid_savings_event", "Savings event payload is invalid");
  }
  return event;
}

function validateSettingsPayload(
  value: unknown,
  entityId: string,
  protocolVersion: SyncProtocolVersion,
): SettingsMutationPayload {
  const required = ["id", "currency", "initialBalanceMinor", "schemaVersion", "updatedAt"] as const;
  const optional = protocolVersion === 1
    ? []
    : protocolVersion === 2
      ? ["monthEndBalanceGoalMinor"]
      : protocolVersion === 3
        ? ["monthEndBalanceGoalMinor", "payCycle"]
        : protocolVersion <= 5
          ? ["monthEndBalanceGoalMinor", "payCycle", "incomeForecast"]
          : [
            "monthEndBalanceGoalMinor",
            "payCycle",
            "incomeForecast",
            "savingsTargetOverride",
          ];
  if (!isRecord(value) || !hasOnlyKeys(value, required, optional)) {
    throw new ApiError(400, "invalid_settings", "Settings payload has invalid fields");
  }
  const settings = value as unknown as SettingsMutationPayload;
  const hasPayCycle = Object.hasOwn(settings, "payCycle");
  const hasIncomeForecast = Object.hasOwn(settings, "incomeForecast");
  const hasSavingsTargetOverride = Object.hasOwn(settings, "savingsTargetOverride");
  if (
    entityId !== "primary" ||
    settings.id !== "primary" ||
    settings.currency !== "CNY" ||
    settings.schemaVersion !== 1 ||
    !Number.isSafeInteger(settings.initialBalanceMinor) ||
    Math.abs(settings.initialBalanceMinor) > MAX_AMOUNT_MINOR ||
    (settings.monthEndBalanceGoalMinor !== undefined &&
      settings.monthEndBalanceGoalMinor !== null &&
      (!Number.isSafeInteger(settings.monthEndBalanceGoalMinor) ||
        Math.abs(settings.monthEndBalanceGoalMinor) > MAX_AMOUNT_MINOR)) ||
    (settings.payCycle !== undefined &&
      settings.payCycle !== null &&
      !isValidPayCycle(settings.payCycle, protocolVersion)) ||
    (settings.incomeForecast !== undefined &&
      settings.incomeForecast !== null &&
      !isValidIncomeForecast(settings.incomeForecast)) ||
    (settings.savingsTargetOverride !== undefined &&
      settings.savingsTargetOverride !== null &&
      !isValidSavingsTargetOverride(settings.savingsTargetOverride)) ||
    (hasPayCycle && settings.payCycle === undefined) ||
    (hasIncomeForecast && settings.incomeForecast === undefined) ||
    (hasSavingsTargetOverride && settings.savingsTargetOverride === undefined) ||
    (protocolVersion >= 4 && settings.incomeForecast !== undefined &&
      settings.incomeForecast !== null && settings.payCycle === null) ||
    (protocolVersion >= 4 && settings.payCycle === null &&
      (!hasIncomeForecast || settings.incomeForecast !== null)) ||
    (protocolVersion >= 6 && settings.savingsTargetOverride !== undefined &&
      settings.savingsTargetOverride !== null && settings.payCycle === null) ||
    (protocolVersion >= 6 && settings.payCycle === null &&
      (!hasSavingsTargetOverride || settings.savingsTargetOverride !== null)) ||
    !isIsoDate(settings.updatedAt)
  ) {
    throw new ApiError(400, "invalid_settings", "Settings payload is invalid");
  }
  return settings;
}

function isValidPayCycle(
  value: unknown,
  protocolVersion: SyncProtocolVersion,
): boolean {
  if (!isRecord(value)) return false;
  const required = protocolVersion === 3
    ? ["paydayDay", "monthlySalaryMinor", "cycleEndBalanceGoalMinor"] as const
    : protocolVersion <= 5
      ? ["paydayDay", "cycleEndBalanceGoalMinor"] as const
      : ["paydayDay", "defaultSavingsTargetMinor"] as const;
  if (!hasOnlyKeys(value, required)) return false;
  if (
    !Number.isInteger(value.paydayDay) ||
    Number(value.paydayDay) < 1 ||
    Number(value.paydayDay) > 31 ||
    (protocolVersion <= 5
      ? !Number.isSafeInteger(value.cycleEndBalanceGoalMinor) ||
        Math.abs(Number(value.cycleEndBalanceGoalMinor)) > MAX_AMOUNT_MINOR
      : !Number.isSafeInteger(value.defaultSavingsTargetMinor) ||
        Number(value.defaultSavingsTargetMinor) < 0 ||
        Number(value.defaultSavingsTargetMinor) > MAX_AMOUNT_MINOR)
  ) {
    return false;
  }
  return protocolVersion !== 3 || (
    Number.isSafeInteger(value.monthlySalaryMinor) &&
    Number(value.monthlySalaryMinor) > 0 &&
    Number(value.monthlySalaryMinor) <= MAX_AMOUNT_MINOR
  );
}

function isValidSavingsTargetOverride(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["targetPaydayDateKey", "targetMinor"]) &&
    isLocalDateKey(value.targetPaydayDateKey) &&
    Number.isSafeInteger(value.targetMinor) &&
    Number(value.targetMinor) >= 0 &&
    Number(value.targetMinor) <= MAX_AMOUNT_MINOR
  );
}

function isValidIncomeForecast(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "targetPaydayDateKey",
      "minimumIncomeMinor",
      "expectedIncomeMinor",
    ]) &&
    isValidId(value.id) &&
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

function validateCursor(value: unknown): string {
  if (
    typeof value !== "string" ||
    !CURSOR_PATTERN.test(value) ||
    BigInt(value) > MAX_SQLITE_INTEGER
  ) {
    throw new ApiError(400, "invalid_cursor", "Cursor must be a valid decimal string");
  }
  return value;
}

function validateMutation(value: unknown, protocolVersion: SyncProtocolVersion): SyncMutation {
  const keys = ["id", "entityType", "entityId", "baseVersion", "payload"] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isValidId(value.id)) {
    throw new ApiError(400, "invalid_mutation", "Mutation is invalid");
  }
  if (
    (value.entityType !== "entry" && value.entityType !== "settings" &&
      (protocolVersion < 5 || value.entityType !== "recoveryAllocation") &&
      (protocolVersion < 6 || value.entityType !== "savingsEvent")) ||
    !Number.isSafeInteger(value.baseVersion) ||
    Number(value.baseVersion) < 0 ||
    Number(value.baseVersion) > MAX_VERSION
  ) {
    throw new ApiError(400, "invalid_mutation", "Mutation is invalid");
  }
  const entityId = value.entityId;
  if (value.entityType === "entry") {
    if (!isValidId(entityId)) {
      throw new ApiError(400, "invalid_mutation", "Entry mutation ID is invalid");
    }
    return {
      id: value.id,
      entityType: "entry",
      entityId,
      baseVersion: Number(value.baseVersion),
      payload: validateEntryPayload(value.payload, entityId, protocolVersion),
    };
  }
  if (value.entityType === "recoveryAllocation") {
    if (!isValidId(entityId)) {
      throw new ApiError(400, "invalid_mutation", "Recovery allocation ID is invalid");
    }
    return {
      id: value.id,
      entityType: "recoveryAllocation",
      entityId,
      baseVersion: Number(value.baseVersion),
      payload: validateRecoveryAllocationPayload(value.payload, entityId),
    };
  }
  if (value.entityType === "savingsEvent") {
    if (!isValidId(entityId)) {
      throw new ApiError(400, "invalid_mutation", "Savings event ID is invalid");
    }
    return {
      id: value.id,
      entityType: "savingsEvent",
      entityId,
      baseVersion: Number(value.baseVersion),
      payload: validateSavingsEventPayload(value.payload, entityId),
    };
  }
  if (entityId !== "primary") {
    throw new ApiError(400, "invalid_mutation", "Settings mutation ID is invalid");
  }
  return {
    id: value.id,
    entityType: "settings",
    entityId,
    baseVersion: Number(value.baseVersion),
    payload: validateSettingsPayload(value.payload, entityId, protocolVersion),
  };
}

export function validateSyncRequest(value: unknown): SyncRequestBody {
  const keys = ["schemaVersion", "cursor", "mutations"] as const;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, keys) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 &&
      value.schemaVersion !== 3 && value.schemaVersion !== 4 &&
      value.schemaVersion !== 5 && value.schemaVersion !== 6)
  ) {
    throw new ApiError(400, "invalid_sync_request", "Sync request is invalid");
  }
  if (!Array.isArray(value.mutations) || value.mutations.length > MAX_MUTATIONS) {
    throw new ApiError(400, "invalid_sync_request", `At most ${MAX_MUTATIONS} mutations are allowed`);
  }
  const protocolVersion = value.schemaVersion;
  const mutations = value.mutations.map((mutation) =>
    validateMutation(mutation, protocolVersion));
  if (new Set(mutations.map((mutation) => mutation.id)).size !== mutations.length) {
    throw new ApiError(400, "duplicate_mutation", "Mutation IDs must be unique within a request");
  }
  if (
    new Set(mutations.map((mutation) => `${mutation.entityType}:${mutation.entityId}`)).size !==
      mutations.length
  ) {
    throw new ApiError(
      400,
      "duplicate_entity_mutation",
      "At most one mutation per entity is allowed within a request",
    );
  }
  return {
    schemaVersion: protocolVersion,
    cursor: validateCursor(value.cursor),
    mutations,
  };
}
