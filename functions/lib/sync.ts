import { ApiError } from "./errors";
import { cleanupPendingAttachments } from "./cleanup";
import type {
  IncomeForecastPayload,
  LegacyAppSettingsPayload,
  LegacyPayCyclePlanPayload,
  LedgerEntryPayload,
  MutationResult,
  RecoveryAllocationPayload,
  SavingsEventPayload,
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
  entity_type: "entry" | "settings" | "recoveryAllocation" | "savingsEvent";
  entity_id: string;
  entity_version: number;
  mutation_hash: string;
  payload_json: string;
  settings_id?: string | null;
  settings_currency?: string | null;
  settings_initial_balance_minor?: number | null;
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
}

const SETTINGS_PROJECTION_COLUMNS = `
  current_settings.id AS settings_id,
  current_settings.currency AS settings_currency,
  current_settings.initial_balance_minor AS settings_initial_balance_minor,
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

interface VersionRow {
  version: number;
}

function payloadFromRow(
  row: ChangeRow,
  protocolVersion: SyncProtocolVersion,
): LedgerEntryPayload | SyncAppSettingsPayload | LegacyAppSettingsPayload | RecoveryAllocationPayload | SavingsEventPayload {
  try {
    const payload = JSON.parse(row.payload_json) as unknown;
    if (row.entity_type === "recoveryAllocation") {
      return payload as RecoveryAllocationPayload;
    }
    if (row.entity_type === "savingsEvent") {
      return savingsEventPayloadFromRow(row) ?? payload as SavingsEventPayload;
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
  if (row.settings_month_end_balance_goal_minor !== null &&
      row.settings_month_end_balance_goal_minor !== undefined) {
    payload.monthEndBalanceGoalMinor = row.settings_month_end_balance_goal_minor;
  }
  if (protocolVersion >= 6 &&
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
    payload.incomeForecast = {
      id: row.settings_income_forecast_id,
      targetPaydayDateKey: row.settings_income_forecast_target_payday_date_key,
      minimumIncomeMinor: row.settings_minimum_income_minor,
      expectedIncomeMinor: row.settings_expected_income_minor,
    };
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
  if (protocolVersion >= 2 && value.monthEndBalanceGoalMinor !== undefined) {
    base.monthEndBalanceGoalMinor = value.monthEndBalanceGoalMinor as number;
  }

  const storedCycle = isRecord(value.payCycle) ? value.payCycle : undefined;
  const storedLegacyGoal = storedCycle && Number.isSafeInteger(
    storedCycle.cycleEndBalanceGoalMinor,
  )
    ? Number(storedCycle.cycleEndBalanceGoalMinor)
    : storedCycle && Number.isSafeInteger(storedCycle.defaultSavingsTargetMinor)
      ? Number(storedCycle.defaultSavingsTargetMinor)
      : undefined;
  const legacyCycle = storedCycle && storedLegacyGoal !== undefined
    ? {
        paydayDay: storedCycle.paydayDay as number,
        cycleEndBalanceGoalMinor: storedLegacyGoal,
      }
    : undefined;
  const targetFromStored = storedCycle && Number.isSafeInteger(storedCycle.defaultSavingsTargetMinor)
    ? Number(storedCycle.defaultSavingsTargetMinor)
    : legacyCycle
      ? Math.max(legacyCycle.cycleEndBalanceGoalMinor, 0)
      : undefined;
  const canonicalCycle = storedCycle && targetFromStored !== undefined
    ? {
        paydayDay: storedCycle.paydayDay as number,
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
    if (forecast) base.incomeForecast = forecast;
    if (!forecast && Number.isSafeInteger(legacySalary) && Number(legacySalary) > 0) {
      base._legacyMonthlySalaryMinor = Number(legacySalary);
    }
  }
  if (protocolVersion >= 6) {
    if (canonicalCycle) base.payCycle = canonicalCycle;
    if (forecast) base.incomeForecast = forecast;
    if (isRecord(value.savingsTargetOverride)) {
      base.savingsTargetOverride = {
        targetPaydayDateKey: value.savingsTargetOverride.targetPaydayDateKey as string,
        targetMinor: value.savingsTargetOverride.targetMinor as number,
      };
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
    row.entity_type !== "savingsEvent"
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
              ${SAVINGS_PROJECTION_COLUMNS}
       FROM sync_changes AS current_change
       ${SETTINGS_PROJECTION_JOIN}
       ${ENTRY_PROJECTION_JOIN}
       ${SAVINGS_PROJECTION_JOIN}
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

async function writeSettings(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: SyncMutation,
  protocolVersion: SyncProtocolVersion,
): Promise<VersionRow | null> {
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
      protocolVersion >= 6 ? 1 : 0,
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
      writesCanonicalSavingsPlan ? 1 : 0,
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

export async function applyMutation(
  db: D1Database,
  userId: string,
  generation: number,
  mutation: SyncMutation,
  protocolVersion: SyncProtocolVersion = 1,
): Promise<MutationResult> {
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
              ${SAVINGS_PROJECTION_COLUMNS}
       FROM sync_changes AS current_change
       ${SETTINGS_PROJECTION_JOIN}
       ${ENTRY_PROJECTION_JOIN}
       ${SAVINGS_PROJECTION_JOIN}
       WHERE current_change.user_id = ?
          AND current_change.account_generation = ?
         AND current_change.seq > CAST(? AS INTEGER)
         AND (? >= 5 OR current_change.entity_type <> 'recoveryAllocation')
         AND (? >= 6 OR current_change.entity_type <> 'savingsEvent')
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
    .bind(userId, generation, cursor, protocolVersion, protocolVersion, CHANGE_PAGE_SIZE + 1)
    .all<ChangeRow>();
  const hasMore = result.results.length > CHANGE_PAGE_SIZE;
  const page = result.results.slice(0, CHANGE_PAGE_SIZE);
  return {
    changes: page.map((row) => changeFromRow(row, protocolVersion)),
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
  if (protocolVersion >= 6) return;
  const checksV5Semantics = protocolVersion < 5;
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
       ) OR EXISTS (
         SELECT 1 FROM ledger_settings
         WHERE user_id = ? AND account_generation = ?
           AND default_savings_target_minor IS NOT NULL
           AND default_savings_target_minor <> 0
       ) OR EXISTS (
         SELECT 1 FROM ledger_settings
         WHERE user_id = ? AND account_generation = ?
           AND savings_override_target_minor IS NOT NULL
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
      userId,
      generation,
      userId,
      generation,
    )
    .first<{ requires_upgrade: number }>();
  if (row?.requires_upgrade === 1) {
    throw new ApiError(
      409,
      "upgrade_required",
      "This ledger uses analysis fields that require a newer client",
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
