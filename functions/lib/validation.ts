import { ApiError } from "./errors";
import type {
  AppSettingsPayload,
  LedgerEntryPayload,
  SyncMutation,
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

function validateEntryPayload(value: unknown, entityId: string): LedgerEntryPayload {
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
  if (!isRecord(value) || !hasOnlyKeys(value, required, ["attachmentId", "deletedAt"])) {
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

function validateSettingsPayload(value: unknown, entityId: string): AppSettingsPayload {
  const required = ["id", "currency", "initialBalanceMinor", "schemaVersion", "updatedAt"] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, required)) {
    throw new ApiError(400, "invalid_settings", "Settings payload has invalid fields");
  }
  const settings = value as unknown as AppSettingsPayload;
  if (
    entityId !== "primary" ||
    settings.id !== "primary" ||
    settings.currency !== "CNY" ||
    settings.schemaVersion !== 1 ||
    !Number.isSafeInteger(settings.initialBalanceMinor) ||
    Math.abs(settings.initialBalanceMinor) > MAX_AMOUNT_MINOR ||
    !isIsoDate(settings.updatedAt)
  ) {
    throw new ApiError(400, "invalid_settings", "Settings payload is invalid");
  }
  return settings;
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

function validateMutation(value: unknown): SyncMutation {
  const keys = ["id", "entityType", "entityId", "baseVersion", "payload"] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isValidId(value.id)) {
    throw new ApiError(400, "invalid_mutation", "Mutation is invalid");
  }
  if (
    (value.entityType !== "entry" && value.entityType !== "settings") ||
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
      payload: validateEntryPayload(value.payload, entityId),
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
    payload: validateSettingsPayload(value.payload, entityId),
  };
}

export function validateSyncRequest(value: unknown): SyncRequestBody {
  const keys = ["schemaVersion", "cursor", "mutations"] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || value.schemaVersion !== 1) {
    throw new ApiError(400, "invalid_sync_request", "Sync request is invalid");
  }
  if (!Array.isArray(value.mutations) || value.mutations.length > MAX_MUTATIONS) {
    throw new ApiError(400, "invalid_sync_request", `At most ${MAX_MUTATIONS} mutations are allowed`);
  }
  const mutations = value.mutations.map(validateMutation);
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
    schemaVersion: 1,
    cursor: validateCursor(value.cursor),
    mutations,
  };
}
