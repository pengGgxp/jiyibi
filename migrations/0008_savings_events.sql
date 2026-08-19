ALTER TABLE ledger_settings
  ADD COLUMN default_savings_target_minor INTEGER
  CHECK (
    default_savings_target_minor IS NULL
    OR default_savings_target_minor BETWEEN 0 AND 9000000000000000
  );

ALTER TABLE ledger_settings
  ADD COLUMN savings_override_target_payday_date_key TEXT
  CHECK (
    savings_override_target_payday_date_key IS NULL
    OR (
      length(savings_override_target_payday_date_key) = 10
      AND date(savings_override_target_payday_date_key) =
        savings_override_target_payday_date_key
    )
  );

ALTER TABLE ledger_settings
  ADD COLUMN savings_override_target_minor INTEGER
  CHECK (
    savings_override_target_minor IS NULL
    OR savings_override_target_minor BETWEEN 0 AND 9000000000000000
  );

DROP TRIGGER ledger_settings_planning_complete_before_insert;
DROP TRIGGER ledger_settings_planning_complete_before_update;

CREATE TRIGGER ledger_settings_planning_complete_before_insert
BEFORE INSERT ON ledger_settings
WHEN (NEW.payday_day IS NULL AND (
    NEW.cycle_end_balance_goal_minor IS NOT NULL
    OR NEW.default_savings_target_minor IS NOT NULL
  ))
  OR (NEW.payday_day IS NOT NULL
    AND NEW.cycle_end_balance_goal_minor IS NULL
    AND NEW.default_savings_target_minor IS NULL)
  OR (NEW.monthly_salary_minor IS NOT NULL AND NEW.payday_day IS NULL)
  OR (NEW.income_forecast_id IS NULL) <>
    (NEW.income_forecast_target_payday_date_key IS NULL)
  OR (NEW.income_forecast_id IS NULL) <> (NEW.minimum_income_minor IS NULL)
  OR (NEW.income_forecast_id IS NULL) <> (NEW.expected_income_minor IS NULL)
  OR (NEW.income_forecast_id IS NOT NULL AND NEW.payday_day IS NULL)
  OR (NEW.minimum_income_minor IS NOT NULL
    AND NEW.minimum_income_minor > NEW.expected_income_minor)
  OR (NEW.savings_override_target_payday_date_key IS NULL) <>
    (NEW.savings_override_target_minor IS NULL)
  OR (NEW.savings_override_target_payday_date_key IS NOT NULL
    AND NEW.payday_day IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'incomplete_income_or_savings_planning');
END;

CREATE TRIGGER ledger_settings_planning_complete_before_update
BEFORE UPDATE ON ledger_settings
WHEN (NEW.payday_day IS NULL AND (
    NEW.cycle_end_balance_goal_minor IS NOT NULL
    OR NEW.default_savings_target_minor IS NOT NULL
  ))
  OR (NEW.payday_day IS NOT NULL
    AND NEW.cycle_end_balance_goal_minor IS NULL
    AND NEW.default_savings_target_minor IS NULL)
  OR (NEW.monthly_salary_minor IS NOT NULL AND NEW.payday_day IS NULL)
  OR (NEW.income_forecast_id IS NULL) <>
    (NEW.income_forecast_target_payday_date_key IS NULL)
  OR (NEW.income_forecast_id IS NULL) <> (NEW.minimum_income_minor IS NULL)
  OR (NEW.income_forecast_id IS NULL) <> (NEW.expected_income_minor IS NULL)
  OR (NEW.income_forecast_id IS NOT NULL AND NEW.payday_day IS NULL)
  OR (NEW.minimum_income_minor IS NOT NULL
    AND NEW.minimum_income_minor > NEW.expected_income_minor)
  OR (NEW.savings_override_target_payday_date_key IS NULL) <>
    (NEW.savings_override_target_minor IS NULL)
  OR (NEW.savings_override_target_payday_date_key IS NOT NULL
    AND NEW.payday_day IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'incomplete_income_or_savings_planning');
END;

DROP TRIGGER sync_changes_block_insert_when_sync_inactive;
DROP TRIGGER sync_changes_block_update_when_sync_inactive;
DROP TRIGGER recovery_allocations_sync_after_insert;
DROP TRIGGER recovery_allocations_sync_after_update;
DROP TRIGGER ledger_entries_sync_after_insert;
DROP TRIGGER ledger_entries_sync_after_update;
DROP TRIGGER ledger_settings_sync_after_insert;
DROP TRIGGER ledger_settings_sync_after_update;

CREATE TABLE sync_changes_v6 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('entry', 'settings', 'recoveryAllocation', 'savingsEvent')),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version >= 1),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  mutation_hash TEXT NOT NULL CHECK (length(mutation_hash) = 64),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, mutation_id),
  UNIQUE (user_id, entity_type, entity_id, entity_version),
  FOREIGN KEY (user_id, account_generation)
    REFERENCES users(id, generation) ON DELETE CASCADE
);

INSERT INTO sync_changes_v6 (
  seq, user_id, account_generation, entity_type, entity_id, entity_version,
  mutation_id, mutation_hash, payload_json, created_at
)
SELECT
  seq, user_id, account_generation, entity_type, entity_id, entity_version,
  mutation_id, mutation_hash, payload_json, created_at
FROM sync_changes;

DROP TABLE sync_changes;
ALTER TABLE sync_changes_v6 RENAME TO sync_changes;

CREATE INDEX idx_sync_changes_user_seq
  ON sync_changes(user_id, seq);
CREATE INDEX idx_sync_changes_user_entity
  ON sync_changes(user_id, entity_type, entity_id, seq DESC);

CREATE TRIGGER sync_changes_block_insert_when_sync_inactive
BEFORE INSERT ON sync_changes
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER sync_changes_block_update_when_sync_inactive
BEFORE UPDATE ON sync_changes
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER recovery_allocations_sync_after_insert
AFTER INSERT ON recovery_allocations
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id,
    NEW.account_generation,
    'recoveryAllocation',
    NEW.id,
    NEW.version,
    NEW.last_mutation_id,
    NEW.last_mutation_hash,
    json_patch(
      json_object(
        'id', NEW.id,
        'refundEntryId', NEW.refund_entry_id,
        'expenseEntryId', NEW.expense_entry_id,
        'amountMinor', NEW.amount_minor,
        'createdAt', NEW.created_at,
        'updatedAt', NEW.updated_at
      ),
      IIF(
        NEW.deleted_at IS NULL,
        '{}',
        json_object('deletedAt', NEW.deleted_at)
      )
    ),
    NEW.server_updated_at
  );
END;

CREATE TRIGGER recovery_allocations_sync_after_update
AFTER UPDATE ON recovery_allocations
WHEN OLD.last_mutation_id IS NOT NEW.last_mutation_id
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id,
    NEW.account_generation,
    'recoveryAllocation',
    NEW.id,
    NEW.version,
    NEW.last_mutation_id,
    NEW.last_mutation_hash,
    json_patch(
      json_object(
        'id', NEW.id,
        'refundEntryId', NEW.refund_entry_id,
        'expenseEntryId', NEW.expense_entry_id,
        'amountMinor', NEW.amount_minor,
        'createdAt', NEW.created_at,
        'updatedAt', NEW.updated_at
      ),
      IIF(
        NEW.deleted_at IS NULL,
        '{}',
        json_object('deletedAt', NEW.deleted_at)
      )
    ),
    NEW.server_updated_at
  );
END;

CREATE TRIGGER ledger_entries_sync_after_insert
AFTER INSERT ON ledger_entries
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id,
    NEW.account_generation,
    'entry',
    NEW.id,
    NEW.version,
    NEW.last_mutation_id,
    NEW.last_mutation_hash,
    json_patch(
      json_patch(
        json_patch(
          json_object(
            'id', NEW.id,
            'amountMinor', NEW.amount_minor,
            'note', NEW.note,
            'occurredAt', NEW.occurred_at,
            'localDateKey', NEW.local_date_key,
            'localMonthKey', NEW.local_month_key,
            'timezoneOffsetMinutes', NEW.timezone_offset_minutes,
            'treatment', NEW.treatment,
            'confirmationStatus', NEW.confirmation_status,
            'createdAt', NEW.created_at,
            'updatedAt', NEW.updated_at
          ),
          IIF(NEW.attachment_id IS NULL, '{}', json_object('attachmentId', NEW.attachment_id))
        ),
        IIF(
          NEW.detection_rule_version IS NULL,
          '{}',
          json_object('detectionRuleVersion', NEW.detection_rule_version)
        )
      ),
      json_patch(
        IIF(NEW.prompted_revision IS NULL, '{}', json_object('promptedRevision', NEW.prompted_revision)),
        IIF(NEW.deleted_at IS NULL, '{}', json_object('deletedAt', NEW.deleted_at))
      )
    ),
    NEW.server_updated_at
  );
END;

CREATE TRIGGER ledger_entries_sync_after_update
AFTER UPDATE ON ledger_entries
WHEN OLD.last_mutation_id IS NOT NEW.last_mutation_id
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id,
    NEW.account_generation,
    'entry',
    NEW.id,
    NEW.version,
    NEW.last_mutation_id,
    NEW.last_mutation_hash,
    json_patch(
      json_patch(
        json_patch(
          json_object(
            'id', NEW.id,
            'amountMinor', NEW.amount_minor,
            'note', NEW.note,
            'occurredAt', NEW.occurred_at,
            'localDateKey', NEW.local_date_key,
            'localMonthKey', NEW.local_month_key,
            'timezoneOffsetMinutes', NEW.timezone_offset_minutes,
            'treatment', NEW.treatment,
            'confirmationStatus', NEW.confirmation_status,
            'createdAt', NEW.created_at,
            'updatedAt', NEW.updated_at
          ),
          IIF(NEW.attachment_id IS NULL, '{}', json_object('attachmentId', NEW.attachment_id))
        ),
        IIF(
          NEW.detection_rule_version IS NULL,
          '{}',
          json_object('detectionRuleVersion', NEW.detection_rule_version)
        )
      ),
      json_patch(
        IIF(NEW.prompted_revision IS NULL, '{}', json_object('promptedRevision', NEW.prompted_revision)),
        IIF(NEW.deleted_at IS NULL, '{}', json_object('deletedAt', NEW.deleted_at))
      )
    ),
    NEW.server_updated_at
  );
END;

CREATE TRIGGER ledger_settings_sync_after_insert
AFTER INSERT ON ledger_settings
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id,
    NEW.account_generation,
    'settings',
    NEW.id,
    NEW.version,
    NEW.last_mutation_id,
    NEW.last_mutation_hash,
    json_object(
      'id', NEW.id,
      'currency', NEW.currency,
      'initialBalanceMinor', NEW.initial_balance_minor,
      'schemaVersion', NEW.schema_version,
      'updatedAt', NEW.updated_at
    ),
    NEW.server_updated_at
  );
END;

CREATE TRIGGER ledger_settings_sync_after_update
AFTER UPDATE ON ledger_settings
WHEN OLD.last_mutation_id IS NOT NEW.last_mutation_id
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id,
    NEW.account_generation,
    'settings',
    NEW.id,
    NEW.version,
    NEW.last_mutation_id,
    NEW.last_mutation_hash,
    json_object(
      'id', NEW.id,
      'currency', NEW.currency,
      'initialBalanceMinor', NEW.initial_balance_minor,
      'schemaVersion', NEW.schema_version,
      'updatedAt', NEW.updated_at
    ),
    NEW.server_updated_at
  );
END;

CREATE TABLE savings_events (
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL
    CHECK (kind IN ('opening', 'reserve', 'release', 'cycle_settlement')),
  amount_minor INTEGER NOT NULL
    CHECK (
      amount_minor BETWEEN 0 AND 9000000000000000
      AND (kind = 'cycle_settlement' OR amount_minor > 0)
    ),
  note TEXT NOT NULL CHECK (length(note) <= 200),
  occurred_at TEXT NOT NULL,
  local_date_key TEXT NOT NULL
    CHECK (length(local_date_key) = 10 AND date(local_date_key) = local_date_key),
  local_month_key TEXT NOT NULL CHECK (length(local_month_key) = 7),
  timezone_offset_minutes INTEGER NOT NULL
    CHECK (timezone_offset_minutes BETWEEN -840 AND 840),
  linked_expense_entry_id TEXT,
  cycle_start_date_key TEXT,
  cycle_end_date_key TEXT,
  goal_minor_snapshot INTEGER,
  opening_retained_minor INTEGER,
  closing_retained_minor INTEGER,
  net_growth_minor INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 128),
  last_mutation_hash TEXT NOT NULL CHECK (length(last_mutation_hash) = 64),
  server_updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  CHECK (local_month_key = substr(local_date_key, 1, 7)),
  CHECK (linked_expense_entry_id IS NULL OR kind = 'release'),
  CHECK (
    (kind = 'cycle_settlement'
      AND cycle_start_date_key IS NOT NULL
      AND date(cycle_start_date_key) = cycle_start_date_key
      AND cycle_end_date_key IS NOT NULL
      AND date(cycle_end_date_key) = cycle_end_date_key
      AND cycle_start_date_key <= cycle_end_date_key
      AND goal_minor_snapshot BETWEEN 0 AND 9000000000000000
      AND opening_retained_minor BETWEEN -9000000000000000 AND 9000000000000000
      AND closing_retained_minor BETWEEN -9000000000000000 AND 9000000000000000
      AND net_growth_minor = closing_retained_minor - opening_retained_minor)
    OR
    (kind <> 'cycle_settlement'
      AND cycle_start_date_key IS NULL
      AND cycle_end_date_key IS NULL
      AND goal_minor_snapshot IS NULL
      AND opening_retained_minor IS NULL
      AND closing_retained_minor IS NULL
      AND net_growth_minor IS NULL)
  ),
  CHECK (deleted_at IS NULL OR deleted_at = updated_at),
  FOREIGN KEY (user_id, account_generation)
    REFERENCES users(id, generation) ON DELETE CASCADE,
  FOREIGN KEY (user_id, linked_expense_entry_id)
    REFERENCES ledger_entries(user_id, id)
);

CREATE INDEX idx_savings_events_user_date
  ON savings_events(user_id, local_date_key, deleted_at);
CREATE INDEX idx_savings_events_user_expense
  ON savings_events(user_id, linked_expense_entry_id, deleted_at);
CREATE UNIQUE INDEX idx_savings_events_active_cycle_settlement
  ON savings_events(user_id, account_generation, cycle_start_date_key)
  WHERE kind = 'cycle_settlement' AND deleted_at IS NULL;

CREATE TRIGGER savings_events_block_insert_when_sync_inactive
BEFORE INSERT ON savings_events
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER savings_events_block_update_when_sync_inactive
BEFORE UPDATE ON savings_events
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER savings_events_validate_expense_before_insert
BEFORE INSERT ON savings_events
WHEN NEW.deleted_at IS NULL AND NEW.linked_expense_entry_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND id = NEW.linked_expense_entry_id
      AND amount_minor < 0
      AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'invalid_savings_expense') END;
  SELECT CASE WHEN NEW.amount_minor + COALESCE((
    SELECT SUM(amount_minor) FROM savings_events
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND linked_expense_entry_id = NEW.linked_expense_entry_id
      AND deleted_at IS NULL
  ), 0) > -(
    SELECT amount_minor FROM ledger_entries
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND id = NEW.linked_expense_entry_id
  ) THEN RAISE(ABORT, 'savings_expense_exceeded') END;
END;

CREATE TRIGGER savings_events_validate_expense_before_update
BEFORE UPDATE ON savings_events
WHEN NEW.deleted_at IS NULL AND NEW.linked_expense_entry_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND id = NEW.linked_expense_entry_id
      AND amount_minor < 0
      AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'invalid_savings_expense') END;
  SELECT CASE WHEN NEW.amount_minor + COALESCE((
    SELECT SUM(amount_minor) FROM savings_events
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND linked_expense_entry_id = NEW.linked_expense_entry_id
      AND id <> OLD.id
      AND deleted_at IS NULL
  ), 0) > -(
    SELECT amount_minor FROM ledger_entries
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND id = NEW.linked_expense_entry_id
  ) THEN RAISE(ABORT, 'savings_expense_exceeded') END;
END;

CREATE TRIGGER ledger_entries_preserve_active_savings_before_update
BEFORE UPDATE ON ledger_entries
WHEN EXISTS (
  SELECT 1 FROM savings_events
  WHERE user_id = NEW.user_id
    AND account_generation = NEW.account_generation
    AND linked_expense_entry_id = NEW.id
    AND deleted_at IS NULL
)
AND (
  NEW.deleted_at IS NOT NULL
  OR NEW.amount_minor >= 0
  OR -NEW.amount_minor < (
    SELECT COALESCE(SUM(amount_minor), 0)
    FROM savings_events
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND linked_expense_entry_id = NEW.id
      AND deleted_at IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'active_savings_release');
END;

CREATE TRIGGER savings_events_sync_after_insert
AFTER INSERT ON savings_events
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id,
    NEW.account_generation,
    'savingsEvent',
    NEW.id,
    NEW.version,
    NEW.last_mutation_id,
    NEW.last_mutation_hash,
    json_patch(
      json_patch(
        json_patch(
          json_object(
            'id', NEW.id,
            'kind', NEW.kind,
            'amountMinor', NEW.amount_minor,
            'note', NEW.note,
            'occurredAt', NEW.occurred_at,
            'localDateKey', NEW.local_date_key,
            'localMonthKey', NEW.local_month_key,
            'timezoneOffsetMinutes', NEW.timezone_offset_minutes,
            'createdAt', NEW.created_at,
            'updatedAt', NEW.updated_at
          ),
          IIF(NEW.linked_expense_entry_id IS NULL, '{}',
            json_object('linkedExpenseEntryId', NEW.linked_expense_entry_id))
        ),
        IIF(NEW.kind <> 'cycle_settlement', '{}',
          json_object(
            'cycleStartDateKey', NEW.cycle_start_date_key,
            'cycleEndDateKey', NEW.cycle_end_date_key,
            'goalMinorSnapshot', NEW.goal_minor_snapshot,
            'openingRetainedMinor', NEW.opening_retained_minor,
            'closingRetainedMinor', NEW.closing_retained_minor,
            'netGrowthMinor', NEW.net_growth_minor
          ))
      ),
      IIF(NEW.deleted_at IS NULL, '{}', json_object('deletedAt', NEW.deleted_at))
    ),
    NEW.server_updated_at
  );
END;

CREATE TRIGGER savings_events_sync_after_update
AFTER UPDATE ON savings_events
WHEN OLD.last_mutation_id IS NOT NEW.last_mutation_id
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  )
  SELECT
    NEW.user_id,
    NEW.account_generation,
    'savingsEvent',
    NEW.id,
    NEW.version,
    NEW.last_mutation_id,
    NEW.last_mutation_hash,
    json_patch(
      json_patch(
        json_patch(
          json_object(
            'id', NEW.id,
            'kind', NEW.kind,
            'amountMinor', NEW.amount_minor,
            'note', NEW.note,
            'occurredAt', NEW.occurred_at,
            'localDateKey', NEW.local_date_key,
            'localMonthKey', NEW.local_month_key,
            'timezoneOffsetMinutes', NEW.timezone_offset_minutes,
            'createdAt', NEW.created_at,
            'updatedAt', NEW.updated_at
          ),
          IIF(NEW.linked_expense_entry_id IS NULL, '{}',
            json_object('linkedExpenseEntryId', NEW.linked_expense_entry_id))
        ),
        IIF(NEW.kind <> 'cycle_settlement', '{}',
          json_object(
            'cycleStartDateKey', NEW.cycle_start_date_key,
            'cycleEndDateKey', NEW.cycle_end_date_key,
            'goalMinorSnapshot', NEW.goal_minor_snapshot,
            'openingRetainedMinor', NEW.opening_retained_minor,
            'closingRetainedMinor', NEW.closing_retained_minor,
            'netGrowthMinor', NEW.net_growth_minor
          ))
      ),
      IIF(NEW.deleted_at IS NULL, '{}', json_object('deletedAt', NEW.deleted_at))
    ),
    NEW.server_updated_at;
END;
