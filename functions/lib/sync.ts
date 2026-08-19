import { ApiError } from "./errors";
import { cleanupPendingAttachments } from "./cleanup";
import type {
  BalanceAdjustmentPayload,
  IncomeConfirmationPayload,
  IncomeForecastPayload,
  LegacyAppSettingsPayload,
  LegacyPayCyclePlanPayload,
  LedgerEntryPayload,
  MutationResult,
  RecoveryAllocationPayload,
  SavingsEventPayload,
  SavingsGoalPayload,
  RemoteChange,
  SettingsMutationPayload,
  SyncAppSettingsPayload,
  SyncMutation,
  SyncProtocolVersion,
  SyncRequestBody,
  Env,
} from "./types";

const CHANGE_PAGE_SIZE = 100;

interface ChangeRow {
  cursor: string;
  mutation_id: string;
  entity_type:
    | "entry"
    | "settings"
    | "recoveryAllocation"
    | "savingsEvent"
    | "balanceAdjustment";
  entity_id: string;
  entity_version: number;
  mutation_hash: string;
  payload_json: string;
  settings_id?: string | null;
  settings_currency?: string | null;
  settings_initial_balance_minor?: number | null;
  settings_initial_balance_locked_at?: string | null;
  settings_month_end_balance_goal_minor?: number | null;
  settings_payday_day?: number | null;
  settings_monthly_salary_minor?: number | null;
  settings_cycle_end_balance_goal_minor?: number | null;
  settings_income_forecast_id?: string | null;
  settings_income_forecast_target_payday_date_key?: string | null;
  settings_minimum_income_minor?: number | null;
  settings_expected_income_minor?: number | null;
  settings_default_savings_target_minor?: number | null;
  settings_savings_override_target_payday_date_key?: string | null;
  settings_savings_override_target_minor?: number | null;
  settings_savings_goal_target_date_key?: string | null;
  settings_savings_goal_target_minor?: number | null;
  settings_last_expected_income_minor?: number | null;
  settings_savings_goal_needs_setup?: number | null;
  settings_schema_version?: number | null;
  settings_updated_at?: string | null;
  entry_id?: string | null;
  entry_amount_minor?: number | null;
  entry_note?: string | null;
  entry_occurred_at?: string | null;
  entry_local_date_key?: string | null;
  entry_local_month_key?: string | null;
  entry_timezone_offset_minutes?: number | null;
  entry_attachment_id?: string | null;
  entry_treatment?: string | null;
  entry_confirmation_status?: string | null;
  entry_detection_rule_version?: number | null;
  entry_prompted_revision?: string | null;
  entry_created_at?: string | null;
  entry_updated_at?: string | null;
  entry_deleted_at?: string | null;
  savings_id?: string | null;
  savings_kind?: string | null;
  savings_amount_minor?: number | null;
  savings_note?: string | null;
  savings_occurred_at?: string | null;
  savings_local_date_key?: string | null;
  savings_local_month_key?: string | null;
  savings_timezone_offset_minutes?: number | null;
  savings_linked_expense_entry_id?: string | null;
  savings_cycle_start_date_key?: string | null;
  savings_cycle_end_date_key?: string | null;
  savings_goal_minor_snapshot?: number | null;
  savings_opening_retained_minor?: number | null;
  savings_closing_retained_minor?: number | null;
  savings_net_growth_minor?: number | null;
  savings_created_at?: string | null;
  savings_updated_at?: string | null;
  savings_deleted_at?: string | null;
  adjustment_id?: string | null;
  adjustment_kind?: string | null;
  adjustment_amount_minor?: number | null;
  adjustment_note?: string | null;
  adjustment_occurred_at?: string | null;
  adjustment_local_date_key?: string | null;
  adjustment_local_month_key?: string | null;
  adjustment_timezone_offset_minutes?: number | null;
  adjustment_balance_before_minor?: number | null;
  adjustment_observed_balance_minor?: number | null;
  adjustment_previous_opening_minor?: number | null;
  adjustment_next_opening_minor?: number | null;
  adjustment_created_at?: string | null;
  adjustment_updated_at?: string | null;
  adjustment_deleted_at?: string | null;
}

const SETTINGS_PROJECTION_COLUMNS = `
  current_settings.id AS settings_id,
  current_settings.currency AS settings_currency,
  current_settings.initial_balance_minor AS settings_initial_balance_minor,
  current_settings.initial_balance_locked_at AS settings_initial_balance_locked_at,
  current_settings.month_end_balance_goal_minor AS settings_month_end_balance_goal_minor,
  current_settings.payday_day AS settings_payday_day,
  current_settings.monthly_salary_minor AS settings_monthly_salary_minor,
  current_settings.cycle_end_balance_goal_minor AS settings_cycle_end_balance_goal_minor,
  current_settings.income_forecast_id AS settings_income_forecast_id,
  current_settings.income_forecast_target_payday_date_key
    AS settings_income_forecast_target_payday_date_key,
  current_settings.minimum_income_minor AS settings_minimum_income_minor,
  current_settings.expected_income_minor AS settings_expected_income_minor,
  current_settings.default_savings_target_minor AS settings_default_savings_target_minor,
  current_settings.savings_override_target_payday_date_key
    AS settings_savings_override_target_payday_date_key,
  current_settings.savings_override_target_minor AS settings_savings_override_target_minor,
  current_settings.savings_goal_target_date_key AS settings_savings_goal_target_date_key,
  current_settings.savings_goal_target_minor AS settings_savings_goal_target_minor,
  current_settings.last_expected_income_minor AS settings_last_expected_income_minor,
  current_settings.savings_goal_needs_setup AS settings_savings_goal_needs_setup,
  current_settings.schema_version AS settings_schema_version,
  current_settings.updated_at AS settings_updated_at`;

const SETTINGS_PROJECTION_JOIN = `
  LEFT JOIN ledger_settings AS current_settings
    ON current_change.entity_type = 'settings'
   AND current_settings.user_id = current_change.user_id
   AND current_settings.account_generation = current_change.account_generation
   AND current_settings.id = current_change.entity_id`;

const ENTRY_PROJECTION_COLUMNS = `
  current_entry.id AS entry_id,
  current_entry.amount_minor AS entry_amount_minor,
  current_entry.note AS entry_note,
  current_entry.occurred_at AS entry_occurred_at,
  current_entry.local_date_key AS entry_local_date_key,
  current_entry.local_month_key AS entry_local_month_key,
  current_entry.timezone_offset_minutes AS entry_timezone_offset_minutes,
  current_entry.attachment_id AS entry_attachment_id,
  current_entry.treatment AS entry_treatment,
  current_entry.confirmation_status AS entry_confirmation_status,
  current_entry.detection_rule_version AS entry_detection_rule_version,
  current_entry.prompted_revision AS entry_prompted_revision,
  current_entry.created_at AS entry_created_at,
  current_entry.updated_at AS entry_updated_at,
  current_entry.deleted_at AS entry_deleted_at`;

const ENTRY_PROJECTION_JOIN = `
  LEFT JOIN ledger_entries AS current_entry
    ON current_change.entity_type = 'entry'
   AND current_entry.user_id = current_change.user_id
   AND current_entry.account_generation = current_change.account_generation
   AND current_entry.id = current_change.entity_id`;

const SAVINGS_PROJECTION_COLUMNS = `
  current_savings.id AS savings_id,
  current_savings.kind AS savings_kind,
  current_savings.amount_minor AS savings_amount_minor,
  current_savings.note AS savings_note,
  current_savings.occurred_at AS savings_occurred_at,
  current_savings.local_date_key AS savings_local_date_key,
  current_savings.local_month_key AS savings_local_month_key,
  current_savings.timezone_offset_minutes AS savings_timezone_offset_minutes,
  current_savings.linked_expense_entry_id AS savings_linked_expense_entry_id,
  current_savings.cycle_start_date_key AS savings_cycle_start_date_key,
  current_savings.cycle_end_date_key AS savings_cycle_end_date_key,
  current_savings.goal_minor_snapshot AS savings_goal_minor_snapshot,
  current_savings.opening_retained_minor AS savings_opening_retained_minor,
  current_savings.closing_retained_minor AS savings_closing_retained_minor,
  current_savings.net_growth_minor AS savings_net_growth_minor,
  current_savings.created_at AS savings_created_at,
  current_savings.updated_at AS savings_updated_at,
  current_savings.deleted_at AS savings_deleted_at`;

const SAVINGS_PROJECTION_JOIN = `
  LEFT JOIN savings_events AS current_savings
    ON current_change.entity_type = 'savingsEvent'
   AND current_savings.user_id = current_change.user_id
   AND current_savings.account_generation = current_change.account_generation
   AND current_savings.id = current_change.entity_id`;

const ADJUSTMENT_PROJECTION_COLUMNS = `
  current_adjustment.id AS adjustment_id,
  current_adjustment.kind AS adjustment_kind,
  current_adjustment.amount_minor AS adjustment_amount_minor,
  current_adjustment.note AS adjustment_note,
  current_adjustment.occurred_at AS adjustment_occurred_at,
  current_adjustment.local_date_key AS adjustment_local_date_key,
  current_adjustment.local_month_key AS adjustment_local_month_key,
  current_adjustment.timezone_offset_minutes AS adjustment_timezone_offset_minutes,
  current_adjustment.balance_before_minor AS adjustment_balance_before_minor,
  current_adjustment.observed_balance_minor AS adjustment_observed_balance_minor,
  current_adjustment.previous_opening_minor AS adjustment_previous_opening_minor,
  current_adjustment.next_opening_minor AS adjustment_next_opening_minor,
  current_adjustment.created_at AS adjustment_created_at,
  current_adjustment.updated_at AS adjustment_updated_at,
  current_adjustment.deleted_at AS adjustment_deleted_at`;

const ADJUSTMENT_PROJECTION_JOIN = `
  LEFT JOIN balance_adjustments AS current_adjustment
    ON current_change.entity_type = 'balanceAdjustment'
   AND current_adjustment.user_id = current_change.user_id
   AND current_adjustment.account_generation = current_change.account_generation
   AND current_adjustment.id = current_change.entity_id`;

interface VersionRow {
  version: number;
}

interface InitialBalanceLockRow {
  initial_balance_minor: number;
  initial_balance_locked_at: string | null;
}

function payloadFromRow(
  row: ChangeRow,
  protocolVersion: SyncProtocolVersion,
): LedgerEntryPayload | SyncAppSettingsPayload | LegacyAppSettingsPayload | RecoveryAllocationPayload | SavingsEventPayload | BalanceAdjustmentPayload {
  try {
    const payload = JSON.parse(row.payload_json) as unknown;
    if (row.entity_type === "recoveryAllocation") {
      return payload as RecoveryAllocationPayload;
    }
    if (row.entity_type === "savingsEvent") {
      return savingsEventPayloadFromRow(row) ?? payload as SavingsEventPayload;
    }
    if (row.entity_type === "balanceAdjustment") {
      return balanceAdjustmentPayloadFromRow(row) ?? payload as BalanceAdjustmentPayload;
    }
    if (row.entity_type === "entry") {
      return entryPayloadFromRow(row, protocolVersion) ?? payload as LedgerEntryPayload;
    }
    return projectSettingsPayload(
      settingsPayloadFromRow(row, protocolVersion) ?? payload,
      protocolVersion,
    );
  } catch {
    throw new Error("Stored sync payload is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryPayloadFromRow(
  row: ChangeRow,
  protocolVersion: SyncProtocolVersion,
): LedgerEntryPayload | null {
  if (typeof row.entry_id !== "string") return null;
  const payload: LedgerEntryPayload = {
    id: row.entry_id,
    amountMinor: Number(row.entry_amount_minor),
    note: String(row.entry_note ?? ""),
    occurredAt: String(row.entry_occurred_at),
    localDateKey: String(row.entry_local_date_key),
    localMonthKey: String(row.entry_local_month_key),
    timezoneOffsetMinutes: Number(row.entry_timezone_offset_minutes),
    createdAt: String(row.entry_created_at),
    updatedAt: String(row.entry_updated_at),
  };
  if (row.entry_attachment_id) payload.attachmentId = row.entry_attachment_id;
  if (protocolVersion >= 5) {
    payload.treatment = row.entry_treatment as LedgerEntryPayload["treatment"];
    payload.confirmationStatus =
      row.entry_confirmation_status as LedgerEntryPayload["confirmationStatus"];
    if (row.entry_detection_rule_version !== null &&
        row.entry_detection_rule_version !== undefined) {
      payload.detectionRuleVersion = row.entry_detection_rule_version;
    }
    if (row.entry_prompted_revision) payload.promptedRevision = row.entry_prompted_revision;
  }
  if (row.entry_deleted_at) payload.deletedAt = row.entry_deleted_at;
  return payload;
}

function savingsEventPayloadFromRow(row: ChangeRow): SavingsEventPayload | null {
  if (typeof row.savings_id !== "string" || typeof row.savings_kind !== "string") return null;
  const payload: SavingsEventPayload = {
    id: row.savings_id,
    kind: row.savings_kind as SavingsEventPayload["kind"],
    amountMinor: Number(row.savings_amount_minor),
    note: String(row.savings_note ?? ""),
    occurredAt: String(row.savings_occurred_at),
    localDateKey: String(row.savings_local_date_key),
    localMonthKey: String(row.savings_local_month_key),
    timezoneOffsetMinutes: Number(row.savings_timezone_offset_minutes),
    createdAt: String(row.savings_created_at),
    updatedAt: String(row.savings_updated_at),
  };
  if (row.savings_linked_expense_entry_id) {
    payload.linkedExpenseEntryId = row.savings_linked_expense_entry_id;
  }
  if (row.savings_cycle_start_date_key) {
    payload.cycleStartDateKey = row.savings_cycle_start_date_key;
    payload.cycleEndDateKey = String(row.savings_cycle_end_date_key);
    payload.goalMinorSnapshot = Number(row.savings_goal_minor_snapshot);
    payload.openingRetainedMinor = Number(row.savings_opening_retained_minor);
    payload.closingRetainedMinor = Number(row.savings_closing_retained_minor);
    payload.netGrowthMinor = Number(row.savings_net_growth_minor);
  }
  if (row.savings_deleted_at) payload.deletedAt = row.savings_deleted_at;
  return payload;
}

function balanceAdjustmentPayloadFromRow(row: ChangeRow): BalanceAdjustmentPayload | null {
  if (typeof row.adjustment_id !== "string" || typeof row.adjustment_kind !== "string") {
    return null;
  }
  const common = {
    id: row.adjustment_id,
    amountMinor: Number(row.adjustment_amount_minor),
    note: String(row.adjustment_note ?? ""),
    occurredAt: String(row.adjustment_occurred_at),
    localDateKey: String(row.adjustment_local_date_key),
    localMonthKey: String(row.adjustment_local_month_key),
    timezoneOffsetMinutes: Number(row.adjustment_timezone_offset_minutes),
    createdAt: String(row.adjustment_created_at),
    updatedAt: String(row.adjustment_updated_at),
    ...(row.adjustment_deleted_at ? { deletedAt: row.adjustment_deleted_at } : {}),
  };
  if (row.adjustment_kind === "reconciliation") {
    return {
      ...common,
      kind: "reconciliation",
      balanceBeforeMinor: Number(row.adjustment_balance_before_minor),
      observedBalanceMinor: Number(row.adjustment_observed_balance_minor),
    };
  }
  return {
    ...common,
    kind: "opening_correction",
    previousOpeningMinor: Number(row.adjustment_previous_opening_minor),
    nextOpeningMinor: Number(row.adjustment_next_opening_minor),
  };
}

function settingsPayloadFromRow(
  row: ChangeRow,
  protocolVersion: SyncProtocolVersion,
): Record<string, unknown> | null {
  // Unit-test doubles and pre-v4 code paths may not include the joined columns.
  // In production a settings change always has a current ledger_settings row.
  if (typeof row.settings_id !== "string") return null;
  const payload: Record<string, unknown> = {
    id: row.settings_id,
    currency: row.settings_currency,
    initialBalanceMinor: row.settings_initial_balance_minor,
    schemaVersion: row.settings_schema_version,
    updatedAt: row.settings_updated_at,
  };
  if (protocolVersion >= 8 && row.settings_initial_balance_locked_at) {
    payload.initialBalanceLockedAt = row.settings_initial_balance_locked_at;
  }
  if (row.settings_month_end_balance_goal_minor !== null &&
      row.settings_month_end_balance_goal_minor !== undefined) {
    payload.monthEndBalanceGoalMinor = row.settings_month_end_balance_goal_minor;
  }
  if (protocolVersion >= 7 &&
      row.settings_payday_day !== null && row.settings_payday_day !== undefined) {
    payload.payCycle = { paydayDay: row.settings_payday_day };
  } else if (protocolVersion >= 6 &&
      row.settings_payday_day !== null && row.settings_payday_day !== undefined &&
      (row.settings_default_savings_target_minor !== null &&
        row.settings_default_savings_target_minor !== undefined)) {
    payload.payCycle = {
      paydayDay: row.settings_payday_day,
      defaultSavingsTargetMinor: row.settings_default_savings_target_minor,
    };
  } else if (row.settings_payday_day !== null && row.settings_payday_day !== undefined &&
      row.settings_cycle_end_balance_goal_minor !== null &&
      row.settings_cycle_end_balance_goal_minor !== undefined) {
    payload.payCycle = {
      paydayDay: row.settings_payday_day,
      cycleEndBalanceGoalMinor: row.settings_cycle_end_balance_goal_minor,
    };
  }
  const hasForecast = row.settings_income_forecast_id !== null &&
    row.settings_income_forecast_id !== undefined;
  if (hasForecast) {
    const forecast: Record<string, unknown> = {
      id: row.settings_income_forecast_id,
      targetPaydayDateKey: row.settings_income_forecast_target_payday_date_key,
      expectedIncomeMinor: row.settings_expected_income_minor,
    };
    if (protocolVersion < 7) {
      forecast.minimumIncomeMinor = row.settings_minimum_income_minor ??
        row.settings_expected_income_minor;
    }
    payload.incomeForecast = forecast;
  }
  if (row.settings_savings_override_target_payday_date_key !== null &&
      row.settings_savings_override_target_payday_date_key !== undefined &&
      row.settings_savings_override_target_minor !== null &&
      row.settings_savings_override_target_minor !== undefined) {
    payload.savingsTargetOverride = {
      targetPaydayDateKey: row.settings_savings_override_target_payday_date_key,
      targetMinor: row.settings_savings_override_target_minor,
    };
  }
  if (row.settings_monthly_salary_minor !== null &&
      row.settings_monthly_salary_minor !== undefined) {
    payload._legacyMonthlySalaryMinor = row.settings_monthly_salary_minor;
  }
  if (protocolVersion >= 7 &&
      row.settings_savings_goal_target_date_key !== null &&
      row.settings_savings_goal_target_date_key !== undefined &&
      row.settings_savings_goal_target_minor !== null &&
      row.settings_savings_goal_target_minor !== undefined) {
    payload.savingsGoal = {
      targetDateKey: row.settings_savings_goal_target_date_key,
      targetMinor: row.settings_savings_goal_target_minor,
    };
  }
  if (protocolVersion >= 7 &&
      row.settings_last_expected_income_minor !== null &&
      row.settings_last_expected_income_minor !== undefined) {
    payload.lastExpectedIncomeMinor = row.settings_last_expected_income_minor;
  }
  if (protocolVersion >= 7 && row.settings_savings_goal_needs_setup === 1) {
    payload.savingsGoalNeedsSetup = true;
  }
  return payload;
}

/**
 * Settings changes written before v4 contain the old salary inside payCycle.
 * Normalize every stored shape here so a full protocol refresh never exposes a
 * stale v3 payload as canonical v4 settings.
 */
function projectSettingsPayload(
  value: unknown,
  protocolVersion: SyncProtocolVersion,
): SyncAppSettingsPayload | LegacyAppSettingsPayload {
  if (!isRecord(value)) throw new Error("Stored settings payload is invalid");
  const base: SyncAppSettingsPayload = {
    id: value.id as "primary",
    currency: value.currency as "CNY",
    initialBalanceMinor: value.initialBalanceMinor as number,
    schemaVersion: value.schemaVersion as 1,
    updatedAt: value.updatedAt as string,
  };
  if (protocolVersion >= 8 && typeof value.initialBalanceLockedAt === "string") {
    base.initialBalanceLockedAt = value.initialBalanceLockedAt;
  }
  if (protocolVersion >= 2 && protocolVersion < 7 &&
      value.monthEndBalanceGoalMinor !== undefined) {
    base.monthEndBalanceGoalMinor = value.monthEndBalanceGoalMinor as number;
  }

  const storedCycle = isRecord(value.payCycle) ? value.payCycle : undefined;
  const paydayDay = storedCycle && Number.isInteger(storedCycle.paydayDay)
    ? Number(storedCycle.paydayDay)
    : undefined;
  const storedLegacyGoal = storedCycle && Number.isSafeInteger(
    storedCycle.cycleEndBalanceGoalMinor,
  )
    ? Number(storedCycle.cycleEndBalanceGoalMinor)
    : storedCycle && Number.isSafeInteger(storedCycle.defaultSavingsTargetMinor)
      ? Number(storedCycle.defaultSavingsTargetMinor)
      : undefined;
  const legacyCycle = paydayDay !== undefined && storedLegacyGoal !== undefined
    ? {
        paydayDay,
        cycleEndBalanceGoalMinor: storedLegacyGoal,
      }
    : undefined;
  const targetFromStored = storedCycle && Number.isSafeInteger(storedCycle.defaultSavingsTargetMinor)
    ? Number(storedCycle.defaultSavingsTargetMinor)
    : legacyCycle
      ? Math.max(legacyCycle.cycleEndBalanceGoalMinor, 0)
      : undefined;
  const v6Cycle = paydayDay !== undefined && targetFromStored !== undefined
    ? {
        paydayDay,
        defaultSavingsTargetMinor: targetFromStored,
      }
    : undefined;
  const forecast = isRecord(value.incomeForecast)
    ? value.incomeForecast as unknown as IncomeForecastPayload
    : undefined;

  const hasLegacySalary = Object.hasOwn(value, "_legacyMonthlySalaryMinor");
  const legacySalary = hasLegacySalary
    ? value._legacyMonthlySalaryMinor
    : storedCycle?.monthlySalaryMinor;

  if (protocolVersion === 3 && legacyCycle) {
    if (Number.isSafeInteger(legacySalary) && Number(legacySalary) > 0) {
      (base as LegacyAppSettingsPayload).payCycle = {
        ...legacyCycle,
        monthlySalaryMinor: Number(legacySalary),
      } satisfies LegacyPayCyclePlanPayload;
    }
  }

  if (protocolVersion >= 4 && protocolVersion < 6) {
    if (legacyCycle) (base as unknown as Record<string, unknown>).payCycle = legacyCycle;
    if (forecast) {
      base.incomeForecast = {
        ...forecast,
        minimumIncomeMinor: forecast.minimumIncomeMinor ?? forecast.expectedIncomeMinor,
      };
    }
    if (!forecast && Number.isSafeInteger(legacySalary) && Number(legacySalary) > 0) {
      base._legacyMonthlySalaryMinor = Number(legacySalary);
    }
  }
  if (protocolVersion === 6) {
    if (v6Cycle) base.payCycle = v6Cycle;
    if (forecast) {
      base.incomeForecast = {
        ...forecast,
        minimumIncomeMinor: forecast.minimumIncomeMinor ?? forecast.expectedIncomeMinor,
      };
    }
    if (isRecord(value.savingsTargetOverride)) {
      base.savingsTargetOverride = {
        targetPaydayDateKey: value.savingsTargetOverride.targetPaydayDateKey as string,
        targetMinor: value.savingsTargetOverride.targetMinor as number,
      };
    }
  }
  if (protocolVersion >= 7) {
    if (paydayDay !== undefined) base.payCycle = { paydayDay };
    if (forecast) {
      base.incomeForecast = {
        id: forecast.id,
        targetPaydayDateKey: forecast.targetPaydayDateKey,
        expectedIncomeMinor: forecast.expectedIncomeMinor,
      };
    }
    if (!forecast && Number.isSafeInteger(legacySalary) && Number(legacySalary) > 0) {
      base._legacyMonthlySalaryMinor = Number(legacySalary);
    }
    if (isRecord(value.savingsGoal)) {
      base.savingsGoal = {
        targetDateKey: value.savingsGoal.targetDateKey as string,
        targetMinor: value.savingsGoal.targetMinor as number,
      } satisfies SavingsGoalPayload;
    }
    if (Number.isSafeInteger(value.lastExpectedIncomeMinor)) {
      base.lastExpectedIncomeMinor = Number(value.lastExpectedIncomeMinor);
    }
    if (value.savingsGoalNeedsSetup === true) base.savingsGoalNeedsSetup = true;
    // Payloads produced before v7 did not carry a migration marker. Preserve
    // the payday, but never turn an old per-cycle amount into a cumulative goal.
    if (!base.savingsGoal && targetFromStored !== undefined && targetFromStored !== 0) {
      base.savingsGoalNeedsSetup = true;
    }
  }
  return base;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export async function syncMutationHash(mutation: SyncMutation): Promise<string> {
  const canonical = canonicalJson({
    baseVersion: mutation.baseVersion,
    entityId: mutation.entityId,
    entityType: mutation.entityType,
    payload: mutation.payload,
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function mutationMatchesRow(mutation: SyncMutation, row: ChangeRow): Promise<boolean> {
  return mutation.entityType === row.entity_type &&
    mutation.entityId === row.entity_id &&
    await syncMutationHash(mutation) === row.mutation_hash;
}

function changeFromRow(
  row: ChangeRow,
  protocolVersion: SyncProtocolVersion,
): RemoteChange {
  if (
    row.entity_type !== "entry" &&
    row.entity_type !== "settings" &&
    row.entity_type !== "recoveryAllocation" &&
    row.entity_type !== "savingsEvent" &&
    row.entity_type !== "balanceAdjustment"
  ) {
    throw new Error("Stored sync entity type is invalid");
  }
  return {
    seq: row.cursor,
    entityType: row.entity_type,
    entityId: row.entity_id,
    version: row.entity_version,
    payload: payloadFromRow(row, protocolVersion),
  };
}

async function findMutation(
  db: D1Database,
  userId: string,
  generation: number,
  mutationId: string,
): Promise<ChangeRow | null> {
  return db
    .prepare(
      `SELECT CAST(seq AS TEXT) AS cursor, mutation_id, entity_type, entity_id,
              entity_version, mutation_hash, payload_json
       FROM sync_changes
       WHERE user_id = ? AND account_generation = ? AND mutation_id = ?
       LIMIT 1`,
    )
    .bind(userId, generation, mutationId)
    .first<ChangeRow>();
}

async function latestRemoteChange(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: SyncMutation,
  protocolVersion: SyncProtocolVersion,
): Promise<RemoteChange> {
  const row = await db
    .prepare(
      `SELECT CAST(current_change.seq AS TEXT) AS cursor,
              current_change.mutation_id,
              current_change.entity_type,
              current_change.entity_id,
              current_change.entity_version,
              current_change.mutation_hash,
              current_change.payload_json,
              ${SETTINGS_PROJECTION_COLUMNS},
              ${ENTRY_PROJECTION_COLUMNS},
              ${SAVINGS_PROJECTION_COLUMNS},
              ${ADJUSTMENT_PROJECTION_COLUMNS}
       FROM sync_changes AS current_change
       ${SETTINGS_PROJECTION_JOIN}
       ${ENTRY_PROJECTION_JOIN}
       ${SAVINGS_PROJECTION_JOIN}
       ${ADJUSTMENT_PROJECTION_JOIN}
       WHERE current_change.user_id = ?
         AND current_change.account_generation = ?
         AND current_change.entity_type = ?
         AND current_change.entity_id = ?
       ORDER BY current_change.seq DESC
       LIMIT 1`,
    )
    .bind(userId, generation, mutation.entityType, mutation.entityId)
    .first<ChangeRow>();
  if (!row) {
    throw new ApiError(409, "remote_entity_missing", "Remote entity no longer exists");
  }
  return changeFromRow(row, protocolVersion);
}

export async function assertMutationIdsReusable(
  db: D1Database,
  userId: string,
  generation: number,
  mutations: SyncMutation[],
): Promise<Set<string>> {
  if (!mutations.length) return new Set();
  const placeholders = mutations.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT CAST(seq AS TEXT) AS cursor, mutation_id, entity_type, entity_id,
              entity_version, mutation_hash, payload_json
       FROM sync_changes
       WHERE user_id = ? AND account_generation = ?
         AND mutation_id IN (${placeholders})`,
    )
    .bind(userId, generation, ...mutations.map((mutation) => mutation.id))
    .all<ChangeRow>();
  const requestedById = new Map(mutations.map((mutation) => [mutation.id, mutation]));
  const existingIds = new Set<string>();
  for (const row of result.results) {
    const requested = requestedById.get(row.mutation_id);
    if (!requested || !(await mutationMatchesRow(requested, row))) {
      throw new ApiError(
        409,
        "mutation_id_reused",
        "A mutation ID was already used for another request",
      );
    }
    existingIds.add(row.mutation_id);
  }
  return existingIds;
}

export async function assertAttachmentsReady(
  db: D1Database,
  userId: string,
  generation: number,
  mutations: SyncMutation[],
): Promise<void> {
  const references = mutations.flatMap((mutation) => {
    if (mutation.entityType !== "entry") return [];
    const payload = mutation.payload as LedgerEntryPayload;
    return payload.attachmentId
      ? [{ attachmentId: payload.attachmentId, entryId: payload.id }]
      : [];
  });
  if (!references.length) return;

  const uniqueIds = [...new Set(references.map((reference) => reference.attachmentId))];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT id, entry_id, status,
              CASE WHEN EXISTS (
                SELECT 1 FROM attachment_cleanup q
                WHERE q.user_id = attachments.user_id
                  AND q.account_generation = attachments.account_generation
                  AND q.attachment_id = attachments.id
                  AND q.r2_key = attachments.r2_key
              ) THEN 1 ELSE 0 END AS cleanup_pending
       FROM attachments
       WHERE user_id = ? AND account_generation = ?
         AND id IN (${placeholders})`,
    )
    .bind(userId, generation, ...uniqueIds)
    .all<{ id: string; entry_id: string; status: string; cleanup_pending: number }>();
  const byId = new Map(result.results.map((row) => [row.id, row]));
  for (const reference of references) {
    const row = byId.get(reference.attachmentId);
    if (
      !row ||
      row.status !== "ready" ||
      row.entry_id !== reference.entryId ||
      row.cleanup_pending === 1
    ) {
      throw new ApiError(
        409,
        "attachment_not_ready",
        "Referenced attachment has not been uploaded for this entry",
      );
    }
  }
}

export function minimizeDeletedEntry(entry: LedgerEntryPayload): LedgerEntryPayload {
  if (!entry.deletedAt) return entry;
  return {
    id: entry.id,
    amountMinor: 1,
    note: "",
    occurredAt: entry.deletedAt,
    localDateKey: entry.deletedAt.slice(0, 10),
    localMonthKey: entry.deletedAt.slice(0, 7),
    timezoneOffsetMinutes: 0,
    treatment: "ordinary_income",
    confirmationStatus: "not_needed",
    createdAt: entry.deletedAt,
    updatedAt: entry.deletedAt,
    deletedAt: entry.deletedAt,
  };
}

async function writeEntry(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: SyncMutation,
): Promise<VersionRow | null> {
  const requestedEntry = mutation.payload as LedgerEntryPayload;
  const entry = minimizeDeletedEntry(requestedEntry);
  const now = new Date().toISOString();
  const mutationHash = await syncMutationHash(mutation);
  const treatment = entry.treatment ??
    (entry.amountMinor < 0 ? "ordinary_expense" : "ordinary_income");
  const confirmationStatus = entry.confirmationStatus ?? "not_needed";
  const values = [
    entry.amountMinor,
    entry.note,
    entry.occurredAt,
    entry.localDateKey,
    entry.localMonthKey,
    entry.timezoneOffsetMinutes,
    entry.attachmentId ?? null,
    treatment,
    confirmationStatus,
    entry.detectionRuleVersion ?? null,
    entry.promptedRevision ?? null,
    entry.createdAt,
    entry.updatedAt,
    entry.deletedAt ?? null,
  ] as const;
  if (mutation.baseVersion === 0) {
    return db
      .prepare(
         `INSERT INTO ledger_entries (
           user_id, account_generation, id, amount_minor, note, occurred_at, local_date_key,
           local_month_key, timezone_offset_minutes, attachment_id, treatment,
           confirmation_status, detection_rule_version, prompted_revision, created_at,
           updated_at, deleted_at, version, last_mutation_id,
           last_mutation_hash, server_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(user_id, id) DO NOTHING
         RETURNING version`,
      )
      .bind(userId, generation, entry.id, ...values, mutation.id, mutationHash, now)
      .first<VersionRow>();
  }
  return db
    .prepare(
      `UPDATE ledger_entries SET
         amount_minor = ?, note = ?, occurred_at = ?, local_date_key = ?,
         local_month_key = ?, timezone_offset_minutes = ?, attachment_id = ?,
         treatment = ?, confirmation_status = ?, detection_rule_version = ?,
         prompted_revision = ?, created_at = ?, updated_at = ?, deleted_at = ?,
         version = version + 1,
         last_mutation_id = ?, last_mutation_hash = ?, server_updated_at = ?
       WHERE user_id = ? AND account_generation = ?
         AND id = ? AND version = ? AND last_mutation_id <> ?
       RETURNING version`,
    )
    .bind(
      ...values,
      mutation.id,
      mutationHash,
      now,
      userId,
      generation,
      entry.id,
      mutation.baseVersion,
      mutation.id,
    )
    .first<VersionRow>();
}

async function writeRecoveryAllocation(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: SyncMutation,
): Promise<VersionRow | null> {
  const allocation = mutation.payload as RecoveryAllocationPayload;
  const now = new Date().toISOString();
  const mutationHash = await syncMutationHash(mutation);
  const values = [
    allocation.refundEntryId,
    allocation.expenseEntryId,
    allocation.amountMinor,
    allocation.createdAt,
    allocation.updatedAt,
    allocation.deletedAt ?? null,
  ] as const;
  if (mutation.baseVersion === 0) {
    return db
      .prepare(
        `INSERT INTO recovery_allocations (
           user_id, account_generation, id, refund_entry_id, expense_entry_id,
           amount_minor, created_at, updated_at, deleted_at, version,
           last_mutation_id, last_mutation_hash, server_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(user_id, id) DO NOTHING
         RETURNING version`,
      )
      .bind(userId, generation, allocation.id, ...values, mutation.id, mutationHash, now)
      .first<VersionRow>();
  }
  return db
    .prepare(
      `UPDATE recovery_allocations SET
         refund_entry_id = ?, expense_entry_id = ?, amount_minor = ?,
         created_at = ?, updated_at = ?, deleted_at = ?, version = version + 1,
         last_mutation_id = ?, last_mutation_hash = ?, server_updated_at = ?
       WHERE user_id = ? AND account_generation = ? AND id = ? AND version = ?
         AND last_mutation_id <> ?
       RETURNING version`,
    )
    .bind(
      ...values,
      mutation.id,
      mutationHash,
      now,
      userId,
      generation,
      allocation.id,
      mutation.baseVersion,
      mutation.id,
    )
    .first<VersionRow>();
}

async function writeSavingsEvent(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: SyncMutation,
): Promise<VersionRow | null> {
  const event = mutation.payload as SavingsEventPayload;
  const now = new Date().toISOString();
  const mutationHash = await syncMutationHash(mutation);
  const values = [
    event.kind,
    event.amountMinor,
    event.note,
    event.occurredAt,
    event.localDateKey,
    event.localMonthKey,
    event.timezoneOffsetMinutes,
    event.linkedExpenseEntryId ?? null,
    event.cycleStartDateKey ?? null,
    event.cycleEndDateKey ?? null,
    event.goalMinorSnapshot ?? null,
    event.openingRetainedMinor ?? null,
    event.closingRetainedMinor ?? null,
    event.netGrowthMinor ?? null,
    event.createdAt,
    event.updatedAt,
    event.deletedAt ?? null,
  ] as const;
  if (mutation.baseVersion === 0) {
    return db
      .prepare(
        `INSERT INTO savings_events (
           user_id, account_generation, id, kind, amount_minor, note,
           occurred_at, local_date_key, local_month_key, timezone_offset_minutes,
           linked_expense_entry_id, cycle_start_date_key, cycle_end_date_key,
           goal_minor_snapshot, opening_retained_minor, closing_retained_minor,
           net_growth_minor, created_at, updated_at, deleted_at, version,
           last_mutation_id, last_mutation_hash, server_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(user_id, id) DO NOTHING
         RETURNING version`,
      )
      .bind(userId, generation, event.id, ...values, mutation.id, mutationHash, now)
      .first<VersionRow>();
  }
  return db
    .prepare(
      `UPDATE savings_events SET
         kind = ?, amount_minor = ?, note = ?, occurred_at = ?,
         local_date_key = ?, local_month_key = ?, timezone_offset_minutes = ?,
         linked_expense_entry_id = ?, cycle_start_date_key = ?, cycle_end_date_key = ?,
         goal_minor_snapshot = ?, opening_retained_minor = ?,
         closing_retained_minor = ?, net_growth_minor = ?, created_at = ?,
         updated_at = ?, deleted_at = ?, version = version + 1,
         last_mutation_id = ?, last_mutation_hash = ?, server_updated_at = ?
       WHERE user_id = ? AND account_generation = ? AND id = ? AND version = ?
         AND last_mutation_id <> ?
       RETURNING version`,
    )
    .bind(
      ...values,
      mutation.id,
      mutationHash,
      now,
      userId,
      generation,
      event.id,
      mutation.baseVersion,
      mutation.id,
    )
    .first<VersionRow>();
}

async function writeBalanceAdjustment(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: Extract<SyncMutation, { entityType: "balanceAdjustment" }>,
): Promise<VersionRow | null> {
  const adjustment = mutation.payload;
  const now = new Date().toISOString();
  const mutationHash = await syncMutationHash(mutation);
  const values = [
    adjustment.kind,
    adjustment.amountMinor,
    adjustment.note,
    adjustment.occurredAt,
    adjustment.localDateKey,
    adjustment.localMonthKey,
    adjustment.timezoneOffsetMinutes,
    adjustment.kind === "reconciliation" ? adjustment.balanceBeforeMinor : null,
    adjustment.kind === "reconciliation" ? adjustment.observedBalanceMinor : null,
    adjustment.kind === "opening_correction" ? adjustment.previousOpeningMinor : null,
    adjustment.kind === "opening_correction" ? adjustment.nextOpeningMinor : null,
    adjustment.createdAt,
    adjustment.updatedAt,
    adjustment.deletedAt ?? null,
  ] as const;
  if (mutation.baseVersion === 0) {
    return db.prepare(
      `INSERT INTO balance_adjustments (
         user_id, account_generation, id, kind, amount_minor, note,
         occurred_at, local_date_key, local_month_key, timezone_offset_minutes,
         balance_before_minor, observed_balance_minor, previous_opening_minor,
         next_opening_minor, created_at, updated_at, deleted_at, version,
         last_mutation_id, last_mutation_hash, server_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(user_id, id) DO NOTHING
       RETURNING version`,
    ).bind(
      userId,
      generation,
      adjustment.id,
      ...values,
      mutation.id,
      mutationHash,
      now,
    ).first<VersionRow>();
  }
  return db.prepare(
    `UPDATE balance_adjustments SET
       deleted_at = ?, updated_at = ?, version = version + 1,
       last_mutation_id = ?, last_mutation_hash = ?, server_updated_at = ?
     WHERE user_id = ? AND account_generation = ? AND id = ? AND version = ?
       AND last_mutation_id <> ?
       AND kind = ? AND amount_minor = ? AND note = ? AND occurred_at = ?
       AND local_date_key = ? AND local_month_key = ?
       AND timezone_offset_minutes = ?
       AND balance_before_minor IS ? AND observed_balance_minor IS ?
       AND previous_opening_minor IS ? AND next_opening_minor IS ?
       AND created_at = ?
       AND deleted_at IS NULL AND ? IS NOT NULL
     RETURNING version`,
  ).bind(
    adjustment.deletedAt ?? null,
    adjustment.updatedAt,
    mutation.id,
    mutationHash,
    now,
    userId,
    generation,
    adjustment.id,
    mutation.baseVersion,
    mutation.id,
    adjustment.kind,
    adjustment.amountMinor,
    adjustment.note,
    adjustment.occurredAt,
    adjustment.localDateKey,
    adjustment.localMonthKey,
    adjustment.timezoneOffsetMinutes,
    adjustment.kind === "reconciliation" ? adjustment.balanceBeforeMinor : null,
    adjustment.kind === "reconciliation" ? adjustment.observedBalanceMinor : null,
    adjustment.kind === "opening_correction" ? adjustment.previousOpeningMinor : null,
    adjustment.kind === "opening_correction" ? adjustment.nextOpeningMinor : null,
    adjustment.createdAt,
    adjustment.deletedAt ?? null,
  ).first<VersionRow>();
}

async function prepareSettingsV7Write(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: SyncMutation,
  requiredConfirmationId?: string,
): Promise<D1PreparedStatement> {
  const settings = mutation.payload as SettingsMutationPayload;
  const now = new Date().toISOString();
  const mutationHash = await syncMutationHash(mutation);
  const writesPayCycle = Object.prototype.hasOwnProperty.call(settings, "payCycle");
  const payCycle = settings.payCycle ?? null;
  const writesForecast = Object.prototype.hasOwnProperty.call(settings, "incomeForecast");
  const incomeForecast = settings.incomeForecast ?? null;
  const writesSavingsGoal = Object.prototype.hasOwnProperty.call(settings, "savingsGoal");
  const savingsGoal = settings.savingsGoal ?? null;
  const writesLastExpected = Object.prototype.hasOwnProperty.call(
    settings,
    "lastExpectedIncomeMinor",
  );
  const writesNeedsSetup = Object.prototype.hasOwnProperty.call(
    settings,
    "savingsGoalNeedsSetup",
  );
  const compatibilitySalary = incomeForecast && incomeForecast.expectedIncomeMinor > 0
    ? incomeForecast.expectedIncomeMinor
    : null;
  const compatibilityCycleTarget = payCycle ? 0 : null;
  const needsSetup = settings.savingsGoalNeedsSetup === true ? 1 : 0;

  if (mutation.baseVersion === 0) {
    return db
      .prepare(
        `INSERT INTO ledger_settings (
           user_id, account_generation, id, currency, initial_balance_minor,
           payday_day, monthly_salary_minor, cycle_end_balance_goal_minor,
           income_forecast_id, income_forecast_target_payday_date_key,
           minimum_income_minor, expected_income_minor,
           default_savings_target_minor, savings_goal_target_date_key,
           savings_goal_target_minor, last_expected_income_minor,
           savings_goal_needs_setup, initial_balance_locked_at,
           schema_version, updated_at, version,
           last_mutation_id, last_mutation_hash, server_updated_at
         ) SELECT ?, ?, 'primary', 'CNY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?
         WHERE ? IS NULL OR EXISTS (
           SELECT 1 FROM income_confirmations
           WHERE user_id = ? AND account_generation = ? AND confirmation_id = ?
         )
         ON CONFLICT(user_id) DO NOTHING
         RETURNING version`,
      )
      .bind(
        userId,
        generation,
        settings.initialBalanceMinor,
        payCycle?.paydayDay ?? null,
        compatibilitySalary,
        compatibilityCycleTarget,
        incomeForecast?.id ?? null,
        incomeForecast?.targetPaydayDateKey ?? null,
        incomeForecast?.expectedIncomeMinor ?? null,
        incomeForecast?.expectedIncomeMinor ?? null,
        compatibilityCycleTarget,
        savingsGoal?.targetDateKey ?? null,
        savingsGoal?.targetMinor ?? null,
        settings.lastExpectedIncomeMinor ?? null,
        savingsGoal ? 0 : needsSetup,
        settings.initialBalanceLockedAt ?? null,
        settings.updatedAt,
        mutation.id,
        mutationHash,
        now,
        requiredConfirmationId ?? null,
        userId,
        generation,
        requiredConfirmationId ?? null,
      )
      ;
  }

  const normalizesLegacyPlanning = writesPayCycle || writesSavingsGoal;
  return db
    .prepare(
      `UPDATE ledger_settings SET
         currency = 'CNY', initial_balance_minor = ?,
         initial_balance_locked_at = CASE
           WHEN initial_balance_locked_at IS NOT NULL THEN initial_balance_locked_at
           ELSE ? END,
         payday_day = CASE WHEN ? = 1 THEN ? ELSE payday_day END,
         monthly_salary_minor = CASE
           WHEN ? = 1 THEN ?
           WHEN ? = 1 AND ? IS NULL THEN NULL
           ELSE monthly_salary_minor END,
         cycle_end_balance_goal_minor = CASE
           WHEN ? = 1 THEN CASE WHEN ? IS NULL THEN NULL ELSE 0 END
           WHEN ? = 1 THEN CASE WHEN payday_day IS NULL THEN NULL ELSE 0 END
           ELSE cycle_end_balance_goal_minor END,
         default_savings_target_minor = CASE
           WHEN ? = 1 THEN CASE WHEN ? IS NULL THEN NULL ELSE 0 END
           WHEN ? = 1 THEN CASE WHEN payday_day IS NULL THEN NULL ELSE 0 END
           ELSE default_savings_target_minor END,
         savings_override_target_payday_date_key = CASE WHEN ? = 1 THEN NULL
           ELSE savings_override_target_payday_date_key END,
         savings_override_target_minor = CASE WHEN ? = 1 THEN NULL
           ELSE savings_override_target_minor END,
         income_forecast_id = CASE WHEN ? = 1 THEN ? ELSE income_forecast_id END,
         income_forecast_target_payday_date_key = CASE WHEN ? = 1 THEN ?
           ELSE income_forecast_target_payday_date_key END,
         minimum_income_minor = CASE WHEN ? = 1 THEN ? ELSE minimum_income_minor END,
         expected_income_minor = CASE WHEN ? = 1 THEN ? ELSE expected_income_minor END,
         savings_goal_target_date_key = CASE WHEN ? = 1 THEN ?
           ELSE savings_goal_target_date_key END,
         savings_goal_target_minor = CASE WHEN ? = 1 THEN ?
           ELSE savings_goal_target_minor END,
         last_expected_income_minor = CASE WHEN ? = 1 THEN ?
           ELSE last_expected_income_minor END,
         savings_goal_needs_setup = CASE
           WHEN ? = 1 AND ? IS NOT NULL THEN 0
           WHEN ? = 1 THEN ?
           ELSE savings_goal_needs_setup END,
         schema_version = 1, updated_at = ?, version = version + 1,
         last_mutation_id = ?, last_mutation_hash = ?, server_updated_at = ?
       WHERE user_id = ? AND account_generation = ?
          AND version = ? AND last_mutation_id <> ?
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM income_confirmations
            WHERE user_id = ? AND account_generation = ? AND confirmation_id = ?
          ))
        RETURNING version`,
    )
    .bind(
      settings.initialBalanceMinor,
      settings.initialBalanceLockedAt ?? null,
      writesPayCycle ? 1 : 0,
      payCycle?.paydayDay ?? null,
      writesForecast ? 1 : 0,
      compatibilitySalary,
      writesPayCycle ? 1 : 0,
      payCycle?.paydayDay ?? null,
      writesPayCycle ? 1 : 0,
      payCycle?.paydayDay ?? null,
      writesSavingsGoal ? 1 : 0,
      writesPayCycle ? 1 : 0,
      payCycle?.paydayDay ?? null,
      writesSavingsGoal ? 1 : 0,
      normalizesLegacyPlanning ? 1 : 0,
      normalizesLegacyPlanning ? 1 : 0,
      writesForecast ? 1 : 0,
      incomeForecast?.id ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.targetPaydayDateKey ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.expectedIncomeMinor ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.expectedIncomeMinor ?? null,
      writesSavingsGoal ? 1 : 0,
      savingsGoal?.targetDateKey ?? null,
      writesSavingsGoal ? 1 : 0,
      savingsGoal?.targetMinor ?? null,
      writesLastExpected ? 1 : 0,
      settings.lastExpectedIncomeMinor ?? null,
      writesSavingsGoal ? 1 : 0,
      savingsGoal?.targetDateKey ?? null,
      writesNeedsSetup ? 1 : 0,
      needsSetup,
      settings.updatedAt,
      mutation.id,
      mutationHash,
      now,
      userId,
      generation,
      mutation.baseVersion,
      mutation.id,
      requiredConfirmationId ?? null,
      userId,
      generation,
      requiredConfirmationId ?? null,
    )
    ;
}

async function writeSettingsV7(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: SyncMutation,
): Promise<VersionRow | null> {
  return (await prepareSettingsV7Write(db, userId, generation, mutation)).first<VersionRow>();
}

async function writeSettings(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: SyncMutation,
  protocolVersion: SyncProtocolVersion,
): Promise<VersionRow | null> {
  if (protocolVersion >= 7) {
    return writeSettingsV7(db, userId, generation, mutation);
  }
  const settings = mutation.payload as SettingsMutationPayload;
  const now = new Date().toISOString();
  const mutationHash = await syncMutationHash(mutation);
  const writesGoal = protocolVersion >= 2 &&
    Object.prototype.hasOwnProperty.call(settings, "monthEndBalanceGoalMinor");
  const writesPayCycle = protocolVersion >= 3 &&
    Object.prototype.hasOwnProperty.call(settings, "payCycle");
  const payCycle = settings.payCycle ?? null;
  const writesForecast = protocolVersion >= 4 &&
    Object.prototype.hasOwnProperty.call(settings, "incomeForecast");
  const incomeForecast = settings.incomeForecast ?? null;
  const writesSavingsOverride = protocolVersion >= 6 &&
    Object.prototype.hasOwnProperty.call(settings, "savingsTargetOverride");
  const savingsTargetOverride = settings.savingsTargetOverride ?? null;
  const writesCanonicalSavingsPlan = protocolVersion >= 6 && writesPayCycle;
  const clearsCompatibilitySavingsPlan = protocolVersion >= 4 &&
    protocolVersion < 6 && writesPayCycle && payCycle === null;
  const writesSavingsPlanColumn = writesCanonicalSavingsPlan ||
    clearsCompatibilitySavingsPlan;
  const legacyPayCycle = protocolVersion === 3 && payCycle
    ? payCycle as LegacyPayCyclePlanPayload
    : null;
  const legacyCycleGoal = payCycle && "cycleEndBalanceGoalMinor" in payCycle
    ? payCycle.cycleEndBalanceGoalMinor
    : null;
  const canonicalSavingsTarget = payCycle && "defaultSavingsTargetMinor" in payCycle
    ? payCycle.defaultSavingsTargetMinor
    : null;
  const writesCompatibilitySalary = (protocolVersion === 3 && writesPayCycle) ||
    writesForecast ||
    (protocolVersion >= 4 && writesPayCycle && payCycle === null);
  const compatibilitySalary = protocolVersion === 3
    ? legacyPayCycle?.monthlySalaryMinor ?? null
    : incomeForecast && incomeForecast.expectedIncomeMinor > 0
      ? incomeForecast.expectedIncomeMinor
      : null;
  const suppliesPayCycle = writesPayCycle && payCycle !== null;
  if (mutation.baseVersion === 0) {
    return db
      .prepare(
        `INSERT INTO ledger_settings (
           user_id, account_generation, id, currency, initial_balance_minor,
           month_end_balance_goal_minor, payday_day, monthly_salary_minor,
           cycle_end_balance_goal_minor, income_forecast_id,
           income_forecast_target_payday_date_key, minimum_income_minor,
           expected_income_minor, default_savings_target_minor,
           savings_override_target_payday_date_key, savings_override_target_minor,
           schema_version, updated_at, version,
           last_mutation_id, last_mutation_hash, server_updated_at
         ) VALUES (?, ?, 'primary', 'CNY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?)
         ON CONFLICT(user_id) DO NOTHING
         RETURNING version`,
      )
      .bind(
        userId,
        generation,
        settings.initialBalanceMinor,
        writesGoal ? settings.monthEndBalanceGoalMinor ?? null : null,
        writesPayCycle ? payCycle?.paydayDay ?? null : null,
        writesCompatibilitySalary ? compatibilitySalary : null,
        writesPayCycle ? legacyCycleGoal ?? canonicalSavingsTarget ?? null : null,
        writesForecast ? incomeForecast?.id ?? null : null,
        writesForecast ? incomeForecast?.targetPaydayDateKey ?? null : null,
        writesForecast ? incomeForecast?.minimumIncomeMinor ?? null : null,
        writesForecast ? incomeForecast?.expectedIncomeMinor ?? null : null,
        writesCanonicalSavingsPlan ? canonicalSavingsTarget : null,
        writesSavingsOverride ? savingsTargetOverride?.targetPaydayDateKey ?? null : null,
        writesSavingsOverride ? savingsTargetOverride?.targetMinor ?? null : null,
        settings.updatedAt,
        mutation.id,
        mutationHash,
        now,
      )
      .first<VersionRow>();
  }
  return db
    .prepare(
      `UPDATE ledger_settings SET
         currency = 'CNY', initial_balance_minor = ?,
         month_end_balance_goal_minor = CASE WHEN ? = 1 THEN ?
           ELSE month_end_balance_goal_minor END,
         payday_day = CASE
           WHEN ? = 1 AND (? = 1 OR ? IS NOT NULL
             OR default_savings_target_minor IS NULL) THEN ?
           ELSE payday_day END,
         monthly_salary_minor = CASE
           WHEN ? = 1 AND (? IS NULL OR ? = 1 OR payday_day IS NOT NULL) THEN ?
           ELSE monthly_salary_minor END,
         cycle_end_balance_goal_minor = CASE WHEN ? = 1 THEN ?
           ELSE cycle_end_balance_goal_minor END,
         income_forecast_id = CASE WHEN ? = 1 THEN ? ELSE income_forecast_id END,
         income_forecast_target_payday_date_key = CASE WHEN ? = 1 THEN ?
           ELSE income_forecast_target_payday_date_key END,
         minimum_income_minor = CASE WHEN ? = 1 THEN ? ELSE minimum_income_minor END,
         expected_income_minor = CASE WHEN ? = 1 THEN ? ELSE expected_income_minor END,
         default_savings_target_minor = CASE WHEN ? = 1 THEN ?
           ELSE default_savings_target_minor END,
         savings_override_target_payday_date_key = CASE WHEN ? = 1 THEN ?
           ELSE savings_override_target_payday_date_key END,
         savings_override_target_minor = CASE WHEN ? = 1 THEN ?
           ELSE savings_override_target_minor END,
         schema_version = 1, updated_at = ?, version = version + 1, last_mutation_id = ?,
         last_mutation_hash = ?, server_updated_at = ?
       WHERE user_id = ? AND account_generation = ?
         AND version = ? AND last_mutation_id <> ?
       RETURNING version`,
    )
    .bind(
      settings.initialBalanceMinor,
      writesGoal ? 1 : 0,
      settings.monthEndBalanceGoalMinor ?? null,
      writesPayCycle ? 1 : 0,
      protocolVersion >= 4 ? 1 : 0,
      payCycle?.paydayDay ?? null,
      payCycle?.paydayDay ?? null,
      writesCompatibilitySalary ? 1 : 0,
      compatibilitySalary,
      suppliesPayCycle ? 1 : 0,
      compatibilitySalary,
      writesPayCycle ? 1 : 0,
      legacyCycleGoal ?? canonicalSavingsTarget ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.id ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.targetPaydayDateKey ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.minimumIncomeMinor ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.expectedIncomeMinor ?? null,
      writesSavingsPlanColumn ? 1 : 0,
      canonicalSavingsTarget,
      writesSavingsOverride ? 1 : 0,
      savingsTargetOverride?.targetPaydayDateKey ?? null,
      writesSavingsOverride ? 1 : 0,
      savingsTargetOverride?.targetMinor ?? null,
      settings.updatedAt,
      mutation.id,
      mutationHash,
      now,
      userId,
      generation,
      mutation.baseVersion,
      mutation.id,
    )
    .first<VersionRow>();
}

async function assertInitialBalanceWritable(
  db: D1Database,
  userId: string,
  generation: number,
  settings: SettingsMutationPayload,
): Promise<void> {
  const current = await db.prepare(
    `SELECT initial_balance_minor, initial_balance_locked_at
     FROM ledger_settings
     WHERE user_id = ? AND account_generation = ? AND id = 'primary'`,
  ).bind(userId, generation).first<InitialBalanceLockRow>();
  if (
    current?.initial_balance_locked_at &&
    current.initial_balance_minor !== settings.initialBalanceMinor
  ) {
    throw new ApiError(
      409,
      "initial_balance_locked",
      "Initial balance is locked after the first ledger fact",
    );
  }
}

interface IncomeConfirmationRow {
  forecast_id: string;
  confirmation_id: string;
  actual_income_minor: number;
  settings_mutation_id: string;
  settings_version: number;
  entry_version?: number | null;
  entry_id?: string | null;
  entry_amount_minor?: number | null;
  entry_note?: string | null;
  entry_occurred_at?: string | null;
  entry_local_date_key?: string | null;
  entry_local_month_key?: string | null;
  entry_timezone_offset_minutes?: number | null;
  entry_attachment_id?: string | null;
  entry_treatment?: string | null;
  entry_confirmation_status?: string | null;
  entry_detection_rule_version?: number | null;
  entry_prompted_revision?: string | null;
  entry_created_at?: string | null;
  entry_updated_at?: string | null;
  entry_deleted_at?: string | null;
}

async function findIncomeConfirmation(
  db: D1Database,
  userId: string,
  generation: number,
  forecastId: string,
): Promise<IncomeConfirmationRow | null> {
  return db.prepare(
     `SELECT receipt.forecast_id, receipt.confirmation_id, receipt.actual_income_minor,
            receipt.settings_mutation_id, receipt.settings_version,
            current_entry.version AS entry_version,
            current_entry.id AS entry_id,
            current_entry.amount_minor AS entry_amount_minor,
            current_entry.note AS entry_note,
            current_entry.occurred_at AS entry_occurred_at,
            current_entry.local_date_key AS entry_local_date_key,
            current_entry.local_month_key AS entry_local_month_key,
            current_entry.timezone_offset_minutes AS entry_timezone_offset_minutes,
            current_entry.attachment_id AS entry_attachment_id,
            current_entry.treatment AS entry_treatment,
            current_entry.confirmation_status AS entry_confirmation_status,
            current_entry.detection_rule_version AS entry_detection_rule_version,
            current_entry.prompted_revision AS entry_prompted_revision,
            current_entry.created_at AS entry_created_at,
            current_entry.updated_at AS entry_updated_at,
            current_entry.deleted_at AS entry_deleted_at
     FROM income_confirmations AS receipt
     LEFT JOIN ledger_entries AS current_entry
       ON current_entry.user_id = receipt.user_id
      AND current_entry.account_generation = receipt.account_generation
      AND current_entry.id = receipt.entry_id
     WHERE receipt.user_id = ? AND receipt.account_generation = ?
       AND receipt.forecast_id = ?
     LIMIT 1`,
  ).bind(userId, generation, forecastId).first<IncomeConfirmationRow>();
}

function incomeConfirmationResult(
  mutationId: string,
  status: "applied" | "duplicate",
  row: IncomeConfirmationRow,
): Extract<MutationResult, { status: "applied" | "duplicate" }> {
  const currentEntry = entryPayloadFromRow(row as unknown as ChangeRow, 7) ?? undefined;
  if (row.actual_income_minor > 0 && (!currentEntry || !row.entry_version)) {
    throw new Error("Stored income confirmation is missing its ledger entry");
  }
  // The receipt preserves the amount originally confirmed. The ledger entry is
  // the current canonical row and may have been edited after confirmation.
  return {
    id: mutationId,
    status,
    // Rebase only across the atomic confirmation write. Later settings edits
    // must still arrive through the change feed and use normal conflict rules.
    version: row.settings_version,
    incomeConfirmation: {
      confirmationId: row.confirmation_id,
      forecastId: row.forecast_id,
      actualIncomeMinor: row.actual_income_minor,
      ...(currentEntry && row.entry_version
        ? { entry: currentEntry, entryVersion: row.entry_version }
        : {}),
    },
  };
}

async function applyIncomeConfirmationMutation(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: Extract<SyncMutation, { entityType: "settings" }>,
  confirmation: IncomeConfirmationPayload,
): Promise<MutationResult | null> {
  const existing = await findIncomeConfirmation(
    db,
    userId,
    generation,
    confirmation.forecastId,
  );
  if (existing) {
    return incomeConfirmationResult(mutation.id, "duplicate", existing);
  }

  const settingsHash = await syncMutationHash(mutation);
  const entryMutation = confirmation.entry && confirmation.entryMutationId
    ? {
        id: confirmation.entryMutationId,
        entityType: "entry" as const,
        entityId: confirmation.entry.id,
        baseVersion: 0,
        payload: confirmation.entry,
      }
    : undefined;
  const entryHash = entryMutation ? await syncMutationHash(entryMutation) : null;
  const receipt = db.prepare(
    `INSERT INTO income_confirmations (
       user_id, account_generation, forecast_id, confirmation_id,
       target_payday_date_key, expected_income_minor, actual_income_minor,
       entry_id, confirmed_at, settings_mutation_id, settings_mutation_hash,
       settings_version, entry_mutation_id, entry_mutation_hash
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (
       ? = 0 AND NOT EXISTS (
         SELECT 1 FROM ledger_settings WHERE user_id = ? AND account_generation = ?
       )
      ) OR EXISTS (
        SELECT 1 FROM ledger_settings
        WHERE user_id = ? AND account_generation = ? AND id = 'primary'
          AND version = ?
      )`,
  ).bind(
    userId,
    generation,
    confirmation.forecastId,
    confirmation.confirmationId,
    confirmation.targetPaydayDateKey,
    confirmation.expectedIncomeMinor,
    confirmation.actualIncomeMinor,
    confirmation.entry?.id ?? null,
    confirmation.confirmedAt,
    mutation.id,
    settingsHash,
    mutation.baseVersion + 1,
    confirmation.entryMutationId ?? null,
    entryHash,
    mutation.baseVersion,
    userId,
    generation,
    userId,
    generation,
    mutation.baseVersion,
  );
  const statements: D1PreparedStatement[] = [receipt];
  if (confirmation.entry && confirmation.entryMutationId && entryHash) {
    const entry = confirmation.entry;
    statements.push(db.prepare(
      `INSERT INTO ledger_entries (
         user_id, account_generation, id, amount_minor, note, occurred_at,
         local_date_key, local_month_key, timezone_offset_minutes, attachment_id,
         treatment, confirmation_status, detection_rule_version, prompted_revision,
         created_at, updated_at, deleted_at, version, last_mutation_id,
         last_mutation_hash, server_updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?
       FROM income_confirmations
       WHERE user_id = ? AND account_generation = ? AND forecast_id = ?
         AND confirmation_id = ?`,
    ).bind(
      userId,
      generation,
      entry.id,
      entry.amountMinor,
      entry.note,
      entry.occurredAt,
      entry.localDateKey,
      entry.localMonthKey,
      entry.timezoneOffsetMinutes,
      entry.treatment ?? "ordinary_income",
      entry.confirmationStatus ?? "not_needed",
      entry.detectionRuleVersion ?? null,
      entry.promptedRevision ?? null,
      entry.createdAt,
      entry.updatedAt,
      confirmation.entryMutationId,
      entryHash,
      new Date().toISOString(),
      userId,
      generation,
      confirmation.forecastId,
      confirmation.confirmationId,
    ));
  }
  statements.push(await prepareSettingsV7Write(
    db,
    userId,
    generation,
    mutation,
    confirmation.confirmationId,
  ));

  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await findIncomeConfirmation(
      db,
      userId,
      generation,
      confirmation.forecastId,
    );
    if (!raced) throw error;
  }
  const stored = await findIncomeConfirmation(
    db,
    userId,
    generation,
    confirmation.forecastId,
  );
  if (!stored) return null;
  const status = stored.settings_mutation_id === mutation.id ? "applied" : "duplicate";
  return incomeConfirmationResult(mutation.id, status, stored);
}

export async function applyMutation(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: SyncMutation,
  protocolVersion: SyncProtocolVersion = 1,
): Promise<MutationResult> {
  if (mutation.entityType === "settings") {
    await assertInitialBalanceWritable(
      db,
      userId,
      generation,
      mutation.payload,
    );
  }
  if (
    protocolVersion >= 7 &&
    mutation.entityType === "settings" &&
    mutation.payload.incomeConfirmation
  ) {
    const result = await applyIncomeConfirmationMutation(
      db,
      userId,
      generation,
      mutation,
      mutation.payload.incomeConfirmation,
    );
    if (result) return result;
    return {
      id: mutation.id,
      status: "conflict",
      remote: await latestRemoteChange(db, userId, generation, mutation, protocolVersion),
    };
  }
  const prior = await findMutation(db, userId, generation, mutation.id);
  if (prior) {
    if (!(await mutationMatchesRow(mutation, prior))) {
      throw new ApiError(
        409,
        "mutation_id_reused",
        "A mutation ID was already used for another request",
      );
    }
    return {
      id: mutation.id,
      status: "duplicate",
      version: prior.entity_version,
    };
  }

  let written: VersionRow | null;
  try {
    if (mutation.entityType === "entry") {
      written = await writeEntry(db, userId, generation, mutation);
    } else if (mutation.entityType === "recoveryAllocation") {
      written = await writeRecoveryAllocation(db, userId, generation, mutation);
    } else if (mutation.entityType === "savingsEvent") {
      written = await writeSavingsEvent(db, userId, generation, mutation);
    } else if (mutation.entityType === "balanceAdjustment") {
      written = await writeBalanceAdjustment(db, userId, generation, mutation);
    } else {
      written = await writeSettings(db, userId, generation, mutation, protocolVersion);
    }
  } catch (error) {
    const raced = await findMutation(db, userId, generation, mutation.id);
    if (raced && await mutationMatchesRow(mutation, raced)) {
      return {
        id: mutation.id,
        status: "duplicate",
        version: raced.entity_version,
      };
    }
    if (raced) {
      throw new ApiError(
        409,
        "mutation_id_reused",
        "A mutation ID was already used for another request",
      );
    }
    if (String(error).includes("initial_balance_locked")) {
      throw new ApiError(
        409,
        "initial_balance_locked",
        "Initial balance is locked after the first ledger fact",
      );
    }
    throw error;
  }
  if (written) {
    return {
      id: mutation.id,
      status: "applied",
      version: written.version,
    };
  }
  const raced = await findMutation(db, userId, generation, mutation.id);
  if (raced) {
    if (!(await mutationMatchesRow(mutation, raced))) {
      throw new ApiError(
        409,
        "mutation_id_reused",
        "A mutation ID was already used for another payload",
      );
    }
    return {
      id: mutation.id,
      status: "duplicate",
      version: raced.entity_version,
    };
  }
  return {
    id: mutation.id,
    status: "conflict",
    remote: await latestRemoteChange(
      db,
      userId,
      generation,
      mutation,
      protocolVersion,
    ),
  };
}

export async function pullChanges(
  db: D1Database,
  userId: string,
  generation: number,
  cursor: string,
  protocolVersion: SyncProtocolVersion = 1,
): Promise<{ changes: RemoteChange[]; nextCursor: string; hasMore: boolean }> {
  const result = await db
    .prepare(
      `SELECT CAST(current_change.seq AS TEXT) AS cursor,
              current_change.mutation_id,
              current_change.entity_type,
              current_change.entity_id,
              current_change.entity_version,
              current_change.mutation_hash,
              current_change.payload_json,
              ${SETTINGS_PROJECTION_COLUMNS},
              ${ENTRY_PROJECTION_COLUMNS},
              ${SAVINGS_PROJECTION_COLUMNS},
              ${ADJUSTMENT_PROJECTION_COLUMNS}
       FROM sync_changes AS current_change
       ${SETTINGS_PROJECTION_JOIN}
       ${ENTRY_PROJECTION_JOIN}
       ${SAVINGS_PROJECTION_JOIN}
       ${ADJUSTMENT_PROJECTION_JOIN}
       WHERE current_change.user_id = ?
          AND current_change.account_generation = ?
         AND current_change.seq > CAST(? AS INTEGER)
         AND NOT EXISTS (
           SELECT 1
           FROM sync_changes AS newer_change
            WHERE newer_change.user_id = current_change.user_id
              AND newer_change.account_generation = current_change.account_generation
             AND newer_change.entity_type = current_change.entity_type
             AND newer_change.entity_id = current_change.entity_id
             AND newer_change.seq > current_change.seq
         )
       ORDER BY current_change.seq ASC
       LIMIT ?`,
    )
    .bind(
      userId,
      generation,
      cursor,
      CHANGE_PAGE_SIZE + 1,
    )
    .all<ChangeRow>();
  const hasMore = result.results.length > CHANGE_PAGE_SIZE;
  const page = result.results.slice(0, CHANGE_PAGE_SIZE);
  const visiblePage = page.filter((row) =>
    (protocolVersion >= 5 || row.entity_type !== "recoveryAllocation") &&
    (protocolVersion >= 6 || row.entity_type !== "savingsEvent") &&
    (protocolVersion >= 8 || row.entity_type !== "balanceAdjustment"));
  return {
    changes: visiblePage.map((row) => changeFromRow(row, protocolVersion)),
    nextCursor: page.at(-1)?.cursor ?? cursor,
    hasMore,
  };
}

export async function compactSupersededChanges(
  db: D1Database,
  userId: string,
  generation: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_changes
       SET payload_json = '{}'
       WHERE user_id = ? AND account_generation = ?
         AND payload_json <> '{}'
         AND EXISTS (
           SELECT 1
           FROM sync_changes newer_change
            WHERE newer_change.user_id = sync_changes.user_id
              AND newer_change.account_generation = sync_changes.account_generation
             AND newer_change.entity_type = sync_changes.entity_type
             AND newer_change.entity_id = sync_changes.entity_id
             AND newer_change.seq > sync_changes.seq
         )`,
    )
    .bind(userId, generation)
    .run();
}

export async function assertLegacyClientCompatible(
  db: D1Database,
  userId: string,
  generation: number,
  protocolVersion: SyncProtocolVersion,
): Promise<void> {
  if (protocolVersion >= 8) return;
  const checksV5Semantics = protocolVersion < 5;
  const checksV6Semantics = protocolVersion < 6;
  const checksV7Semantics = protocolVersion < 7;
  const row = await db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM ledger_entries
         WHERE user_id = ? AND account_generation = ?
            AND deleted_at IS NULL
            AND ? = 1
            AND (
             treatment <> CASE WHEN amount_minor < 0
               THEN 'ordinary_expense' ELSE 'ordinary_income' END
             OR confirmation_status <> 'not_needed'
             OR detection_rule_version IS NOT NULL
             OR prompted_revision IS NOT NULL
           )
       ) OR EXISTS (
         SELECT 1 FROM recovery_allocations
          WHERE user_id = ? AND account_generation = ? AND deleted_at IS NULL
            AND ? = 1
        ) OR EXISTS (
          SELECT 1 FROM savings_events
          WHERE user_id = ? AND account_generation = ? AND deleted_at IS NULL
            AND ? = 1
        ) OR EXISTS (
          SELECT 1 FROM ledger_settings
          WHERE user_id = ? AND account_generation = ?
            AND ? = 1
            AND (
              (default_savings_target_minor IS NOT NULL
                AND default_savings_target_minor <> 0)
              OR (cycle_end_balance_goal_minor IS NOT NULL
                AND cycle_end_balance_goal_minor <> 0)
            )
        ) OR EXISTS (
          SELECT 1 FROM ledger_settings
          WHERE user_id = ? AND account_generation = ?
            AND ? = 1
            AND savings_override_target_minor IS NOT NULL
        ) OR EXISTS (
          SELECT 1 FROM ledger_settings
          WHERE user_id = ? AND account_generation = ?
            AND ? = 1
            AND (
              savings_goal_target_date_key IS NOT NULL
              OR savings_goal_target_minor IS NOT NULL
              OR savings_goal_needs_setup = 1
            )
        ) OR EXISTS (
          SELECT 1 FROM balance_adjustments
          WHERE user_id = ? AND account_generation = ?
            AND deleted_at IS NULL
        ) THEN 1 ELSE 0 END AS requires_upgrade`,
    )
    .bind(
      userId,
      generation,
      checksV5Semantics ? 1 : 0,
      userId,
      generation,
      checksV5Semantics ? 1 : 0,
      userId,
      generation,
      checksV6Semantics ? 1 : 0,
      userId,
      generation,
      checksV6Semantics ? 1 : 0,
      userId,
      generation,
      checksV6Semantics ? 1 : 0,
      userId,
      generation,
      checksV7Semantics ? 1 : 0,
      userId,
      generation,
    )
    .first<{ requires_upgrade: number }>();
  if (row?.requires_upgrade === 1) {
    throw new ApiError(
      409,
      "upgrade_required",
      "This ledger uses facts that require a newer client",
    );
  }
}

export async function synchronize(
  env: Env,
  userId: string,
  generation: number,
  request: SyncRequestBody,
): Promise<{
  schemaVersion: SyncProtocolVersion;
  results: MutationResult[];
  changes: RemoteChange[];
  nextCursor: string;
  hasMore: boolean;
}> {
  await assertLegacyClientCompatible(
    env.DB,
    userId,
    generation,
    request.schemaVersion,
  );
  const duplicateIds = await assertMutationIdsReusable(
    env.DB,
    userId,
    generation,
    request.mutations,
  );
  await assertAttachmentsReady(
    env.DB,
    userId,
    generation,
    request.mutations.filter((mutation) => !duplicateIds.has(mutation.id)),
  );
  const results: MutationResult[] = [];
  for (const mutation of request.mutations) {
    results.push(await applyMutation(
      env.DB,
      userId,
      generation,
      mutation,
      request.schemaVersion,
    ));
  }
  await compactSupersededChanges(env.DB, userId, generation);
  await cleanupPendingAttachments(env, userId, generation);
  const pulled = await pullChanges(
    env.DB,
    userId,
    generation,
    request.cursor,
    request.schemaVersion,
  );
  return { schemaVersion: request.schemaVersion, results, ...pulled };
}
