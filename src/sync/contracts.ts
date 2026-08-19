import type {
  AppSettings,
  IncomeForecast,
  LedgerEntry,
  PayCyclePlan,
  RecoveryAllocation,
  SavingsGoal,
  SavingsEvent,
} from "../domain/types";

export const API_SCHEMA_VERSION = 1 as const;
export const SYNC_SCHEMA_VERSION = 7 as const;
export type SyncProtocolVersion = 1 | 2 | 3 | 4 | 5 | 6 | typeof SYNC_SCHEMA_VERSION;

export type SyncEntityType = "entry" | "settings" | "recoveryAllocation" | "savingsEvent";
export type CloudSyncStatus = "disabled" | "enabled" | "deleting";

export interface SessionResponse {
  schemaVersion: typeof API_SCHEMA_VERSION;
  user: {
    id: string;
    email: string;
  };
  cloud: {
    syncStatus: CloudSyncStatus;
    generation: number;
    hasData: boolean;
    entryCount: number;
    attachmentCount: number;
    cursor: string;
  };
}

export interface CloudAccountDeletionResponse {
  schemaVersion: typeof API_SCHEMA_VERSION;
  complete: boolean;
  deletedObjects: number;
  remainingObjects: number;
}

interface SyncMutationBase {
  id: string;
  entityId: string;
  baseVersion: number;
}

export interface EntrySyncMutation extends SyncMutationBase {
  entityType: "entry";
  payload: LedgerEntry;
}

export interface IncomeConfirmationSyncPayload {
  confirmationId: string;
  forecastId: string;
  targetPaydayDateKey: string;
  expectedIncomeMinor: number;
  actualIncomeMinor: number;
  confirmedAt: string;
  entryMutationId?: string;
  entry?: LedgerEntry;
}

export interface SettingsSyncPayload extends Omit<
  AppSettings,
  | "monthEndBalanceGoalMinor"
  | "payCycle"
  | "incomeForecast"
  | "savingsTargetOverride"
  | "cycleSavingsTargetOverride"
  | "savingsTargetNeedsReview"
  | "savingsGoal"
  | "lastExpectedIncomeMinor"
  | "savingsGoalNeedsSetup"
> {
  payCycle?: Pick<PayCyclePlan, "paydayDay"> | null;
  incomeForecast?: Omit<IncomeForecast, "minimumIncomeMinor"> | null;
  savingsGoal?: SavingsGoal | null;
  lastExpectedIncomeMinor?: number | null;
  savingsGoalNeedsSetup?: true | null;
  /** Sync-only receipt used to atomically confirm one forecast across devices. */
  incomeConfirmation?: IncomeConfirmationSyncPayload;
}

export interface SettingsSyncMutation extends SyncMutationBase {
  entityType: "settings";
  payload: SettingsSyncPayload;
}

export interface RecoveryAllocationSyncMutation extends SyncMutationBase {
  entityType: "recoveryAllocation";
  payload: RecoveryAllocation;
}

export interface SavingsEventSyncMutation extends SyncMutationBase {
  entityType: "savingsEvent";
  payload: SavingsEvent;
}

export type SyncMutation =
  | EntrySyncMutation
  | SettingsSyncMutation
  | RecoveryAllocationSyncMutation
  | SavingsEventSyncMutation;

export interface SyncRequest {
  schemaVersion: typeof SYNC_SCHEMA_VERSION;
  cursor: string;
  mutations: SyncMutation[];
}

interface SyncChangeBase {
  seq: string;
  entityId: string;
  version: number;
}

export interface EntrySyncChange extends SyncChangeBase {
  entityType: "entry";
  payload: LedgerEntry;
}

export interface SettingsSyncChange extends SyncChangeBase {
  entityType: "settings";
  payload: AppSettings;
  /** The response carried a legacy salary that was normalized locally. */
  claimLegacyIncomeForecast?: true;
  /** The response carried a legacy balance floor that was normalized locally. */
  claimLegacySavingsTarget?: true;
}

export interface RecoveryAllocationSyncChange extends SyncChangeBase {
  entityType: "recoveryAllocation";
  payload: RecoveryAllocation;
}

export interface SavingsEventSyncChange extends SyncChangeBase {
  entityType: "savingsEvent";
  payload: SavingsEvent;
}

export type SyncChange =
  | EntrySyncChange
  | SettingsSyncChange
  | RecoveryAllocationSyncChange
  | SavingsEventSyncChange;

export interface SyncAppliedResult {
  id: string;
  status: "applied" | "duplicate";
  version: number;
  incomeConfirmation?: {
    confirmationId: string;
    forecastId: string;
    actualIncomeMinor: number;
    entryVersion?: number;
    entry?: LedgerEntry;
  };
}

export interface SyncConflictResult {
  id: string;
  status: "conflict";
  remote: SyncChange;
}

export type SyncResult = SyncAppliedResult | SyncConflictResult;
export type SyncMutationResult = SyncResult;

export interface SyncResponse {
  schemaVersion: typeof SYNC_SCHEMA_VERSION;
  results: SyncMutationResult[];
  changes: SyncChange[];
  nextCursor: string;
  hasMore: boolean;
}
