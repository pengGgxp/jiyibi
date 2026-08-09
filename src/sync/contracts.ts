import type { AppSettings, LedgerEntry } from "../domain/types";

export const API_SCHEMA_VERSION = 1 as const;
export const SYNC_SCHEMA_VERSION = 2 as const;

export type SyncEntityType = "entry" | "settings";
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

export interface SettingsSyncPayload extends Omit<AppSettings, "monthEndBalanceGoalMinor"> {
  monthEndBalanceGoalMinor?: number | null;
}

export interface SettingsSyncMutation extends SyncMutationBase {
  entityType: "settings";
  payload: SettingsSyncPayload;
}

export type SyncMutation = EntrySyncMutation | SettingsSyncMutation;

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
}

export type SyncChange = EntrySyncChange | SettingsSyncChange;

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
