import { ApiError } from "./errors";
import { cleanupPendingAttachments } from "./cleanup";
import type {
  IncomeForecastPayload,
  LegacyAppSettingsPayload,
  LegacyPayCyclePlanPayload,
  LedgerEntryPayload,
  MutationResult,
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
  entity_type: "entry" | "settings";
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
  settings_schema_version?: number | null;
  settings_updated_at?: string | null;
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
  current_settings.schema_version AS settings_schema_version,
  current_settings.updated_at AS settings_updated_at`;

const SETTINGS_PROJECTION_JOIN = `
  LEFT JOIN ledger_settings AS current_settings
    ON current_change.entity_type = 'settings'
   AND current_settings.user_id = current_change.user_id
   AND current_settings.account_generation = current_change.account_generation
   AND current_settings.id = current_change.entity_id`;

interface VersionRow {
  version: number;
}

function payloadFromRow(
  row: ChangeRow,
  protocolVersion: SyncProtocolVersion,
): LedgerEntryPayload | SyncAppSettingsPayload | LegacyAppSettingsPayload {
  try {
    const payload = JSON.parse(row.payload_json) as unknown;
    if (row.entity_type === "entry") return payload as LedgerEntryPayload;
    return projectSettingsPayload(
      settingsPayloadFromRow(row) ?? payload,
      protocolVersion,
    );
  } catch {
    throw new Error("Stored sync payload is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsPayloadFromRow(row: ChangeRow): Record<string, unknown> | null {
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
  if (row.settings_payday_day !== null && row.settings_payday_day !== undefined &&
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
  const canonicalCycle = storedCycle
    ? {
        paydayDay: storedCycle.paydayDay as number,
        cycleEndBalanceGoalMinor: storedCycle.cycleEndBalanceGoalMinor as number,
      }
    : undefined;
  const forecast = isRecord(value.incomeForecast)
    ? value.incomeForecast as unknown as IncomeForecastPayload
    : undefined;

  const hasLegacySalary = Object.hasOwn(value, "_legacyMonthlySalaryMinor");
  const legacySalary = hasLegacySalary
    ? value._legacyMonthlySalaryMinor
    : storedCycle?.monthlySalaryMinor;

  if (protocolVersion === 3 && canonicalCycle) {
    if (Number.isSafeInteger(legacySalary) && Number(legacySalary) > 0) {
      (base as LegacyAppSettingsPayload).payCycle = {
        ...canonicalCycle,
        monthlySalaryMinor: Number(legacySalary),
      } satisfies LegacyPayCyclePlanPayload;
    }
  }

  if (protocolVersion >= 4) {
    if (canonicalCycle) base.payCycle = canonicalCycle;
    if (forecast) base.incomeForecast = forecast;
    if (!forecast && Number.isSafeInteger(legacySalary) && Number(legacySalary) > 0) {
      base._legacyMonthlySalaryMinor = Number(legacySalary);
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
  if (row.entity_type !== "entry" && row.entity_type !== "settings") {
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
              ${SETTINGS_PROJECTION_COLUMNS}
       FROM sync_changes AS current_change
       ${SETTINGS_PROJECTION_JOIN}
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
  const values = [
    entry.amountMinor,
    entry.note,
    entry.occurredAt,
    entry.localDateKey,
    entry.localMonthKey,
    entry.timezoneOffsetMinutes,
    entry.attachmentId ?? null,
    entry.createdAt,
    entry.updatedAt,
    entry.deletedAt ?? null,
  ] as const;
  if (mutation.baseVersion === 0) {
    return db
      .prepare(
         `INSERT INTO ledger_entries (
           user_id, account_generation, id, amount_minor, note, occurred_at, local_date_key,
           local_month_key, timezone_offset_minutes, attachment_id, created_at,
           updated_at, deleted_at, version, last_mutation_id,
           last_mutation_hash, server_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
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
         created_at = ?, updated_at = ?, deleted_at = ?, version = version + 1,
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
  const legacyPayCycle = protocolVersion === 3 && payCycle
    ? payCycle as LegacyPayCyclePlanPayload
    : null;
  const writesCompatibilitySalary = (protocolVersion === 3 && writesPayCycle) ||
    writesForecast ||
    (protocolVersion >= 4 && writesPayCycle && payCycle === null);
  const compatibilitySalary = protocolVersion === 3
    ? legacyPayCycle?.monthlySalaryMinor ?? null
    : incomeForecast && incomeForecast.expectedIncomeMinor > 0
      ? incomeForecast.expectedIncomeMinor
      : null;
  const writesCanonicalPayCycle = protocolVersion >= 4 && writesPayCycle;
  const suppliesCanonicalPayCycle = writesCanonicalPayCycle && payCycle !== null;
  if (mutation.baseVersion === 0) {
    return db
      .prepare(
        `INSERT INTO ledger_settings (
           user_id, account_generation, id, currency, initial_balance_minor,
           month_end_balance_goal_minor, payday_day, monthly_salary_minor,
           cycle_end_balance_goal_minor, income_forecast_id,
           income_forecast_target_payday_date_key, minimum_income_minor,
           expected_income_minor, schema_version, updated_at, version,
           last_mutation_id, last_mutation_hash, server_updated_at
         ) VALUES (?, ?, 'primary', 'CNY', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?)
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
        writesPayCycle ? payCycle?.cycleEndBalanceGoalMinor ?? null : null,
        writesForecast ? incomeForecast?.id ?? null : null,
        writesForecast ? incomeForecast?.targetPaydayDateKey ?? null : null,
        writesForecast ? incomeForecast?.minimumIncomeMinor ?? null : null,
        writesForecast ? incomeForecast?.expectedIncomeMinor ?? null : null,
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
         payday_day = CASE WHEN ? = 1 THEN ? ELSE payday_day END,
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
      writesCanonicalPayCycle ? 1 : 0,
      payCycle?.paydayDay ?? null,
      writesCompatibilitySalary ? 1 : 0,
      compatibilitySalary,
      suppliesCanonicalPayCycle ? 1 : 0,
      compatibilitySalary,
      writesCanonicalPayCycle ? 1 : 0,
      payCycle?.cycleEndBalanceGoalMinor ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.id ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.targetPaydayDateKey ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.minimumIncomeMinor ?? null,
      writesForecast ? 1 : 0,
      incomeForecast?.expectedIncomeMinor ?? null,
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
    written = mutation.entityType === "entry"
      ? await writeEntry(db, userId, generation, mutation)
      : await writeSettings(db, userId, generation, mutation, protocolVersion);
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
              ${SETTINGS_PROJECTION_COLUMNS}
       FROM sync_changes AS current_change
       ${SETTINGS_PROJECTION_JOIN}
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
    .bind(userId, generation, cursor, CHANGE_PAGE_SIZE + 1)
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
