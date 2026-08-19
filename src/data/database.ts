import Dexie, { type EntityTable } from "dexie";
import { MAX_AMOUNT_MINOR } from "../domain/amount";
import {
  currentLocalDateKey,
  currentLocalDateTimeInput,
  currentLocalMonthKey,
  localDateFromKey,
  parseLocalDateTime,
  resolveFollowingPaydayDateKey,
  resolveNextPaydayDateKey,
  resolvePayCycleRange,
} from "../domain/date";
import {
  assertRecoveryAllocationValid,
  defaultTreatmentFromAmount,
  normalizeLedgerEntry,
} from "../domain/entry-treatment";
import {
  calculateLedgerSummary,
  calculateRetainedSavingsSummary,
} from "../domain/stats";
import type {
  AppSettings,
  Attachment,
  ConfirmationStatus,
  EntryDraft,
  EntryTreatment,
  IncomeForecast,
  LedgerEntry,
  LedgerSummary,
  PayCyclePlan,
  ProcessedImage,
  RecoveryAllocation,
  SavingsEvent,
  SavingsEventKind,
  SavingsGoal,
} from "../domain/types";
import { MAX_NOTE_LENGTH, validateEntryDraft } from "../domain/validation";
import { createId } from "../lib/id";
import {
  SYNC_SCHEMA_VERSION,
  type IncomeConfirmationSyncPayload,
  type SessionResponse,
  type SyncProtocolVersion,
  type SyncChange,
  type SyncEntityType,
  type SyncResult,
} from "../sync/contracts";

export const DATABASE_NAME = "jiyibi";
export const DATABASE_SCHEMA_VERSION = 1 as const;
/** v3: cloud sync. v4: entry treatment/recovery. v5: retained savings. v6: savings goal. */
export const INDEXED_DB_VERSION = 6 as const;
export const INDEXED_DB_SYNC_VERSION = 3 as const;

const SYNC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type EntitySyncStatus = "clean" | "pending" | "conflict";
type SyncEntityPayload = LedgerEntry | AppSettings | RecoveryAllocation | SavingsEvent;

export interface SyncState {
  id: "primary";
  accountId: string;
  accountEmail: string;
  generation: number;
  cursor: string;
  syncProtocolVersion?: SyncProtocolVersion;
  syncProtocolRefreshPending?: true;
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
  /** Stable primary key used to coalesce edits for one entity or operation. */
  entityKey: string;
  /** Idempotency key sent to the server; replaced whenever the payload changes. */
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  baseVersion: number;
  payload: SyncEntityPayload;
  clearMonthEndBalanceGoal?: true;
  clearPayCycle?: true;
  clearIncomeForecast?: true;
  clearSavingsTargetOverride?: true;
  clearSavingsGoal?: true;
  clearLastExpectedIncomeMinor?: true;
  clearSavingsGoalNeedsSetup?: true;
  incomeConfirmation?: IncomeConfirmationSyncPayload;
  /** Settings mutation already represented by this confirmation snapshot. */
  absorbedSettingsMutationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncConflict {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  localPayload: SyncEntityPayload;
  remotePayload: SyncEntityPayload;
  remoteVersion: number;
  claimLegacyIncomeForecast?: true;
  claimLegacySavingsTarget?: true;
  /** Local operation that produced this entity conflict. */
  operationKey?: string;
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

interface LegacyPayCyclePlan extends PayCyclePlan {
  monthlySalaryMinor: number;
}

type LegacyAppSettings = Omit<AppSettings, "payCycle" | "incomeForecast"> & {
  payCycle?: PayCyclePlan | LegacyPayCyclePlan;
  incomeForecast?: IncomeForecast;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyPayCyclePlan(value: unknown): value is LegacyPayCyclePlan {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "monthlySalaryMinor");
}

/** Normalizes settings written by the v2 database or the v1 backup payload. */
export function migrateLegacyIncomeSettings(
  settings: AppSettings | LegacyAppSettings,
  now = new Date(),
): AppSettings {
  const next = structuredClone(settings) as LegacyAppSettings;
  if (!isLegacyPayCyclePlan(next.payCycle)) return next as AppSettings;

  const legacyPayCycle = next.payCycle;
  next.payCycle = {
    paydayDay: legacyPayCycle.paydayDay,
    cycleEndBalanceGoalMinor: legacyPayCycle.cycleEndBalanceGoalMinor,
  };
  if (
    next.incomeForecast === undefined &&
    Number.isInteger(legacyPayCycle.paydayDay) &&
    legacyPayCycle.paydayDay >= 1 &&
    legacyPayCycle.paydayDay <= 31 &&
    Number.isSafeInteger(legacyPayCycle.monthlySalaryMinor) &&
    legacyPayCycle.monthlySalaryMinor > 0 &&
    legacyPayCycle.monthlySalaryMinor <= MAX_AMOUNT_MINOR
  ) {
    const targetPaydayDateKey = resolveNextPaydayDateKey(legacyPayCycle.paydayDay, now);
    next.incomeForecast = {
      id: `legacy-income-${targetPaydayDateKey}`,
      targetPaydayDateKey,
      minimumIncomeMinor: 0,
      expectedIncomeMinor: legacyPayCycle.monthlySalaryMinor,
    };
  }
  return next as AppSettings;
}

/** Converts the old absolute balance floor into the v5 per-cycle savings target. */
export function migrateLegacySavingsSettings(
  settings: AppSettings | LegacyAppSettings,
  now = new Date(),
): AppSettings {
  const next = structuredClone(
    migrateLegacyIncomeSettings(settings, now),
  ) as AppSettings;
  const plan = next.payCycle;
  if (plan) {
    const legacyTarget = plan.cycleEndBalanceGoalMinor;
    const canonicalTarget = plan.defaultSavingsTargetMinor;
    const targetMinor = Number.isSafeInteger(canonicalTarget) &&
      canonicalTarget! >= 0 && canonicalTarget! <= MAX_AMOUNT_MINOR
      ? canonicalTarget!
      : Number.isSafeInteger(legacyTarget) && Math.abs(legacyTarget!) <= MAX_AMOUNT_MINOR
        ? Math.max(legacyTarget!, 0)
        : 0;
    next.payCycle = {
      paydayDay: plan.paydayDay,
      defaultSavingsTargetMinor: targetMinor,
    };
    if (Number.isSafeInteger(legacyTarget) && legacyTarget! < 0) {
      next.savingsTargetNeedsReview = true;
    }
  }

  if (!next.savingsTargetOverride && next.cycleSavingsTargetOverride) {
    next.savingsTargetOverride = structuredClone(next.cycleSavingsTargetOverride);
  }
  delete next.cycleSavingsTargetOverride;
  return next;
}

/** Canonicalize v5 settings into the cumulative-goal v6 model. */
export function migrateSavingsGoalSettings(
  settings: AppSettings | LegacyAppSettings,
  now = new Date(),
): AppSettings {
  const source = settings as AppSettings;
  const sourceCycleTarget = source.payCycle?.defaultSavingsTargetMinor
    ?? source.payCycle?.cycleEndBalanceGoalMinor;
  const sourceOverrideTarget = source.savingsTargetOverride?.targetMinor
    ?? source.cycleSavingsTargetOverride?.targetMinor;
  const next = structuredClone(
    migrateLegacySavingsSettings(settings, now),
  ) as AppSettings;
  const legacyPlan = next.payCycle;
  const legacyDefaultTarget = legacyPlan?.defaultSavingsTargetMinor
    ?? legacyPlan?.cycleEndBalanceGoalMinor
    ?? 0;
  const legacyOverrideTarget = next.savingsTargetOverride?.targetMinor
    ?? next.cycleSavingsTargetOverride?.targetMinor
    ?? 0;

  if (legacyPlan) {
    next.payCycle = { paydayDay: legacyPlan.paydayDay };
  }
  if (next.incomeForecast) {
    const forecast = next.incomeForecast;
    next.incomeForecast = {
      id: forecast.id,
      targetPaydayDateKey: forecast.targetPaydayDateKey,
      expectedIncomeMinor: forecast.expectedIncomeMinor,
    };
    if (
      next.lastExpectedIncomeMinor === undefined &&
      Number.isSafeInteger(forecast.expectedIncomeMinor) &&
      forecast.expectedIncomeMinor >= 0 &&
      forecast.expectedIncomeMinor <= MAX_AMOUNT_MINOR
    ) {
      next.lastExpectedIncomeMinor = forecast.expectedIncomeMinor;
    }
  }
  delete next.savingsTargetOverride;
  delete next.cycleSavingsTargetOverride;
  delete next.savingsTargetNeedsReview;
  if (
    (sourceCycleTarget !== undefined && sourceCycleTarget !== 0) ||
    (sourceOverrideTarget !== undefined && sourceOverrideTarget !== 0) ||
    legacyDefaultTarget > 0 || legacyOverrideTarget > 0
  ) {
    next.savingsGoalNeedsSetup = true;
  }
  return next;
}

export class LedgerDatabase extends Dexie {
  entries!: EntityTable<LedgerEntry, "id">;
  attachments!: EntityTable<Attachment, "id">;
  settings!: EntityTable<AppSettings, "id">;
  recoveryAllocations!: EntityTable<RecoveryAllocation, "id">;
  savingsEvents!: EntityTable<SavingsEvent, "id">;
  syncState!: EntityTable<SyncState, "id">;
  entitySyncState!: EntityTable<EntitySyncState, "id">;
  syncOutbox!: EntityTable<SyncOutboxRecord, "entityKey">;
  syncConflicts!: EntityTable<SyncConflict, "id">;

  constructor(name = DATABASE_NAME, migrationNow?: Date) {
    super(name);
    this.version(DATABASE_SCHEMA_VERSION).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt",
      attachments: "id, entryId, createdAt",
      settings: "id",
    });
    this.version(INDEXED_DB_SYNC_VERSION).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt",
      attachments: "id, entryId, createdAt",
      settings: "id",
      syncState: "id, accountId",
      entitySyncState: "id, [entityType+entityId], status",
      syncOutbox: "entityKey, &id, [entityType+entityId], createdAt",
      syncConflicts: "id, [entityType+entityId], createdAt",
    }).upgrade(async (transaction) => {
      const now = migrationNow ? new Date(migrationNow) : new Date();
      const settingsTable = transaction.table("settings");
      for (const settings of await settingsTable.toArray() as LegacyAppSettings[]) {
        await settingsTable.put(migrateLegacyIncomeSettings(settings, now));
      }

      const outboxTable = transaction.table("syncOutbox");
      for (const record of await outboxTable.toArray() as SyncOutboxRecord[]) {
        if (record.entityType !== "settings") continue;
        await outboxTable.put({
          ...record,
          payload: migrateLegacyIncomeSettings(
            record.payload as AppSettings | LegacyAppSettings,
            now,
          ),
          ...(record.clearPayCycle ? { clearIncomeForecast: true as const } : {}),
        });
      }

      const conflictsTable = transaction.table("syncConflicts");
      for (const conflict of await conflictsTable.toArray() as SyncConflict[]) {
        if (conflict.entityType !== "settings") continue;
        await conflictsTable.put({
          ...conflict,
          localPayload: migrateLegacyIncomeSettings(
            conflict.localPayload as AppSettings | LegacyAppSettings,
            now,
          ),
          remotePayload: migrateLegacyIncomeSettings(
            conflict.remotePayload as AppSettings | LegacyAppSettings,
            now,
          ),
        });
      }
    });
    this.version(4).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt, treatment, confirmationStatus",
      attachments: "id, entryId, createdAt",
      settings: "id",
      recoveryAllocations: "id, refundEntryId, expenseEntryId, deletedAt, createdAt",
      syncState: "id, accountId",
      entitySyncState: "id, [entityType+entityId], status",
      syncOutbox: "entityKey, &id, [entityType+entityId], createdAt",
      syncConflicts: "id, [entityType+entityId], createdAt",
    }).upgrade(async (transaction) => {
      const entriesTable = transaction.table("entries");
      for (const raw of await entriesTable.toArray()) {
        await entriesTable.put(normalizeLedgerEntry(raw as LedgerEntry));
      }

      const outboxTable = transaction.table("syncOutbox");
      for (const record of await outboxTable.toArray() as SyncOutboxRecord[]) {
        if (record.entityType !== "entry") continue;
        await outboxTable.put({
          ...record,
          payload: normalizeLedgerEntry(record.payload as LedgerEntry),
        });
      }

      const conflictsTable = transaction.table("syncConflicts");
      for (const conflict of await conflictsTable.toArray() as SyncConflict[]) {
        if (conflict.entityType !== "entry") continue;
        await conflictsTable.put({
          ...conflict,
          localPayload: normalizeLedgerEntry(conflict.localPayload as LedgerEntry),
          remotePayload: normalizeLedgerEntry(conflict.remotePayload as LedgerEntry),
        });
      }
    });
    this.version(5).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt, treatment, confirmationStatus",
      attachments: "id, entryId, createdAt",
      settings: "id",
      recoveryAllocations: "id, refundEntryId, expenseEntryId, deletedAt, createdAt",
      savingsEvents: "id, kind, occurredAt, localDateKey, localMonthKey, deletedAt, linkedExpenseEntryId, cycleStartDateKey, &[kind+cycleStartDateKey]",
      syncState: "id, accountId",
      entitySyncState: "id, [entityType+entityId], status",
      syncOutbox: "entityKey, &id, [entityType+entityId], createdAt",
      syncConflicts: "id, [entityType+entityId], createdAt",
    }).upgrade(async (transaction) => {
      const now = migrationNow ? new Date(migrationNow) : new Date();
      const settingsTable = transaction.table("settings");
      for (const settings of await settingsTable.toArray() as LegacyAppSettings[]) {
        await settingsTable.put(migrateLegacySavingsSettings(settings, now));
      }

      const outboxTable = transaction.table("syncOutbox");
      for (const record of await outboxTable.toArray() as SyncOutboxRecord[]) {
        if (record.entityType !== "settings") continue;
        await outboxTable.put({
          ...record,
          payload: syncPayloadFor(
            "settings",
            migrateLegacySavingsSettings(
              record.payload as AppSettings | LegacyAppSettings,
              now,
            ),
          ),
        });
      }

      const conflictsTable = transaction.table("syncConflicts");
      for (const conflict of await conflictsTable.toArray() as SyncConflict[]) {
        if (conflict.entityType !== "settings") continue;
        await conflictsTable.put({
          ...conflict,
          localPayload: migrateLegacySavingsSettings(
            conflict.localPayload as AppSettings | LegacyAppSettings,
            now,
          ),
          remotePayload: migrateLegacySavingsSettings(
            conflict.remotePayload as AppSettings | LegacyAppSettings,
            now,
          ),
        });
      }
    });
    this.version(INDEXED_DB_VERSION).stores({
      entries: "id, occurredAt, localDateKey, localMonthKey, deletedAt, createdAt, treatment, confirmationStatus",
      attachments: "id, entryId, createdAt",
      settings: "id",
      recoveryAllocations: "id, refundEntryId, expenseEntryId, deletedAt, createdAt",
      savingsEvents: "id, kind, occurredAt, localDateKey, localMonthKey, deletedAt, linkedExpenseEntryId, cycleStartDateKey, &[kind+cycleStartDateKey]",
      syncState: "id, accountId",
      entitySyncState: "id, [entityType+entityId], status",
      syncOutbox: "entityKey, &id, [entityType+entityId], createdAt",
      syncConflicts: "id, [entityType+entityId], createdAt",
    }).upgrade(async (transaction) => {
      const now = migrationNow ? new Date(migrationNow) : new Date();
      const settingsTable = transaction.table("settings");
      for (const settings of await settingsTable.toArray() as LegacyAppSettings[]) {
        await settingsTable.put(migrateSavingsGoalSettings(settings, now));
      }

      const outboxTable = transaction.table("syncOutbox");
      for (const record of await outboxTable.toArray() as SyncOutboxRecord[]) {
        if (record.entityType !== "settings") continue;
        await outboxTable.put({
          ...record,
          payload: syncPayloadFor(
            "settings",
            migrateSavingsGoalSettings(
              record.payload as AppSettings | LegacyAppSettings,
              now,
            ),
          ),
        });
      }

      const conflictsTable = transaction.table("syncConflicts");
      for (const conflict of await conflictsTable.toArray() as SyncConflict[]) {
        if (conflict.entityType !== "settings") continue;
        await conflictsTable.put({
          ...conflict,
          localPayload: migrateSavingsGoalSettings(
            conflict.localPayload as AppSettings | LegacyAppSettings,
            now,
          ),
          remotePayload: migrateSavingsGoalSettings(
            conflict.remotePayload as AppSettings | LegacyAppSettings,
            now,
          ),
        });
      }
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

function incomeConfirmationSyncKey(forecastId: string): string {
  return `incomeConfirmation:${forecastId}`;
}

function isIncomeConfirmationOutbox(
  record: SyncOutboxRecord,
): record is SyncOutboxRecord & { incomeConfirmation: IncomeConfirmationSyncPayload } {
  return record.entityType === "settings" && record.incomeConfirmation !== undefined;
}

function isDefaultSettings(settings: AppSettings): boolean {
  return (
    settings.id === "primary" &&
    settings.currency === "CNY" &&
    settings.schemaVersion === DATABASE_SCHEMA_VERSION &&
    settings.initialBalanceMinor === 0 &&
    settings.monthEndBalanceGoalMinor === undefined &&
    settings.payCycle === undefined &&
    settings.savingsGoal === undefined &&
    settings.lastExpectedIncomeMinor === undefined &&
    settings.savingsGoalNeedsSetup === undefined &&
    settings.savingsTargetOverride === undefined &&
    settings.savingsTargetNeedsReview === undefined &&
    settings.incomeForecast === undefined
  );
}

function syncPayloadFor(
  entityType: SyncEntityType,
  payload: SyncEntityPayload,
): SyncEntityPayload {
  if (entityType === "entry") {
    const entry = structuredClone(normalizeLedgerEntry(payload as LedgerEntry));
    if (entry.deletedAt) delete entry.attachmentId;
    return entry;
  }
  if (entityType === "settings") {
    const settings = structuredClone(payload as AppSettings);
    delete settings.savingsTargetNeedsReview;
    delete settings.cycleSavingsTargetOverride;
    return settings;
  }
  return structuredClone(payload);
}

function treatmentMatchesAmountSafe(
  treatment: EntryTreatment | undefined,
  amountMinor: number,
): boolean {
  if (!treatment) return false;
  if (treatment === "account_transfer") return amountMinor !== 0;
  if (
    treatment === "ordinary_expense"
    || treatment === "one_time_expense"
    || treatment === "reimbursable_expense"
  ) {
    return amountMinor < 0;
  }
  return amountMinor > 0;
}

export async function updateEntryTreatment(
  entryId: string,
  treatment: EntryTreatment,
  options: {
    confirmationStatus?: ConfirmationStatus;
    detectionRuleVersion?: number;
    markPrompted?: boolean;
  } = {},
  database = ledgerDb,
  now = new Date(),
): Promise<LedgerEntry> {
  return database.transaction(
    "rw",
    [
      database.entries,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const existing = await database.entries.get(entryId);
      if (!existing) throw new LedgerDataError("找不到这条记录", "not-found");
      if (existing.deletedAt) throw new LedgerDataError("已删除的记录不能编辑", "already-deleted");
      if (!treatmentMatchesAmountSafe(treatment, existing.amountMinor)) {
        throw new LedgerDataError("处理方式与金额方向不一致", "invalid-settings");
      }
      const nowIso = now.toISOString();
      const updated: LedgerEntry = {
        ...normalizeLedgerEntry(existing),
        treatment,
        confirmationStatus: options.confirmationStatus ?? "confirmed",
        detectionRuleVersion: options.detectionRuleVersion ?? existing.detectionRuleVersion,
        promptedRevision: options.markPrompted ? nowIso : existing.promptedRevision,
        updatedAt: nowIso,
      };
      await database.entries.put(updated);
      await queueSyncMutation("entry", updated.id, updated, database, nowIso);
      return updated;
    },
  );
}

export async function listRecoveryAllocations(
  database = ledgerDb,
): Promise<RecoveryAllocation[]> {
  return database.recoveryAllocations.toArray();
}

export async function listActiveRecoveryAllocations(
  database = ledgerDb,
): Promise<RecoveryAllocation[]> {
  const rows = await database.recoveryAllocations.toArray();
  return rows.filter((row) => !row.deletedAt);
}

export async function upsertRecoveryAllocation(
  input: {
    id?: string;
    refundEntryId: string;
    expenseEntryId: string;
    amountMinor: number;
  },
  database = ledgerDb,
  now = new Date(),
): Promise<RecoveryAllocation> {
  return database.transaction(
    "rw",
    [
      database.entries,
      database.recoveryAllocations,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const refund = await database.entries.get(input.refundEntryId);
      const expense = await database.entries.get(input.expenseEntryId);
      if (!refund || !expense) {
        throw new LedgerDataError("找不到关联的账目", "not-found");
      }
      const existing = await database.recoveryAllocations.toArray();
      assertRecoveryAllocationValid(input.amountMinor, {
        refund: normalizeLedgerEntry(refund),
        expense: normalizeLedgerEntry(expense),
        existing,
        ignoreAllocationId: input.id,
      });
      const nowIso = now.toISOString();
      const previous = input.id
        ? await database.recoveryAllocations.get(input.id)
        : undefined;
      const row: RecoveryAllocation = {
        id: input.id ?? createId("recovery"),
        refundEntryId: input.refundEntryId,
        expenseEntryId: input.expenseEntryId,
        amountMinor: input.amountMinor,
        createdAt: previous?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
      await database.recoveryAllocations.put(row);
      await queueSyncMutation(
        "recoveryAllocation",
        row.id,
        row,
        database,
        nowIso,
      );
      return row;
    },
  );
}

export async function softDeleteRecoveryAllocation(
  allocationId: string,
  database = ledgerDb,
  now = new Date(),
): Promise<RecoveryAllocation | undefined> {
  return database.transaction(
    "rw",
    [
      database.recoveryAllocations,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const existing = await database.recoveryAllocations.get(allocationId);
      if (!existing || existing.deletedAt) return existing;
      const nowIso = now.toISOString();
      const deleted: RecoveryAllocation = {
        ...existing,
        deletedAt: nowIso,
        updatedAt: nowIso,
      };
      await database.recoveryAllocations.put(deleted);
      await queueSyncMutation(
        "recoveryAllocation",
        deleted.id,
        deleted,
        database,
        nowIso,
      );
      return deleted;
    },
  );
}

export async function purgeRecoveryAllocationsForEntry(
  entryId: string,
  database: LedgerDatabase,
): Promise<void> {
  const related = await database.recoveryAllocations
    .filter((row) => row.refundEntryId === entryId || row.expenseEntryId === entryId)
    .toArray();
  await Promise.all(related.map((row) => database.recoveryAllocations.delete(row.id)));
}

async function queueSyncMutation(
  entityType: SyncEntityType,
  entityId: string,
  payload: SyncEntityPayload,
  database: LedgerDatabase,
  nowIso: string,
  options: {
    clearMonthEndBalanceGoal?: boolean;
    clearPayCycle?: boolean;
    clearIncomeForecast?: boolean;
    clearSavingsTargetOverride?: boolean;
    clearSavingsGoal?: boolean;
    clearLastExpectedIncomeMinor?: boolean;
    clearSavingsGoalNeedsSetup?: boolean;
  } = {},
): Promise<SyncOutboxRecord | undefined> {
  const link = await database.syncState.get("primary");
  if (!link?.uploadApproved) return undefined;

  const entityKey = syncEntityKey(entityType, entityId);
  const [existing, entityState, conflict] = await Promise.all([
    database.syncOutbox.get(entityKey),
    database.entitySyncState.get(entityKey),
    database.syncConflicts.get(entityKey),
  ]);
  const clearsMonthEndBalanceGoal = entityType === "settings" &&
    !Object.prototype.hasOwnProperty.call(payload, "monthEndBalanceGoalMinor") &&
    (options.clearMonthEndBalanceGoal || existing?.clearMonthEndBalanceGoal);
  const clearsPayCycle = entityType === "settings" &&
    !Object.prototype.hasOwnProperty.call(payload, "payCycle") &&
    (options.clearPayCycle || existing?.clearPayCycle);
  const clearsIncomeForecast = entityType === "settings" &&
    !Object.prototype.hasOwnProperty.call(payload, "incomeForecast") &&
    (options.clearIncomeForecast || existing?.clearIncomeForecast);
  const clearsSavingsTargetOverride = entityType === "settings" &&
    !Object.prototype.hasOwnProperty.call(payload, "savingsTargetOverride") &&
    (options.clearSavingsTargetOverride || existing?.clearSavingsTargetOverride);
  const clearsSavingsGoal = entityType === "settings" &&
    !Object.prototype.hasOwnProperty.call(payload, "savingsGoal") &&
    (options.clearSavingsGoal || existing?.clearSavingsGoal);
  const clearsLastExpectedIncomeMinor = entityType === "settings" &&
    !Object.prototype.hasOwnProperty.call(payload, "lastExpectedIncomeMinor") &&
    (options.clearLastExpectedIncomeMinor || existing?.clearLastExpectedIncomeMinor);
  const clearsSavingsGoalNeedsSetup = entityType === "settings" &&
    !Object.prototype.hasOwnProperty.call(payload, "savingsGoalNeedsSetup") &&
    (options.clearSavingsGoalNeedsSetup || existing?.clearSavingsGoalNeedsSetup);
  const outbox: SyncOutboxRecord = {
    entityKey,
    id: createId("mutation"),
    entityType,
    entityId,
    baseVersion: existing?.baseVersion ?? entityState?.serverVersion ?? 0,
    payload: syncPayloadFor(entityType, payload),
    ...(clearsMonthEndBalanceGoal ? { clearMonthEndBalanceGoal: true } : {}),
    ...(clearsPayCycle ? { clearPayCycle: true } : {}),
    ...(clearsIncomeForecast ? { clearIncomeForecast: true } : {}),
    ...(clearsSavingsTargetOverride ? { clearSavingsTargetOverride: true } : {}),
    ...(clearsSavingsGoal ? { clearSavingsGoal: true } : {}),
    ...(clearsLastExpectedIncomeMinor ? { clearLastExpectedIncomeMinor: true } : {}),
    ...(clearsSavingsGoalNeedsSetup ? { clearSavingsGoalNeedsSetup: true } : {}),
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

async function queueIncomeConfirmationMutation(
  settings: AppSettings,
  confirmation: IncomeConfirmationSyncPayload,
  absorbedSettingsMutationId: string | undefined,
  database: LedgerDatabase,
  nowIso: string,
): Promise<SyncOutboxRecord | undefined> {
  const link = await database.syncState.get("primary");
  if (!link) return undefined;

  const entityKey = incomeConfirmationSyncKey(confirmation.forecastId);
  const existing = await database.syncOutbox.get(entityKey);
  if (existing?.incomeConfirmation) {
    if (
      existing.incomeConfirmation.actualIncomeMinor !== confirmation.actualIncomeMinor ||
      existing.incomeConfirmation.expectedIncomeMinor !== confirmation.expectedIncomeMinor ||
      existing.incomeConfirmation.targetPaydayDateKey !== confirmation.targetPaydayDateKey
    ) {
      throw new LedgerDataError(
        "This income forecast already has a different pending confirmation",
        "sync-conflict",
      );
    }
    return existing;
  }

  const settingsKey = syncEntityKey("settings", settings.id);
  const [pendingSettings, entityState] = await Promise.all([
    database.syncOutbox.get(settingsKey),
    database.entitySyncState.get(settingsKey),
  ]);
  const outbox: SyncOutboxRecord = {
    entityKey,
    id: createId("mutation"),
    entityType: "settings",
    entityId: settings.id,
    baseVersion: pendingSettings?.baseVersion ?? entityState?.serverVersion ?? 0,
    payload: syncPayloadFor("settings", settings),
    clearIncomeForecast: true,
    clearSavingsTargetOverride: true,
    incomeConfirmation: structuredClone(confirmation),
    ...(absorbedSettingsMutationId ? { absorbedSettingsMutationId } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await database.syncOutbox.put(outbox);
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
      database.recoveryAllocations,
      database.savingsEvents,
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
        ...(!existing ? { syncProtocolVersion: SYNC_SCHEMA_VERSION } : {}),
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
        const allocations = await database.recoveryAllocations
          .filter((allocation) => !allocation.deletedAt)
          .toArray();
        for (const allocation of allocations) {
          await queueSyncMutation(
            "recoveryAllocation",
            allocation.id,
            allocation,
            database,
            nowIso,
          );
        }
        const savingsEvents = await database.savingsEvents
          .filter((event) => !event.deletedAt)
          .toArray();
        for (const event of savingsEvents) {
          await queueSyncMutation(
            "savingsEvent",
            event.id,
            event,
            database,
            nowIso,
          );
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

export async function setMonthEndBalanceGoal(
  monthEndBalanceGoalMinor: number | undefined,
  database = ledgerDb,
  now = new Date(),
): Promise<AppSettings> {
  if (
    monthEndBalanceGoalMinor !== undefined &&
    (!Number.isSafeInteger(monthEndBalanceGoalMinor) ||
      Math.abs(monthEndBalanceGoalMinor) > MAX_AMOUNT_MINOR)
  ) {
    throw new LedgerDataError("月末余额底线必须是有效的整数分", "invalid-settings");
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
      const current = (await database.settings.get("primary")) ?? createDefaultSettings(now);
      const next: AppSettings = {
        ...current,
        updatedAt: nowIso,
      };
      if (monthEndBalanceGoalMinor === undefined) {
        delete next.monthEndBalanceGoalMinor;
      } else {
        next.monthEndBalanceGoalMinor = monthEndBalanceGoalMinor;
      }
      await database.settings.put(next);
      await queueSyncMutation("settings", next.id, next, database, nowIso, {
        clearMonthEndBalanceGoal: monthEndBalanceGoalMinor === undefined,
      });
      return next;
    },
  );
}

export async function setPayCyclePlan(
  payCycle: PayCyclePlan | undefined,
  database = ledgerDb,
  now = new Date(),
): Promise<AppSettings> {
  if (
    payCycle !== undefined &&
    (
      !Number.isInteger(payCycle.paydayDay) ||
      payCycle.paydayDay < 1 ||
      payCycle.paydayDay > 31
    )
  ) {
    throw new LedgerDataError("工资周期设置无效", "invalid-settings");
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
      const current = (await database.settings.get("primary")) ?? createDefaultSettings(now);
      const next: AppSettings = {
        ...current,
        updatedAt: nowIso,
      };
      delete next.monthEndBalanceGoalMinor;
      if (payCycle === undefined) {
        delete next.payCycle;
        delete next.incomeForecast;
      } else {
        next.payCycle = {
          paydayDay: payCycle.paydayDay,
        };
      }
      delete next.savingsTargetOverride;
      delete next.cycleSavingsTargetOverride;
      delete next.savingsTargetNeedsReview;
      await database.settings.put(next);
      await queueSyncMutation("settings", next.id, next, database, nowIso, {
        clearMonthEndBalanceGoal: true,
        clearPayCycle: payCycle === undefined,
        clearIncomeForecast: payCycle === undefined,
        clearSavingsTargetOverride: true,
      });
      return next;
    },
  );
}

function assertSavingsGoal(goal: SavingsGoal): void {
  try {
    localDateFromKey(goal.targetDateKey);
  } catch {
    throw new LedgerDataError("存钱目标日期无效", "invalid-settings");
  }
  if (
    !Number.isSafeInteger(goal.targetMinor) ||
    goal.targetMinor <= 0 ||
    goal.targetMinor > MAX_AMOUNT_MINOR
  ) {
    throw new LedgerDataError("存钱目标金额无效", "invalid-settings");
  }
}

export async function setSavingsGoal(
  goal: SavingsGoal,
  database = ledgerDb,
  now = new Date(),
): Promise<AppSettings> {
  assertSavingsGoal(goal);
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
        savingsGoal: structuredClone(goal),
        updatedAt: nowIso,
      };
      delete next.savingsGoalNeedsSetup;
      await database.settings.put(next);
      await queueSyncMutation("settings", next.id, next, database, nowIso, {
        clearSavingsGoalNeedsSetup: true,
      });
      return next;
    },
  );
}

export async function clearSavingsGoal(
  database = ledgerDb,
  now = new Date(),
): Promise<AppSettings> {
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
        updatedAt: nowIso,
      };
      delete next.savingsGoal;
      delete next.savingsGoalNeedsSetup;
      await database.settings.put(next);
      await queueSyncMutation("settings", next.id, next, database, nowIso, {
        clearSavingsGoal: true,
        clearSavingsGoalNeedsSetup: true,
      });
      return next;
    },
  );
}

export async function acknowledgeSavingsGoalSetup(
  database = ledgerDb,
  now = new Date(),
): Promise<AppSettings> {
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
        updatedAt: nowIso,
      };
      delete next.savingsGoalNeedsSetup;
      await database.settings.put(next);
      await queueSyncMutation("settings", next.id, next, database, nowIso, {
        clearSavingsGoalNeedsSetup: true,
      });
      return next;
    },
  );
}

export interface IncomeForecastInput {
  id?: string;
  targetPaydayDateKey: string;
  expectedIncomeMinor: number;
  /** @deprecated Ignored by v6; accepted only while old callers upgrade. */
  minimumIncomeMinor?: number;
}

function isValidIncomeForecastInput(value: IncomeForecastInput): boolean {
  let hasValidTargetDate = false;
  if (
    typeof value.targetPaydayDateKey === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.targetPaydayDateKey)
  ) {
    try {
      localDateFromKey(value.targetPaydayDateKey);
      hasValidTargetDate = true;
    } catch {
      // Keep malformed or impossible calendar dates in the normal settings error path.
    }
  }

  return (
    (value.id === undefined || (
      typeof value.id === "string" &&
      SYNC_ID_PATTERN.test(value.id)
    )) &&
    hasValidTargetDate &&
    Number.isSafeInteger(value.expectedIncomeMinor) &&
    value.expectedIncomeMinor >= 0 &&
    value.expectedIncomeMinor <= MAX_AMOUNT_MINOR
  );
}

export async function setSavingsTargetOverride(
  targetMinor: number | undefined,
  database = ledgerDb,
  now = new Date(),
  targetPaydayDateKey?: string,
): Promise<AppSettings> {
  void targetMinor;
  void database;
  void now;
  void targetPaydayDateKey;
  throw new LedgerDataError(
    "本周期留存目标已停用，请改用存钱目标",
    "invalid-settings",
  );
}

export async function acknowledgeSavingsTargetReview(
  database = ledgerDb,
  now = new Date(),
): Promise<AppSettings> {
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
        updatedAt: nowIso,
      };
      delete next.savingsTargetNeedsReview;
      await database.settings.put(next);
      await queueSyncMutation("settings", next.id, next, database, nowIso);
      return next;
    },
  );
}

function isIncomeForecastTargetInWindow(
  targetDateKey: string,
  paydayDay: number,
  existingForecast: IncomeForecast | undefined,
  now: Date,
): boolean {
  const todayDateKey = currentLocalDateKey(now);
  if (existingForecast) {
    const window = resolvePayCycleRange(
      paydayDay,
      localDateFromKey(existingForecast.targetPaydayDateKey),
    );
    return (
      targetDateKey >= todayDateKey &&
      targetDateKey >= window.cycleStartDateKey &&
      targetDateKey < window.nextPaydayDateKey
    );
  }

  const latestWindow = resolvePayCycleRange(
    paydayDay,
    localDateFromKey(resolveFollowingPaydayDateKey(paydayDay, now)),
  );

  return (
    targetDateKey >= todayDateKey &&
    targetDateKey < latestWindow.nextPaydayDateKey
  );
}

export async function setIncomeForecast(
  incomeForecast: IncomeForecastInput,
  database = ledgerDb,
  now = new Date(),
): Promise<AppSettings> {
  if (!isValidIncomeForecastInput(incomeForecast)) {
    throw new LedgerDataError("收入预期设置无效", "invalid-settings");
  }
  return database.transaction(
    "rw",
    database.settings,
    database.syncState,
    database.entitySyncState,
    database.syncOutbox,
    database.syncConflicts,
    async () => {
      const current = (await database.settings.get("primary")) ?? createDefaultSettings(now);
      if (
        !current.payCycle ||
        !isIncomeForecastTargetInWindow(
          incomeForecast.targetPaydayDateKey,
          current.payCycle.paydayDay,
          current.incomeForecast,
          now,
        )
      ) {
        throw new LedgerDataError(
          "收入预期日期必须在对应发薪周期内，且不能早于今天",
          "invalid-settings",
        );
      }
      const nowIso = now.toISOString();
      const next: AppSettings = {
        ...current,
        incomeForecast: {
          id: current.incomeForecast?.id ?? incomeForecast.id ?? createId("income-forecast"),
          targetPaydayDateKey: incomeForecast.targetPaydayDateKey,
          expectedIncomeMinor: incomeForecast.expectedIncomeMinor,
        },
        lastExpectedIncomeMinor: incomeForecast.expectedIncomeMinor,
        updatedAt: nowIso,
      };
      await database.settings.put(next);
      await queueSyncMutation("settings", next.id, next, database, nowIso);
      return next;
    },
  );
}

export async function clearIncomeForecast(
  database = ledgerDb,
  now = new Date(),
): Promise<AppSettings> {
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
        updatedAt: nowIso,
      };
      delete next.incomeForecast;
      await database.settings.put(next);
      await queueSyncMutation("settings", next.id, next, database, nowIso, {
        clearIncomeForecast: true,
      });
      return next;
    },
  );
}

export interface SavingsEventInput {
  id?: string;
  amountMinor: number;
  note?: string;
  occurredAtLocal?: string;
  linkedExpenseEntryId?: string;
}

export interface SavingsSettlementInput {
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  goalMinorSnapshot: number;
  amountMinor: number;
  note?: string;
  occurredAtLocal?: string;
}

export interface SavingsFundedExpenseResult {
  entry: LedgerEntry;
  savingsEvent: SavingsEvent;
}

const OPENING_SAVINGS_EVENT_ID = "savings-opening";

function settlementSavingsEventId(cycleStartDateKey: string): string {
  return `savings-settlement-${cycleStartDateKey}`;
}

function assertSavingsAmount(amountMinor: number, allowZero = false): void {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < (allowZero ? 0 : 1) ||
    amountMinor > MAX_AMOUNT_MINOR
  ) {
    throw new LedgerDataError("留存金额必须是有效的非负整数分", "invalid-settings");
  }
}

function normalizedSavingsNote(note: string | undefined): string {
  const normalized = note?.trim() ?? "";
  if (normalized.length > MAX_NOTE_LENGTH) {
    throw new LedgerDataError(`留存备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, "invalid-settings");
  }
  return normalized;
}

function savingsOccurrence(occurredAtLocal: string | undefined, now: Date) {
  try {
    const occurrence = parseLocalDateTime(
      occurredAtLocal ?? currentLocalDateTimeInput(now),
    );
    if (new Date(occurrence.occurredAt).getTime() > now.getTime()) {
      throw new Error("future savings event");
    }
    return occurrence;
  } catch {
    throw new LedgerDataError("留存时间无效", "invalid-settings");
  }
}

function safeSnapshotMinor(value: bigint, label: string): number {
  if (
    value < BigInt(Number.MIN_SAFE_INTEGER) ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new LedgerDataError(`${label}超出安全金额范围`, "invalid-settings");
  }
  return Number(value);
}

async function ledgerBalanceMinorInTransaction(
  database: LedgerDatabase,
): Promise<number> {
  const settings = (await database.settings.get("primary")) ?? createDefaultSettings();
  return calculateLedgerSummary(
    await database.entries.toArray(),
    settings,
    currentLocalMonthKey(),
  ).balanceMinor;
}

async function retainedMinorInTransaction(
  database: LedgerDatabase,
  ignoreEventId?: string,
): Promise<bigint> {
  const events = await database.savingsEvents.toArray();
  return calculateRetainedSavingsSummary(
    ignoreEventId ? events.filter((event) => event.id !== ignoreEventId) : events,
  ).totalRetainedMinor;
}

function assertSavingsFitsBalance(
  retainedMinor: bigint,
  balanceMinor: number,
): void {
  if (retainedMinor > BigInt(balanceMinor)) {
    throw new LedgerDataError("留存金额不能超过当前未留存资金", "invalid-settings");
  }
}

async function assertLinkedReleaseFitsExpense(
  database: LedgerDatabase,
  linkedExpenseEntryId: string,
  amountMinor: number,
  ignoreEventId?: string,
): Promise<void> {
  const [expense, linkedReleases] = await Promise.all([
    database.entries.get(linkedExpenseEntryId),
    database.savingsEvents
      .where("linkedExpenseEntryId")
      .equals(linkedExpenseEntryId)
      .filter((event) =>
        event.kind === "release"
        && !event.deletedAt
        && event.id !== ignoreEventId)
      .toArray(),
  ]);
  if (!expense || expense.deletedAt || expense.amountMinor >= 0) {
    throw new LedgerDataError("关联支出与取用金额不匹配", "invalid-settings");
  }

  let linkedTotalMinor = BigInt(amountMinor);
  for (const release of linkedReleases) {
    if (!Number.isSafeInteger(release.amountMinor) || release.amountMinor <= 0) {
      throw new LedgerDataError("关联的留存记录金额无效", "invalid-settings");
    }
    linkedTotalMinor += BigInt(release.amountMinor);
  }
  if (linkedTotalMinor > -BigInt(expense.amountMinor)) {
    throw new LedgerDataError("关联支出与取用金额不匹配", "invalid-settings");
  }
}

export async function listSavingsEvents(
  database = ledgerDb,
): Promise<SavingsEvent[]> {
  return database.savingsEvents.orderBy("occurredAt").reverse().toArray();
}

export async function listActiveSavingsEvents(
  database = ledgerDb,
): Promise<SavingsEvent[]> {
  const events = await listSavingsEvents(database);
  return events.filter((event) => !event.deletedAt);
}

export async function getSavingsEvent(
  eventId: string,
  database = ledgerDb,
): Promise<SavingsEvent | undefined> {
  return database.savingsEvents.get(eventId);
}

export async function setOpeningSavings(
  amountMinor: number,
  database = ledgerDb,
  now = new Date(),
  note = "初始留存",
): Promise<SavingsEvent | undefined> {
  assertSavingsAmount(amountMinor, true);
  const normalizedNote = normalizedSavingsNote(note);
  const occurrence = savingsOccurrence(undefined, now);
  return database.transaction(
    "rw",
    [
      database.entries,
      database.settings,
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const existing = await database.savingsEvents.get(OPENING_SAVINGS_EVENT_ID);
      const nowIso = now.toISOString();
      if (amountMinor === 0) {
        if (!existing || existing.deletedAt) return undefined;
        const deleted: SavingsEvent = {
          ...existing,
          deletedAt: nowIso,
          updatedAt: nowIso,
        };
        await database.savingsEvents.put(deleted);
        await queueSyncMutation("savingsEvent", deleted.id, deleted, database, nowIso);
        return deleted;
      }

      const retainedWithoutOpening = await retainedMinorInTransaction(
        database,
        OPENING_SAVINGS_EVENT_ID,
      );
      assertSavingsFitsBalance(
        retainedWithoutOpening + BigInt(amountMinor),
        await ledgerBalanceMinorInTransaction(database),
      );
      const event: SavingsEvent = {
        id: OPENING_SAVINGS_EVENT_ID,
        kind: "opening",
        amountMinor,
        note: normalizedNote,
        ...(existing
          ? {
            occurredAt: existing.occurredAt,
            localDateKey: existing.localDateKey,
            localMonthKey: existing.localMonthKey,
            timezoneOffsetMinutes: existing.timezoneOffsetMinutes,
          }
          : occurrence),
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
      await database.savingsEvents.put(event);
      await queueSyncMutation("savingsEvent", event.id, event, database, nowIso);
      return event;
    },
  );
}

/** Product-facing alias for the opening retained-money setting. */
export const setInitialSavings = setOpeningSavings;

export async function recordSavingsEvent(
  kind: Extract<SavingsEventKind, "reserve" | "release">,
  input: SavingsEventInput,
  database = ledgerDb,
  now = new Date(),
): Promise<SavingsEvent> {
  if (kind !== "reserve" && kind !== "release") {
    throw new LedgerDataError("留存事件类型无效", "invalid-settings");
  }
  assertSavingsAmount(input.amountMinor);
  if (input.id !== undefined && !SYNC_ID_PATTERN.test(input.id)) {
    throw new LedgerDataError("留存事件 ID 无效", "invalid-settings");
  }
  if (kind === "reserve" && input.linkedExpenseEntryId !== undefined) {
    throw new LedgerDataError("追加留存不能关联支出", "invalid-settings");
  }
  const occurrence = savingsOccurrence(input.occurredAtLocal, now);
  const note = normalizedSavingsNote(input.note);
  return database.transaction(
    "rw",
    [
      database.entries,
      database.settings,
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const retainedMinor = await retainedMinorInTransaction(database);
      if (kind === "reserve") {
        assertSavingsFitsBalance(
          retainedMinor + BigInt(input.amountMinor),
          await ledgerBalanceMinorInTransaction(database),
        );
      } else {
        if (BigInt(input.amountMinor) > retainedMinor) {
          throw new LedgerDataError("取用金额不能超过当前已留存金额", "invalid-settings");
        }
        if (input.linkedExpenseEntryId) {
          await assertLinkedReleaseFitsExpense(
            database,
            input.linkedExpenseEntryId,
            input.amountMinor,
          );
        }
      }
      const nowIso = now.toISOString();
      const event: SavingsEvent = {
        id: input.id ?? createId(`savings-${kind}`),
        kind,
        amountMinor: input.amountMinor,
        note,
        ...occurrence,
        ...(kind === "release" && input.linkedExpenseEntryId
          ? { linkedExpenseEntryId: input.linkedExpenseEntryId }
          : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await database.savingsEvents.add(event);
      await queueSyncMutation("savingsEvent", event.id, event, database, nowIso);
      return event;
    },
  );
}

export function reserveSavings(
  input: SavingsEventInput,
  database = ledgerDb,
  now = new Date(),
): Promise<SavingsEvent> {
  return recordSavingsEvent("reserve", input, database, now);
}

export function releaseSavings(
  input: SavingsEventInput,
  database = ledgerDb,
  now = new Date(),
): Promise<SavingsEvent> {
  return recordSavingsEvent("release", input, database, now);
}

export async function updateSavingsEvent(
  eventId: string,
  input: Omit<SavingsEventInput, "id">,
  database = ledgerDb,
  now = new Date(),
): Promise<SavingsEvent> {
  assertSavingsAmount(input.amountMinor);
  return database.transaction(
    "rw",
    [
      database.entries,
      database.settings,
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const existing = await database.savingsEvents.get(eventId);
      if (!existing) throw new LedgerDataError("找不到这条留存记录", "not-found");
      if (existing.deletedAt) {
        throw new LedgerDataError("已删除的留存记录不能编辑", "already-deleted");
      }
      if (existing.kind === "opening" || existing.kind === "cycle_settlement") {
        throw new LedgerDataError("请使用对应的初始留存或周期结算入口", "invalid-settings");
      }
      const occurrence = input.occurredAtLocal
        ? savingsOccurrence(input.occurredAtLocal, now)
        : {
          occurredAt: existing.occurredAt,
          localDateKey: existing.localDateKey,
          localMonthKey: existing.localMonthKey,
          timezoneOffsetMinutes: existing.timezoneOffsetMinutes,
        };
      const note = input.note === undefined
        ? existing.note
        : normalizedSavingsNote(input.note);

      const retainedWithoutCurrent = await retainedMinorInTransaction(database, eventId);
      const linkedExpenseEntryId = existing.kind === "release"
        ? input.linkedExpenseEntryId ?? existing.linkedExpenseEntryId
        : undefined;
      if (existing.kind === "reserve") {
        assertSavingsFitsBalance(
          retainedWithoutCurrent + BigInt(input.amountMinor),
          await ledgerBalanceMinorInTransaction(database),
        );
      } else {
        if (BigInt(input.amountMinor) > retainedWithoutCurrent) {
          throw new LedgerDataError("取用金额不能超过当前已留存金额", "invalid-settings");
        }
        if (linkedExpenseEntryId) {
          await assertLinkedReleaseFitsExpense(
            database,
            linkedExpenseEntryId,
            input.amountMinor,
            eventId,
          );
        }
      }

      const updated: SavingsEvent = {
        ...existing,
        amountMinor: input.amountMinor,
        note,
        ...occurrence,
        ...(existing.kind === "release" && linkedExpenseEntryId
          ? { linkedExpenseEntryId }
          : {}),
        updatedAt: now.toISOString(),
      };
      await database.savingsEvents.put(updated);
      await queueSyncMutation(
        "savingsEvent",
        updated.id,
        updated,
        database,
        updated.updatedAt,
      );
      return updated;
    },
  );
}

/** Product-facing aliases kept small so UI code can use domain language. */
export const addSavings = reserveSavings;
export const useSavings = releaseSavings;

async function putSavingsSettlementInTransaction(
  input: SavingsSettlementInput,
  database: LedgerDatabase,
  now: Date,
  prospectiveBalanceMinor?: number,
): Promise<SavingsEvent> {
  assertSavingsAmount(input.amountMinor, true);
  assertSavingsAmount(input.goalMinorSnapshot, true);
  try {
    localDateFromKey(input.cycleStartDateKey);
    localDateFromKey(input.cycleEndDateKey);
  } catch {
    throw new LedgerDataError("结算周期日期无效", "invalid-settings");
  }
  if (input.cycleStartDateKey > input.cycleEndDateKey) {
    throw new LedgerDataError("结算周期日期无效", "invalid-settings");
  }
  const occurrence = savingsOccurrence(input.occurredAtLocal, now);
  if (occurrence.localDateKey <= input.cycleEndDateKey) {
    throw new LedgerDataError("只能在周期结束后结算留存", "invalid-settings");
  }
  const note = normalizedSavingsNote(input.note);
  const id = settlementSavingsEventId(input.cycleStartDateKey);
  const allEvents = await database.savingsEvents.toArray();
  const eventsWithoutCurrent = allEvents.filter((event) => event.id !== id);
  const openingRetainedMinor = calculateRetainedSavingsSummary(
    eventsWithoutCurrent.filter((event) =>
      event.localDateKey < input.cycleStartDateKey ||
      (
        event.occurredAt <= occurrence.occurredAt
        && (
          event.kind === "opening"
          || (
            event.kind === "cycle_settlement"
            && event.cycleEndDateKey < input.cycleStartDateKey
          )
        )
      )),
  ).totalRetainedMinor;
  const cycleActivityMinor = calculateRetainedSavingsSummary(
    eventsWithoutCurrent.filter((event) =>
      event.kind !== "opening"
      && !(
        event.kind === "cycle_settlement"
        && event.cycleEndDateKey < input.cycleStartDateKey
      )
      && event.localDateKey >= input.cycleStartDateKey
      && event.localDateKey <= input.cycleEndDateKey),
  ).totalRetainedMinor;
  const closingRetainedMinor = openingRetainedMinor
    + cycleActivityMinor
    + BigInt(input.amountMinor);
  const retainedAfterSettlement = calculateRetainedSavingsSummary(
    eventsWithoutCurrent,
  ).totalRetainedMinor + BigInt(input.amountMinor);
  assertSavingsFitsBalance(
    retainedAfterSettlement,
    prospectiveBalanceMinor ?? await ledgerBalanceMinorInTransaction(database),
  );
  const existing = await database.savingsEvents.get(id);
  const nowIso = now.toISOString();
  const event: SavingsEvent = {
    id,
    kind: "cycle_settlement",
    amountMinor: input.amountMinor,
    note,
    ...occurrence,
    cycleStartDateKey: input.cycleStartDateKey,
    cycleEndDateKey: input.cycleEndDateKey,
    goalMinorSnapshot: input.goalMinorSnapshot,
    openingRetainedMinor: safeSnapshotMinor(openingRetainedMinor, "期初留存"),
    closingRetainedMinor: safeSnapshotMinor(closingRetainedMinor, "期末留存"),
    netGrowthMinor: safeSnapshotMinor(
      closingRetainedMinor - openingRetainedMinor,
      "本周期留存净增长",
    ),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  await database.savingsEvents.put(event);
  return event;
}

export async function settleSavingsCycle(
  input: SavingsSettlementInput,
  database = ledgerDb,
  now = new Date(),
): Promise<SavingsEvent> {
  void input;
  void database;
  void now;
  // Retained only so old source imports fail at runtime with an explicit
  // migration message. Historical settlement rows remain readable.
  void putSavingsSettlementInTransaction;
  throw new LedgerDataError(
    "Cycle settlement is no longer supported",
    "invalid-settings",
  );
}

export const settleCycleSavings = settleSavingsCycle;

export async function softDeleteSavingsEvent(
  eventId: string,
  database = ledgerDb,
  now = new Date(),
): Promise<SavingsEvent> {
  return database.transaction(
    "rw",
    [
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
    const existing = await database.savingsEvents.get(eventId);
    if (!existing) throw new LedgerDataError("找不到这条留存记录", "not-found");
    if (existing.deletedAt) {
      throw new LedgerDataError("这条留存记录已经删除", "already-deleted");
    }
    const nowIso = now.toISOString();
    const deleted: SavingsEvent = {
      ...existing,
      deletedAt: nowIso,
      updatedAt: nowIso,
    };
    await database.savingsEvents.put(deleted);
    await queueSyncMutation("savingsEvent", deleted.id, deleted, database, nowIso);
    return deleted;
    },
  );
}

export async function undoDeleteSavingsEvent(
  eventId: string,
  database = ledgerDb,
  now = new Date(),
): Promise<SavingsEvent> {
  return database.transaction(
    "rw",
    [
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
    const existing = await database.savingsEvents.get(eventId);
    if (!existing) throw new LedgerDataError("找不到这条留存记录", "not-found");
    if (!existing.deletedAt) {
      throw new LedgerDataError("这条留存记录并未删除", "not-deleted");
    }
    const restored: SavingsEvent = { ...existing, updatedAt: now.toISOString() };
    delete restored.deletedAt;
    await database.savingsEvents.put(restored);
    await queueSyncMutation("savingsEvent", restored.id, restored, database, now.toISOString());
    return restored;
    },
  );
}

export async function purgeDeletedSavingsEvent(
  eventId: string,
  database = ledgerDb,
): Promise<void> {
  await database.transaction(
    "rw",
    [
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
    ],
    async () => {
      const existing = await database.savingsEvents.get(eventId);
      if (!existing) return;
      if (!existing.deletedAt) {
        throw new LedgerDataError("只能永久清理已删除的留存记录", "not-deleted");
      }
      const link = await database.syncState.get("primary");
      if (link?.uploadApproved) {
        const entityKey = syncEntityKey("savingsEvent", eventId);
        const [outbox, entityState] = await Promise.all([
          database.syncOutbox.get(entityKey),
          database.entitySyncState.get(entityKey),
        ]);
        if (
          !entityState?.tombstoneAcknowledged &&
          (
            outbox?.entityType !== "savingsEvent" ||
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
      await database.savingsEvents.delete(eventId);
    },
  );
}

export interface ActualIncomeResult {
  entry?: LedgerEntry;
  /** @deprecated Always undefined in v6. */
  settlement?: never;
  settings: AppSettings;
}

export async function recordActualIncome(
  amountMinor: number,
  database = ledgerDb,
  now = new Date(),
): Promise<ActualIncomeResult> {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    amountMinor > MAX_AMOUNT_MINOR
  ) {
    throw new LedgerDataError("实际收入金额无效", "invalid-settings");
  }
  return database.transaction(
    "rw",
    [
      database.entries,
      database.settings,
      database.recoveryAllocations,
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const current = (await database.settings.get("primary")) ?? createDefaultSettings(now);
      const forecast = current.incomeForecast;
      if (!forecast || currentLocalDateKey(now) < forecast.targetPaydayDateKey) {
        throw new LedgerDataError("当前没有可确认的到期收入预期", "invalid-settings");
      }

      const nowIso = now.toISOString();
      let entry: LedgerEntry | undefined;
      let entryMutationId: string | undefined;
      if (amountMinor > 0) {
        const localTime = currentLocalDateTimeInput(now).slice(11);
        const occurred = parseLocalDateTime(`${forecast.targetPaydayDateKey}T${localTime}`);
        const existing = await database.entries.get(forecast.id);
        if (existing) {
          if (
            existing.amountMinor !== amountMinor ||
            existing.note !== "本次实际收入" ||
            existing.treatment !== "ordinary_income" ||
            existing.localDateKey !== forecast.targetPaydayDateKey ||
            existing.deletedAt !== undefined
          ) {
            throw new LedgerDataError(
              "本次收入已在其他设备确认，请先同步",
              "sync-conflict",
            );
          }
          entry = existing;
        } else {
          entry = {
            // A forecast has one stable id on every device, so its confirmed
            // income cannot become multiple ledger rows after synchronization.
            id: forecast.id,
            amountMinor,
            note: "本次实际收入",
            occurredAt: occurred.occurredAt,
            localDateKey: occurred.localDateKey,
            localMonthKey: occurred.localMonthKey,
            timezoneOffsetMinutes: occurred.timezoneOffsetMinutes,
            treatment: "ordinary_income",
            confirmationStatus: "not_needed",
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          await database.entries.add(entry);
        }
        entryMutationId = createId("mutation");
      }

      const settings: AppSettings = {
        ...current,
        lastExpectedIncomeMinor: forecast.expectedIncomeMinor,
        updatedAt: nowIso,
      };
      delete settings.incomeForecast;
      delete settings.savingsTargetOverride;
      delete settings.cycleSavingsTargetOverride;
      await database.settings.put(settings);
      const absorbedSettingsMutation = await queueSyncMutation(
        "settings",
        settings.id,
        settings,
        database,
        nowIso,
        {
        clearIncomeForecast: true,
        clearSavingsTargetOverride: true,
        },
      );
      await queueIncomeConfirmationMutation(
        settings,
        {
          confirmationId: createId("income-confirmation"),
          forecastId: forecast.id,
          targetPaydayDateKey: forecast.targetPaydayDateKey,
          expectedIncomeMinor: forecast.expectedIncomeMinor,
          actualIncomeMinor: amountMinor,
          confirmedAt: nowIso,
          ...(entry && entryMutationId ? { entry, entryMutationId } : {}),
        },
        absorbedSettingsMutation?.id,
        database,
        nowIso,
      );
      return { entry, settings };
    },
  );
}

export function recordActualIncomeWithSavings(
  amountMinor: number,
  savingsAmountMinor: number,
  database = ledgerDb,
  now = new Date(),
  savingsNote?: string,
): Promise<ActualIncomeResult> {
  void amountMinor;
  void savingsAmountMinor;
  void database;
  void now;
  void savingsNote;
  return Promise.reject(new LedgerDataError(
    "实际收入不再自动存钱，请确认收入后使用“存一笔”",
    "invalid-settings",
  ));
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
    treatment: defaultTreatmentFromAmount(valid.amountMinor),
    confirmationStatus: "not_needed",
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await database.transaction(
    "rw",
    [
      database.entries,
      database.attachments,
      database.savingsEvents,
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

export async function createSavingsFundedExpense(
  draft: EntryDraft,
  savingsAmountMinor: number,
  database = ledgerDb,
  now = new Date(),
  treatment: Extract<
    EntryTreatment,
    "ordinary_expense" | "one_time_expense" | "reimbursable_expense"
  > = "one_time_expense",
): Promise<SavingsFundedExpenseResult> {
  assertSavingsAmount(savingsAmountMinor);
  const valid = validateEntryDraft(draft);
  if (
    valid.amountMinor >= 0 ||
    savingsAmountMinor > Math.abs(valid.amountMinor) ||
    !treatmentMatchesAmountSafe(treatment, valid.amountMinor)
  ) {
    throw new LedgerDataError("留存取用金额必须由这笔支出承担", "invalid-settings");
  }
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
    treatment,
    confirmationStatus: "confirmed",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const savingsEvent: SavingsEvent = {
    id: createId("savings-release"),
    kind: "release",
    amountMinor: savingsAmountMinor,
    note: normalizedSavingsNote(valid.note || "取用留存支付"),
    occurredAt: valid.occurredAt,
    localDateKey: valid.localDateKey,
    localMonthKey: valid.localMonthKey,
    timezoneOffsetMinutes: valid.timezoneOffsetMinutes,
    linkedExpenseEntryId: entryId,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await database.transaction(
    "rw",
    [
      database.entries,
      database.attachments,
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const retainedMinor = await retainedMinorInTransaction(database);
      if (BigInt(savingsAmountMinor) > retainedMinor) {
        throw new LedgerDataError("取用金额不能超过当前已留存金额", "invalid-settings");
      }
      if (attachment) await database.attachments.add(attachment);
      await database.entries.add(entry);
      await database.savingsEvents.add(savingsEvent);
      await queueSyncMutation("entry", entry.id, entry, database, nowIso);
      await queueSyncMutation(
        "savingsEvent",
        savingsEvent.id,
        savingsEvent,
        database,
        nowIso,
      );
    },
  );
  return { entry, savingsEvent };
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
      database.savingsEvents,
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

    const signFlipped = Math.sign(existing.amountMinor) !== Math.sign(valid.amountMinor);
    const treatment = signFlipped
      || !treatmentMatchesAmountSafe(existing.treatment, valid.amountMinor)
      ? defaultTreatmentFromAmount(valid.amountMinor)
      : existing.treatment;
    const materialTreatmentChange = signFlipped
      || existing.amountMinor !== valid.amountMinor
      || existing.occurredAt !== valid.occurredAt;
    const confirmationStatus = materialTreatmentChange
      ? "not_needed"
      : existing.confirmationStatus;
    const updated: LedgerEntry = {
      ...existing,
      amountMinor: valid.amountMinor,
      note: valid.note,
      occurredAt: valid.occurredAt,
      localDateKey: valid.localDateKey,
      localMonthKey: valid.localMonthKey,
      timezoneOffsetMinutes: valid.timezoneOffsetMinutes,
      attachmentId,
      treatment,
      confirmationStatus,
      promptedRevision: materialTreatmentChange
        ? undefined
        : existing.promptedRevision
          ? nowIso
          : undefined,
      updatedAt: nowIso,
    };
    const linkedReleases = await database.savingsEvents
      .where("linkedExpenseEntryId")
      .equals(entryId)
      .filter((event) => event.kind === "release" && !event.deletedAt)
      .toArray();
    const linkedAmountMinor = linkedReleases.reduce(
      (total, event) => total + BigInt(event.amountMinor),
      0n,
    );
    if (
      linkedReleases.length > 0 &&
      (
        updated.amountMinor >= 0 ||
        linkedAmountMinor > -BigInt(updated.amountMinor)
      )
    ) {
      throw new LedgerDataError(
        "修改后的支出不足以承担已关联的留存取用",
        "invalid-settings",
      );
    }
    await database.entries.put(updated);
    for (const release of linkedReleases) {
      const updatedRelease: SavingsEvent = {
        ...release,
        occurredAt: updated.occurredAt,
        localDateKey: updated.localDateKey,
        localMonthKey: updated.localMonthKey,
        timezoneOffsetMinutes: updated.timezoneOffsetMinutes,
        updatedAt: nowIso,
      };
      await database.savingsEvents.put(updatedRelease);
      await queueSyncMutation(
        "savingsEvent",
        updatedRelease.id,
        updatedRelease,
        database,
        nowIso,
      );
    }
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
    [
      database.entries,
      database.recoveryAllocations,
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const existing = await database.entries.get(entryId);
      if (!existing) throw new LedgerDataError("找不到这条记录", "not-found");
      if (existing.deletedAt) throw new LedgerDataError("这条记录已经删除", "already-deleted");
      const timestamp = now.toISOString();
      const deleted = { ...normalizeLedgerEntry(existing), deletedAt: timestamp, updatedAt: timestamp };
      await database.entries.put(deleted);
      const related = await database.recoveryAllocations
        .filter((row) => row.refundEntryId === entryId || row.expenseEntryId === entryId)
        .toArray();
      for (const row of related) {
        if (row.deletedAt) continue;
        const tombstone: RecoveryAllocation = {
          ...row,
          deletedAt: timestamp,
          updatedAt: timestamp,
        };
        await database.recoveryAllocations.put(tombstone);
        await queueSyncMutation(
          "recoveryAllocation",
          tombstone.id,
          tombstone,
          database,
          timestamp,
        );
      }
      const linkedReleases = await database.savingsEvents
        .where("linkedExpenseEntryId")
        .equals(entryId)
        .toArray();
      for (const release of linkedReleases) {
        if (release.deletedAt) continue;
        const tombstone: SavingsEvent = {
          ...release,
          deletedAt: timestamp,
          updatedAt: timestamp,
        };
        await database.savingsEvents.put(tombstone);
        await queueSyncMutation(
          "savingsEvent",
          tombstone.id,
          tombstone,
          database,
          timestamp,
        );
      }
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
    [
      database.entries,
      database.recoveryAllocations,
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const existing = await database.entries.get(entryId);
      if (!existing) throw new LedgerDataError("找不到这条记录", "not-found");
      if (!existing.deletedAt) throw new LedgerDataError("这条记录并未删除", "not-deleted");
      const nowIso = now.toISOString();
      const entryDeletedAt = existing.deletedAt;
      const restored: LedgerEntry = {
        ...normalizeLedgerEntry(existing),
        updatedAt: nowIso,
      };
      delete restored.deletedAt;
      await database.entries.put(restored);

      // Re-activate allocations soft-deleted with this entry only if both ends are live.
      const related = await database.recoveryAllocations
        .filter((row) => row.refundEntryId === entryId || row.expenseEntryId === entryId)
        .toArray();
      for (const row of related) {
        if (row.deletedAt !== entryDeletedAt) continue;
        const refund = await database.entries.get(row.refundEntryId);
        const expense = await database.entries.get(row.expenseEntryId);
        if (!refund || !expense || refund.deletedAt || expense.deletedAt) continue;
        try {
          const others = await database.recoveryAllocations.toArray();
          assertRecoveryAllocationValid(row.amountMinor, {
            refund: normalizeLedgerEntry(refund),
            expense: normalizeLedgerEntry(expense),
            existing: others,
            ignoreAllocationId: row.id,
          });
          const live: RecoveryAllocation = { ...row, updatedAt: nowIso };
          delete live.deletedAt;
          await database.recoveryAllocations.put(live);
          await queueSyncMutation(
            "recoveryAllocation",
            live.id,
            live,
            database,
            nowIso,
          );
        } catch {
          // Leave soft-deleted; user must re-link. Do not silently truncate.
        }
      }

      const linkedReleases = await database.savingsEvents
        .where("linkedExpenseEntryId")
        .equals(entryId)
        .toArray();
      for (const release of linkedReleases) {
        if (release.deletedAt !== entryDeletedAt) continue;
        const live: SavingsEvent = { ...release, updatedAt: nowIso };
        delete live.deletedAt;
        await database.savingsEvents.put(live);
        await queueSyncMutation("savingsEvent", live.id, live, database, nowIso);
      }

      await queueSyncMutation("entry", restored.id, restored, database, nowIso);
      return restored;
    },
  );
}

export async function purgeDeletedEntry(entryId: string, database = ledgerDb): Promise<void> {
  await database.transaction(
    "rw",
    [
      database.entries,
      database.attachments,
      database.recoveryAllocations,
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
    ],
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
      await purgeRecoveryAllocationsForEntry(entryId, database);
      await database.savingsEvents
        .where("linkedExpenseEntryId")
        .equals(entryId)
        .delete();
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
    [
      database.entries,
      database.attachments,
      database.recoveryAllocations,
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
    ],
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
    for (const entry of entries) {
      await purgeRecoveryAllocationsForEntry(entry.id, database);
      await database.savingsEvents
        .where("linkedExpenseEntryId")
        .equals(entry.id)
        .delete();
    }
    await database.entries.bulkDelete(entries.map((entry) => entry.id));
    return entries.length;
    },
  );
}

export async function listActiveEntries(database = ledgerDb): Promise<LedgerEntry[]> {
  const entries = await database.entries.orderBy("occurredAt").reverse().toArray();
  return entries.filter((entry) => !entry.deletedAt).map(normalizeLedgerEntry);
}

export async function getEntry(entryId: string, database = ledgerDb): Promise<LedgerEntry | undefined> {
  const entry = await database.entries.get(entryId);
  return entry ? normalizeLedgerEntry(entry) : undefined;
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
): Promise<SyncEntityPayload | undefined> {
  if (entityType === "entry") return database.entries.get(entityId);
  if (entityType === "recoveryAllocation") {
    return database.recoveryAllocations.get(entityId);
  }
  if (entityType === "savingsEvent") return database.savingsEvents.get(entityId);
  return database.settings.get("primary");
}

async function applyRemotePayload(
  change: {
    entityType: SyncEntityType;
    entityId: string;
    payload: SyncEntityPayload;
  },
  database: LedgerDatabase,
): Promise<void> {
  if (change.entityType === "settings") {
    await database.settings.put(change.payload as AppSettings);
    return;
  }
  if (change.entityType === "recoveryAllocation") {
    const allocation = change.payload as RecoveryAllocation;
    if (allocation.deletedAt) {
      await database.recoveryAllocations.delete(change.entityId);
    } else {
      await database.recoveryAllocations.put(allocation);
    }
    return;
  }
  if (change.entityType === "savingsEvent") {
    const event = change.payload as SavingsEvent;
    if (event.deletedAt) {
      await database.savingsEvents.delete(change.entityId);
    } else {
      await database.savingsEvents.put(event);
    }
    return;
  }

  const entry = normalizeLedgerEntry(change.payload as LedgerEntry);
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
  localPayload: SyncEntityPayload,
  database: LedgerDatabase,
  nowIso: string,
  operationKey?: string,
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
    ...(change.entityType === "settings" && change.claimLegacyIncomeForecast
      ? { claimLegacyIncomeForecast: true as const }
      : {}),
    ...(change.entityType === "settings" && change.claimLegacySavingsTarget
      ? { claimLegacySavingsTarget: true as const }
      : {}),
    ...(operationKey ?? existing?.operationKey
      ? { operationKey: operationKey ?? existing?.operationKey }
      : {}),
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
    const [entityState, directPending, existingConflict] = await Promise.all([
      database.entitySyncState.get(id),
      database.syncOutbox.get(id),
      database.syncConflicts.get(id),
    ]);
    const pending = directPending ?? (change.entityType === "settings"
      ? (await database.syncOutbox
          .filter((record) => record.entityId === change.entityId)
          .toArray()).find(isIncomeConfirmationOutbox)
      : undefined);
    if (change.version <= (entityState?.serverVersion ?? 0) && !existingConflict) continue;

    if (pending || existingConflict) {
      const localPayload = await currentLocalPayload(
        change.entityType,
        change.entityId,
        database,
      ) ?? pending?.payload;
      if (localPayload) {
        await recordConflict(
          change,
          localPayload,
          database,
          nowIso,
          pending?.incomeConfirmation ? pending.entityKey : undefined,
        );
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
        "deletedAt" in change.payload
          ? Boolean(change.payload.deletedAt)
          : false,
      updatedAt: nowIso,
    });
    if (
      change.entityType === "settings"
      && (change.claimLegacyIncomeForecast || change.claimLegacySavingsTarget)
    ) {
      await queueSyncMutation(
        "settings",
        change.entityId,
        change.payload,
        database,
        nowIso,
      );
    }
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
      database.recoveryAllocations,
      database.savingsEvents,
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

async function discardProvisionalIncomeGraph(
  forecastId: string,
  database: LedgerDatabase,
): Promise<void> {
  const entry = await database.entries.get(forecastId);
  const allocations = await database.recoveryAllocations.toArray();
  const savingsEvents = await database.savingsEvents.toArray();
  const outbox = await database.syncOutbox.toArray();
  const conflicts = await database.syncConflicts.toArray();
  const allocationIds = new Set(
    allocations
      .filter((allocation) =>
        allocation.refundEntryId === forecastId || allocation.expenseEntryId === forecastId)
      .map((allocation) => allocation.id),
  );
  const savingsEventIds = new Set(
    savingsEvents
      .filter((event) =>
        "linkedExpenseEntryId" in event && event.linkedExpenseEntryId === forecastId)
      .map((event) => event.id),
  );
  for (const record of outbox) {
    if (record.entityType === "recoveryAllocation") {
      const allocation = record.payload as RecoveryAllocation;
      if (allocation.refundEntryId === forecastId || allocation.expenseEntryId === forecastId) {
        allocationIds.add(record.entityId);
      }
    } else if (
      record.entityType === "savingsEvent" &&
      "linkedExpenseEntryId" in (record.payload as SavingsEvent) &&
      (record.payload as Extract<SavingsEvent, { kind: "release" }>).linkedExpenseEntryId ===
        forecastId
    ) {
      savingsEventIds.add(record.entityId);
    }
  }
  for (const conflict of conflicts) {
    if (conflict.entityType === "recoveryAllocation") {
      const local = conflict.localPayload as RecoveryAllocation;
      const remote = conflict.remotePayload as RecoveryAllocation;
      if (
        local.refundEntryId === forecastId || local.expenseEntryId === forecastId ||
        remote.refundEntryId === forecastId || remote.expenseEntryId === forecastId
      ) {
        allocationIds.add(conflict.entityId);
      }
    } else if (conflict.entityType === "savingsEvent") {
      const local = conflict.localPayload as SavingsEvent;
      const remote = conflict.remotePayload as SavingsEvent;
      if (
        ("linkedExpenseEntryId" in local && local.linkedExpenseEntryId === forecastId) ||
        ("linkedExpenseEntryId" in remote && remote.linkedExpenseEntryId === forecastId)
      ) {
        savingsEventIds.add(conflict.entityId);
      }
    }
  }

  for (const allocationId of allocationIds) {
    await database.recoveryAllocations.delete(allocationId);
    const key = syncEntityKey("recoveryAllocation", allocationId);
    await database.syncOutbox.delete(key);
    await database.syncConflicts.delete(key);
    await database.entitySyncState.delete(key);
  }
  for (const eventId of savingsEventIds) {
    await database.savingsEvents.delete(eventId);
    const key = syncEntityKey("savingsEvent", eventId);
    await database.syncOutbox.delete(key);
    await database.syncConflicts.delete(key);
    await database.entitySyncState.delete(key);
  }
  if (entry?.attachmentId) await database.attachments.delete(entry.attachmentId);
  await database.entries.delete(forecastId);
  const entryKey = syncEntityKey("entry", forecastId);
  await database.syncOutbox.delete(entryKey);
  await database.syncConflicts.delete(entryKey);
  await database.entitySyncState.delete(entryKey);
}

function entriesMatch(
  left: LedgerEntry | undefined,
  right: LedgerEntry,
): boolean {
  if (!left) return false;
  const keys: Array<keyof LedgerEntry> = [
    "id",
    "amountMinor",
    "note",
    "occurredAt",
    "localDateKey",
    "localMonthKey",
    "timezoneOffsetMinutes",
    "attachmentId",
    "treatment",
    "confirmationStatus",
    "detectionRuleVersion",
    "promptedRevision",
    "createdAt",
    "updatedAt",
    "deletedAt",
  ];
  return keys.every((key) => left[key] === right[key]);
}

async function applyIncomeConfirmationResult(
  sent: SyncOutboxRecord & { incomeConfirmation: IncomeConfirmationSyncPayload },
  result: Extract<SyncResult, { status: "applied" | "duplicate" }> & {
    incomeConfirmation: NonNullable<Extract<SyncResult, {
      status: "applied" | "duplicate";
    }>["incomeConfirmation"]>;
  },
  database: LedgerDatabase,
  nowIso: string,
): Promise<void> {
  const canonical = result.incomeConfirmation;
  const ownsReceipt = canonical.confirmationId === sent.incomeConfirmation.confirmationId;
  const entryKey = syncEntityKey("entry", canonical.forecastId);
  const pendingEntry = await database.syncOutbox.get(entryKey);

  if (!canonical.entry || canonical.entryVersion === undefined) {
    await discardProvisionalIncomeGraph(canonical.forecastId, database);
  } else if (pendingEntry) {
    const canRebaseEntry = ownsReceipt &&
      canonical.entryVersion === 1 &&
      !canonical.entry.deletedAt &&
      entriesMatch(sent.incomeConfirmation.entry, canonical.entry);
    if (!canRebaseEntry) {
      await recordConflict({
        seq: "0",
        entityType: "entry",
        entityId: canonical.entry.id,
        version: canonical.entryVersion,
        payload: canonical.entry,
      }, pendingEntry.payload, database, nowIso);
    } else {
      await database.syncOutbox.put({
        ...pendingEntry,
        id: createId("mutation"),
        baseVersion: canonical.entryVersion,
        updatedAt: nowIso,
      });
      await database.syncConflicts.delete(entryKey);
      await database.entitySyncState.put({
        id: entryKey,
        entityType: "entry",
        entityId: canonical.entry.id,
        serverVersion: canonical.entryVersion,
        status: "pending",
        tombstoneAcknowledged: false,
        updatedAt: nowIso,
      });
    }
  } else {
    await applyRemotePayload({
      entityType: "entry",
      entityId: canonical.entry.id,
      payload: canonical.entry,
    }, database);
    await database.syncConflicts.delete(entryKey);
    await database.entitySyncState.put({
      id: entryKey,
      entityType: "entry",
      entityId: canonical.entry.id,
      serverVersion: canonical.entryVersion,
      status: "clean",
      tombstoneAcknowledged: Boolean(canonical.entry.deletedAt),
      updatedAt: nowIso,
    });
  }

  const settingsKey = syncEntityKey("settings", sent.entityId);
  if (ownsReceipt) {
    let pendingSettings = await database.syncOutbox.get(settingsKey);
    const priorPendingSettingsId = pendingSettings?.id;
    if (pendingSettings?.id === sent.absorbedSettingsMutationId) {
      await database.syncOutbox.delete(settingsKey);
      pendingSettings = undefined;
    } else if (pendingSettings) {
      pendingSettings = {
        ...pendingSettings,
        id: createId("mutation"),
        baseVersion: result.version,
        updatedAt: nowIso,
      };
      await database.syncOutbox.put(pendingSettings);
    }

    const laterConfirmations = (await database.syncOutbox
      .filter((record) => record.entityId === sent.entityId)
      .toArray())
      .filter(isIncomeConfirmationOutbox)
      .filter((record) => record.entityKey !== sent.entityKey);
    for (const laterConfirmation of laterConfirmations) {
      const absorbedSettingsMutationId =
        laterConfirmation.absorbedSettingsMutationId === priorPendingSettingsId
          ? pendingSettings?.id
          : laterConfirmation.absorbedSettingsMutationId;
      const rebasedConfirmation = {
        ...laterConfirmation,
        id: createId("mutation"),
        baseVersion: result.version,
        updatedAt: nowIso,
      };
      if (absorbedSettingsMutationId) {
        rebasedConfirmation.absorbedSettingsMutationId = absorbedSettingsMutationId;
      } else {
        delete rebasedConfirmation.absorbedSettingsMutationId;
      }
      await database.syncOutbox.put(rebasedConfirmation);
    }

    await database.entitySyncState.put({
      id: settingsKey,
      entityType: "settings",
      entityId: sent.entityId,
      serverVersion: result.version,
      status: pendingSettings ? "pending" : "clean",
      tombstoneAcknowledged: false,
      updatedAt: nowIso,
    });
  }

  await database.syncOutbox.delete(sent.entityKey);
  await database.syncConflicts.delete(sent.entityKey);
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
      await recordConflict(
        result.remote,
        localPayload,
        database,
        nowIso,
        sent.incomeConfirmation ? sent.entityKey : undefined,
      );
      continue;
    }

    if (sent.incomeConfirmation && result.incomeConfirmation) {
      await applyIncomeConfirmationResult(
        sent as SyncOutboxRecord & { incomeConfirmation: IncomeConfirmationSyncPayload },
        result as Extract<SyncResult, { status: "applied" | "duplicate" }> & {
          incomeConfirmation: NonNullable<typeof result.incomeConfirmation>;
        },
        database,
        nowIso,
      );
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
        "deletedAt" in sent.payload
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
    [
      database.entries,
      database.attachments,
      database.settings,
      database.recoveryAllocations,
      database.savingsEvents,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
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
      database.recoveryAllocations,
      database.savingsEvents,
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
      database.recoveryAllocations,
      database.savingsEvents,
      database.syncState,
      database.entitySyncState,
      database.syncOutbox,
      database.syncConflicts,
    ],
    async () => {
      const conflict = await database.syncConflicts.get(id);
      if (!conflict) throw new LedgerDataError("The sync conflict no longer exists", "sync-conflict");
      const pendingConfirmations = entityType === "settings"
        ? (await database.syncOutbox
            .filter((record) => record.entityId === entityId)
            .toArray()).filter(isIncomeConfirmationOutbox)
        : [];

      if (resolution === "use-cloud") {
        const confirmationsToDiscard = conflict.operationKey
          ? pendingConfirmations.filter((record) => record.entityKey === conflict.operationKey)
          : pendingConfirmations;
        const confirmationsToKeep = conflict.operationKey
          ? pendingConfirmations.filter((record) => record.entityKey !== conflict.operationKey)
          : [];
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
        for (const pendingConfirmation of confirmationsToDiscard) {
          await discardProvisionalIncomeGraph(
            pendingConfirmation.incomeConfirmation.forecastId,
            database,
          );
          await database.syncOutbox.delete(pendingConfirmation.entityKey);
        }
        await database.syncOutbox.delete(id);
        for (const pendingConfirmation of confirmationsToKeep) {
          const rebased = {
            ...pendingConfirmation,
            id: createId("mutation"),
            baseVersion: conflict.remoteVersion,
            updatedAt: nowIso,
          };
          delete rebased.absorbedSettingsMutationId;
          await database.syncOutbox.put(rebased);
        }
        await database.syncConflicts.delete(id);
        await database.entitySyncState.put({
          id,
          entityType,
          entityId,
          serverVersion: conflict.remoteVersion,
          status: "clean",
          tombstoneAcknowledged:
            "deletedAt" in conflict.remotePayload
              ? Boolean(conflict.remotePayload.deletedAt)
              : false,
          updatedAt: nowIso,
        });
        if (
          entityType === "settings"
          && (conflict.claimLegacyIncomeForecast || conflict.claimLegacySavingsTarget)
        ) {
          await queueSyncMutation(
            "settings",
            entityId,
            conflict.remotePayload,
            database,
            nowIso,
          );
        }
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
      const rebasedSettingsMutation: SyncOutboxRecord = {
        entityKey: id,
        id: createId("mutation"),
        entityType,
        entityId,
        baseVersion: conflict.remoteVersion,
        payload: syncPayloadFor(entityType, localPayload),
        ...(entityType === "settings" &&
          !Object.prototype.hasOwnProperty.call(localPayload, "monthEndBalanceGoalMinor")
          ? { clearMonthEndBalanceGoal: true as const }
          : {}),
        ...(entityType === "settings" &&
          !Object.prototype.hasOwnProperty.call(localPayload, "payCycle")
          ? { clearPayCycle: true as const }
          : {}),
        ...(entityType === "settings" &&
          !Object.prototype.hasOwnProperty.call(localPayload, "incomeForecast")
          ? { clearIncomeForecast: true as const }
          : {}),
        ...(entityType === "settings" &&
          !Object.prototype.hasOwnProperty.call(localPayload, "savingsTargetOverride")
          ? { clearSavingsTargetOverride: true as const }
          : {}),
        ...(entityType === "settings" &&
          !Object.prototype.hasOwnProperty.call(localPayload, "savingsGoal")
          ? { clearSavingsGoal: true as const }
          : {}),
        ...(entityType === "settings" &&
          !Object.prototype.hasOwnProperty.call(localPayload, "lastExpectedIncomeMinor")
          ? { clearLastExpectedIncomeMinor: true as const }
          : {}),
        ...(entityType === "settings" &&
          !Object.prototype.hasOwnProperty.call(localPayload, "savingsGoalNeedsSetup")
          ? { clearSavingsGoalNeedsSetup: true as const }
          : {}),
        createdAt: existingOutbox?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
      await database.syncOutbox.put(rebasedSettingsMutation);
      for (const pendingConfirmation of pendingConfirmations) {
        const rebasedConfirmation = {
          ...pendingConfirmation,
          id: createId("mutation"),
          baseVersion: conflict.remoteVersion,
          updatedAt: nowIso,
        };
        delete rebasedConfirmation.absorbedSettingsMutationId;
        await database.syncOutbox.put(rebasedConfirmation);
      }
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
  recoveryAllocations: RecoveryAllocation[];
  /** Optional until backup payload v4 becomes the only writer. */
  savingsEvents?: SavingsEvent[];
}

export async function replaceLedgerData(
  replacement: LedgerReplacement,
  database = ledgerDb,
): Promise<void> {
  await database.transaction(
    "rw",
    [
      database.settings,
      database.entries,
      database.attachments,
      database.recoveryAllocations,
      database.savingsEvents,
      database.syncState,
    ],
    async () => {
      if (await database.syncState.get("primary")) {
        throw new LedgerDataError(
          "Unlink cloud sync before replacing the entire local ledger",
          "sync-linked",
        );
      }
      await database.attachments.clear();
      await database.recoveryAllocations.clear();
      await database.savingsEvents.clear();
      await database.entries.clear();
      await database.settings.clear();
      await database.settings.add(replacement.settings);
      if (replacement.entries.length) await database.entries.bulkAdd(replacement.entries);
      if (replacement.attachments.length) {
        await database.attachments.bulkAdd(replacement.attachments);
      }
      if (replacement.recoveryAllocations.length) {
        await database.recoveryAllocations.bulkAdd(replacement.recoveryAllocations);
      }
      if (replacement.savingsEvents?.length) {
        await database.savingsEvents.bulkAdd(replacement.savingsEvents);
      }
    },
  );
}
