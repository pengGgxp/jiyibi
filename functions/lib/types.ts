export interface Env {
  DB: D1Database;
  ATTACHMENTS: KVNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_ALLOWED_USER_ID?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  ENVIRONMENT?: string;
  LOCAL_AUTH_EMAIL?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  issuer: string;
  subject: string;
}

export type CloudSyncStatus = "disabled" | "enabled" | "deleting";

export interface CloudSyncState {
  status: CloudSyncStatus;
  generation: number;
  lastDeletedGeneration: number | null;
}

export interface LedgerEntryPayload {
  id: string;
  amountMinor: number;
  note: string;
  occurredAt: string;
  localDateKey: string;
  localMonthKey: string;
  timezoneOffsetMinutes: number;
  attachmentId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface AppSettingsPayload {
  id: "primary";
  currency: "CNY";
  initialBalanceMinor: number;
  monthEndBalanceGoalMinor?: number;
  payCycle?: PayCyclePlanPayload;
  schemaVersion: 1;
  updatedAt: string;
}

export interface PayCyclePlanPayload {
  paydayDay: number;
  monthlySalaryMinor: number;
  cycleEndBalanceGoalMinor: number;
}

export interface SettingsMutationPayload
  extends Omit<AppSettingsPayload, "monthEndBalanceGoalMinor" | "payCycle"> {
  monthEndBalanceGoalMinor?: number | null;
  payCycle?: PayCyclePlanPayload | null;
}

export type SyncEntityType = "entry" | "settings";
export type SyncProtocolVersion = 1 | 2 | 3;

interface SyncMutationBase {
  id: string;
  entityId: string;
  baseVersion: number;
}

export type SyncMutation =
  | SyncMutationBase & { entityType: "entry"; payload: LedgerEntryPayload }
  | SyncMutationBase & { entityType: "settings"; payload: SettingsMutationPayload };

export interface SyncRequestBody {
  schemaVersion: SyncProtocolVersion;
  cursor: string;
  mutations: SyncMutation[];
}

export interface RemoteChange {
  seq: string;
  entityType: SyncEntityType;
  entityId: string;
  version: number;
  payload: LedgerEntryPayload | AppSettingsPayload;
}

export type MutationResult =
  | {
      id: string;
      status: "applied" | "duplicate";
      version: number;
    }
  | {
      id: string;
      status: "conflict";
      remote: RemoteChange;
    };
