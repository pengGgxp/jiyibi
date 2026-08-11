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
  incomeForecast?: IncomeForecastPayload;
  schemaVersion: 1;
  updatedAt: string;
}

/**
 * v4 may expose a one-time migration hint when D1 still only has the legacy
 * monthly salary. Clients claim it into a dated income forecast and never
 * persist this field in the local domain model.
 */
export interface SyncAppSettingsPayload extends AppSettingsPayload {
  _legacyMonthlySalaryMinor?: number;
}

export interface PayCyclePlanPayload {
  paydayDay: number;
  cycleEndBalanceGoalMinor: number;
}

export interface LegacyPayCyclePlanPayload extends PayCyclePlanPayload {
  monthlySalaryMinor: number;
}

export interface IncomeForecastPayload {
  id: string;
  targetPaydayDateKey: string;
  minimumIncomeMinor: number;
  expectedIncomeMinor: number;
}

export interface LegacyAppSettingsPayload
  extends Omit<AppSettingsPayload, "payCycle" | "incomeForecast"> {
  payCycle?: LegacyPayCyclePlanPayload;
}

export interface SettingsMutationPayload
  extends Omit<
    AppSettingsPayload,
    "monthEndBalanceGoalMinor" | "payCycle" | "incomeForecast"
  > {
  monthEndBalanceGoalMinor?: number | null;
  payCycle?: PayCyclePlanPayload | LegacyPayCyclePlanPayload | null;
  incomeForecast?: IncomeForecastPayload | null;
}

export type SyncEntityType = "entry" | "settings";
export type SyncProtocolVersion = 1 | 2 | 3 | 4;

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
  payload: LedgerEntryPayload | SyncAppSettingsPayload | LegacyAppSettingsPayload;
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
