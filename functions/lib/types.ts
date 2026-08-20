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

export type EntryTreatment =
  | "ordinary_expense"
  | "periodic_expense"
  | "one_time_expense"
  | "reimbursable_expense"
  | "ordinary_income"
  | "refund_reimbursement"
  | "account_transfer";

export type ConfirmationStatus = "not_needed" | "pending" | "confirmed";

export interface LedgerEntryPayload {
  id: string;
  amountMinor: number;
  note: string;
  occurredAt: string;
  localDateKey: string;
  localMonthKey: string;
  timezoneOffsetMinutes: number;
  attachmentId?: string;
  treatment?: EntryTreatment;
  confirmationStatus?: ConfirmationStatus;
  detectionRuleVersion?: number;
  promptedRevision?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface RecoveryAllocationPayload {
  id: string;
  refundEntryId: string;
  expenseEntryId: string;
  amountMinor: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export type SavingsEventKind = "opening" | "reserve" | "release" | "cycle_settlement";

export interface SavingsEventPayload {
  id: string;
  kind: SavingsEventKind;
  amountMinor: number;
  note: string;
  occurredAt: string;
  localDateKey: string;
  localMonthKey: string;
  timezoneOffsetMinutes: number;
  linkedExpenseEntryId?: string;
  cycleStartDateKey?: string;
  cycleEndDateKey?: string;
  goalMinorSnapshot?: number;
  openingRetainedMinor?: number;
  closingRetainedMinor?: number;
  netGrowthMinor?: number;
  transferToRetainedMinor?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

interface BalanceAdjustmentBasePayload {
  id: string;
  amountMinor: number;
  note: string;
  occurredAt: string;
  localDateKey: string;
  localMonthKey: string;
  timezoneOffsetMinutes: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export type BalanceAdjustmentPayload =
  | BalanceAdjustmentBasePayload & {
      kind: "reconciliation";
      balanceBeforeMinor: number;
      observedBalanceMinor: number;
    }
  | BalanceAdjustmentBasePayload & {
      kind: "opening_correction";
      previousOpeningMinor: number;
      nextOpeningMinor: number;
    };

export interface AppSettingsPayload {
  id: "primary";
  currency: "CNY";
  initialBalanceMinor: number;
  initialBalanceLockedAt?: string;
  monthEndBalanceGoalMinor?: number;
  payCycle?: PayCyclePlanPayload;
  incomeForecast?: IncomeForecastPayload;
  savingsTargetOverride?: CycleSavingsTargetOverridePayload;
  savingsGoal?: SavingsGoalPayload;
  lastExpectedIncomeMinor?: number;
  savingsGoalNeedsSetup?: true;
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
}

export interface V6PayCyclePlanPayload {
  paydayDay: number;
  defaultSavingsTargetMinor: number;
}

export interface LegacyPayCyclePlanPayload {
  paydayDay: number;
  cycleEndBalanceGoalMinor: number;
  monthlySalaryMinor?: number;
}

export interface CycleSavingsTargetOverridePayload {
  targetPaydayDateKey: string;
  targetMinor: number;
}

export interface IncomeForecastPayload {
  id: string;
  targetPaydayDateKey: string;
  /** Present only in v4-v6 compatibility payloads. */
  minimumIncomeMinor?: number;
  expectedIncomeMinor: number;
}

export interface SavingsGoalPayload {
  targetDateKey: string;
  targetMinor: number;
}

export interface IncomeConfirmationPayload {
  confirmationId: string;
  forecastId: string;
  targetPaydayDateKey: string;
  expectedIncomeMinor: number;
  actualIncomeMinor: number;
  confirmedAt: string;
  entryMutationId?: string;
  entry?: LedgerEntryPayload;
}

export interface LegacyAppSettingsPayload
  extends Omit<
    AppSettingsPayload,
    | "payCycle"
    | "incomeForecast"
    | "savingsTargetOverride"
    | "savingsGoal"
    | "lastExpectedIncomeMinor"
    | "savingsGoalNeedsSetup"
    | "initialBalanceLockedAt"
  > {
  payCycle?: LegacyPayCyclePlanPayload;
}

export interface SettingsMutationPayload
  extends Omit<
    AppSettingsPayload,
    | "monthEndBalanceGoalMinor"
    | "payCycle"
    | "incomeForecast"
    | "savingsTargetOverride"
    | "savingsGoal"
    | "lastExpectedIncomeMinor"
    | "savingsGoalNeedsSetup"
    | "initialBalanceLockedAt"
  > {
  monthEndBalanceGoalMinor?: number | null;
  payCycle?: PayCyclePlanPayload | V6PayCyclePlanPayload | LegacyPayCyclePlanPayload | null;
  incomeForecast?: IncomeForecastPayload | null;
  savingsTargetOverride?: CycleSavingsTargetOverridePayload | null;
  savingsGoal?: SavingsGoalPayload | null;
  lastExpectedIncomeMinor?: number | null;
  savingsGoalNeedsSetup?: true | null;
  initialBalanceLockedAt?: string;
  incomeConfirmation?: IncomeConfirmationPayload;
}

export type SyncEntityType =
  | "entry"
  | "settings"
  | "recoveryAllocation"
  | "savingsEvent"
  | "balanceAdjustment";
export type SyncProtocolVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

interface SyncMutationBase {
  id: string;
  entityId: string;
  baseVersion: number;
}

export type SyncMutation =
  | SyncMutationBase & { entityType: "entry"; payload: LedgerEntryPayload }
  | SyncMutationBase & { entityType: "settings"; payload: SettingsMutationPayload }
  | SyncMutationBase & {
      entityType: "recoveryAllocation";
      payload: RecoveryAllocationPayload;
    }
  | SyncMutationBase & {
      entityType: "savingsEvent";
      payload: SavingsEventPayload;
    }
  | SyncMutationBase & {
      entityType: "balanceAdjustment";
      payload: BalanceAdjustmentPayload;
    };

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
  payload:
    | LedgerEntryPayload
    | SyncAppSettingsPayload
    | LegacyAppSettingsPayload
    | RecoveryAllocationPayload
    | SavingsEventPayload
    | BalanceAdjustmentPayload;
}

export type MutationResult =
  | {
      id: string;
      status: "applied" | "duplicate";
      version: number;
      incomeConfirmation?: {
        confirmationId: string;
        forecastId: string;
        actualIncomeMinor: number;
        entryVersion?: number;
        entry?: LedgerEntryPayload;
      };
    }
  | {
      id: string;
      status: "conflict";
      remote: RemoteChange;
    };
