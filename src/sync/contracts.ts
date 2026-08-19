import type {
  AppSettings,
  CycleSavingsTargetOverride,
  IncomeForecast,
  LedgerEntry,
  PayCyclePlan,
  RecoveryAllocation,
  SavingsEvent,
} from "../domain/types";

export const API_SCHEMA_VERSION = 1 as const;
export const SYNC_SCHEMA_VERSION = 6 as const;
export type SyncProtocolVersion = 1 | 2 | 3 | 4 | 5 | typeof SYNC_SCHEMA_VERSION;

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

export interface SettingsSyncPayload extends Omit<
  AppSettings,
  | "monthEndBalanceGoalMinor"
  | "payCycle"
  | "incomeForecast"
  | "savingsTargetOverride"
  | "cycleSavingsTargetOverride"
  | "savingsTargetNeedsReview"
> {
  monthEndBalanceGoalMinor?: number | null;
  payCycle?: PayCyclePlan | null;
  incomeForecast?: IncomeForecast | null;
  savingsTargetOverride?: CycleSavingsTargetOverride | null;
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
