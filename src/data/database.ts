import Dexie, { type EntityTable } from "dexie";
import { MAX_AMOUNT_MINOR } from "../domain/amount";
import {
  currentLocalDateKey,
  currentLocalDateTimeInput,
  currentLocalMonthKey,
  parseLocalDateTime,
  resolveNextPaydayDateKey,
} from "../domain/date";
import {
  assertRecoveryAllocationValid,
  defaultTreatmentFromAmount,
  normalizeLedgerEntry,
} from "../domain/entry-treatment";
import { calculateLedgerSummary } from "../domain/stats";
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
} from "../domain/types";
import { validateEntryDraft } from "../domain/validation";
import { createId } from "../lib/id";
import {
  SYNC_SCHEMA_VERSION,
  type SessionResponse,
  type SyncProtocolVersion,
  type SyncChange,
  type SyncEntityType,
  type SyncResult,
} from "../sync/contracts";

export const DATABASE_NAME = "jiyibi";
export const DATABASE_SCHEMA_VERSION = 1 as const;
/** v3: cloud sync tables. v4: entry treatment fields + recovery allocations. */
export const INDEXED_DB_VERSION = 4 as const;
export const INDEXED_DB_SYNC_VERSION = 3 as const;

const SYNC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type EntitySyncStatus = "clean" | "pending" | "conflict";

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
  /** Stable primary key used to coalesce edits for one entity. */
  entityKey: string;
  /** Idempotency key sent to the server; replaced whenever the payload changes. */
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  baseVersion: number;
  payload: LedgerEntry | AppSettings;
  clearMonthEndBalanceGoal?: true;
  clearPayCycle?: true;
  clearIncomeForecast?: true;
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
  claimLegacyIncomeForecast?: true;
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

export class LedgerDatabase extends Dexie {
  entries!: EntityTable<LedgerEntry, "id">;
  attachments!: EntityTable<Attachment, "id">;
  settings!: EntityTable<AppSettings, "id">;
  recoveryAllocations!: EntityTable<RecoveryAllocation, "id">;
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
    this.version(INDEXED_DB_VERSION).stores({
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
    settings.initialBalanceMinor === 0 &&
    settings.monthEndBalanceGoalMinor === undefined &&
    settings.payCycle === undefined &&
    settings.incomeForecast === undefined
  );
}

/**
 * Protocol v4 cannot carry treatment fields (P7 will introduce v5).
 * Local IndexedDB keeps full LedgerEntry; the outbox wire payload strips
 * analysis-only fields so old servers keep accepting mutations.
 */
type SyncWireEntry = Omit<
  LedgerEntry,
  "treatment" | "confirmationStatus" | "detectionRuleVersion" | "promptedRevision"
>;

function toSyncWireEntry(entry: LedgerEntry): SyncWireEntry {
  const normalized = normalizeLedgerEntry(entry);
  const {
    treatment: _treatment,
    confirmationStatus: _confirmationStatus,
    detectionRuleVersion: _detectionRuleVersion,
    promptedRevision: _promptedRevision,
    ...wire
  } = normalized;
  if (wire.deletedAt) delete wire.attachmentId;
  return wire;
}

function syncPayloadFor(
  entityType: SyncEntityType,
  payload: LedgerEntry | AppSettings,
): LedgerEntry | AppSettings {
  if (entityType === "entry") {
    // Cast: wire shape is a v4 subset; local readers always re-normalize.
    return toSyncWireEntry(payload as LedgerEntry) as LedgerEntry;
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
    promptedRevision?: string;
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
        promptedRevision: options.promptedRevision ?? existing.promptedRevision,
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
    database.entries,
    database.recoveryAllocations,
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
      return row;
    },
  );
}

export async function softDeleteRecoveryAllocation(
  allocationId: string,
  database = ledgerDb,
  now = new Date(),
): Promise<void> {
  const existing = await database.recoveryAllocations.get(allocationId);
  if (!existing || existing.deletedAt) return;
  const nowIso = now.toISOString();
  await database.recoveryAllocations.put({
    ...existing,
    deletedAt: nowIso,
    updatedAt: nowIso,
  });
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
  payload: LedgerEntry | AppSettings,
  database: LedgerDatabase,
  nowIso: string,
  options: {
    clearMonthEndBalanceGoal?: boolean;
    clearPayCycle?: boolean;
    clearIncomeForecast?: boolean;
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
      payCycle.paydayDay > 31 ||
      !Number.isSafeInteger(payCycle.cycleEndBalanceGoalMinor) ||
      Math.abs(payCycle.cycleEndBalanceGoalMinor) > MAX_AMOUNT_MINOR
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
          cycleEndBalanceGoalMinor: payCycle.cycleEndBalanceGoalMinor,
        };
      }
      await database.settings.put(next);
      await queueSyncMutation("settings", next.id, next, database, nowIso, {
        clearMonthEndBalanceGoal: true,
        clearPayCycle: payCycle === undefined,
        clearIncomeForecast: payCycle === undefined,
      });
      return next;
    },
  );
}

export type IncomeForecastInput = Omit<IncomeForecast, "id"> & { id?: string };

function isValidIncomeForecastInput(value: IncomeForecastInput): boolean {
  return (
    (value.id === undefined || (
      typeof value.id === "string" &&
      SYNC_ID_PATTERN.test(value.id)
    )) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.targetPaydayDateKey) &&
    Number.isSafeInteger(value.minimumIncomeMinor) &&
    value.minimumIncomeMinor >= 0 &&
    value.minimumIncomeMinor <= MAX_AMOUNT_MINOR &&
    Number.isSafeInteger(value.expectedIncomeMinor) &&
    value.expectedIncomeMinor >= 0 &&
    value.expectedIncomeMinor <= MAX_AMOUNT_MINOR &&
    value.minimumIncomeMinor <= value.expectedIncomeMinor
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
        resolveNextPaydayDateKey(current.payCycle.paydayDay, now) !==
          incomeForecast.targetPaydayDateKey
      ) {
        throw new LedgerDataError("收入预期必须对应下一次发薪日", "invalid-settings");
      }
      const nowIso = now.toISOString();
      const next: AppSettings = {
        ...current,
        incomeForecast: {
          ...structuredClone(incomeForecast),
          id: incomeForecast.id ?? (
            current.incomeForecast?.targetPaydayDateKey === incomeForecast.targetPaydayDateKey
              ? current.incomeForecast.id
              : createId("income-forecast")
          ),
        },
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

export interface ActualIncomeResult {
  entry?: LedgerEntry;
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
      if (amountMinor > 0) {
        const localTime = currentLocalDateTimeInput(now).slice(11);
        const occurred = parseLocalDateTime(`${forecast.targetPaydayDateKey}T${localTime}`);
        entry = {
          id: createId("entry"),
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
        await queueSyncMutation("entry", entry.id, entry, database, nowIso);
      }

      const settings: AppSettings = { ...current, updatedAt: nowIso };
      delete settings.incomeForecast;
      await database.settings.put(settings);
      await queueSyncMutation("settings", settings.id, settings, database, nowIso, {
        clearIncomeForecast: true,
      });
      return { entry, settings };
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

    const signFlipped = Math.sign(existing.amountMinor) !== Math.sign(valid.amountMinor);
    const treatment = signFlipped
      || !treatmentMatchesAmountSafe(existing.treatment, valid.amountMinor)
      ? defaultTreatmentFromAmount(valid.amountMinor)
      : existing.treatment;
    const confirmationStatus = signFlipped
      || existing.amountMinor !== valid.amountMinor
      || existing.occurredAt !== valid.occurredAt
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
      // Amount/time change invalidates a prior prompt for this revision.
      promptedRevision: confirmationStatus === existing.confirmationStatus
        && existing.amountMinor === valid.amountMinor
        && existing.occurredAt === valid.occurredAt
        ? existing.promptedRevision
        : undefined,
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
    [
      database.entries,
      database.recoveryAllocations,
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
        await database.recoveryAllocations.put({
          ...row,
          deletedAt: timestamp,
          updatedAt: timestamp,
        });
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
        } catch {
          // Leave soft-deleted; user must re-link. Do not silently truncate.
        }
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
    ...(change.entityType === "settings" && change.claimLegacyIncomeForecast
      ? { claimLegacyIncomeForecast: true as const }
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
    if (change.entityType === "settings" && change.claimLegacyIncomeForecast) {
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
        if (entityType === "settings" && conflict.claimLegacyIncomeForecast) {
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
      await database.syncOutbox.put({
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
