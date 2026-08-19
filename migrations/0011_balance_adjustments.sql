ALTER TABLE ledger_settings
  ADD COLUMN initial_balance_locked_at TEXT
  CHECK (
    initial_balance_locked_at IS NULL
    OR (
      length(initial_balance_locked_at) BETWEEN 20 AND 30
      AND datetime(initial_balance_locked_at) IS NOT NULL
    )
  );

-- A historical fact permanently closes the mutable opening-balance window.
UPDATE ledger_settings
SET initial_balance_locked_at = (
  SELECT MIN(fact_created_at)
  FROM (
    SELECT created_at AS fact_created_at
    FROM ledger_entries
    WHERE ledger_entries.user_id = ledger_settings.user_id
      AND ledger_entries.account_generation = ledger_settings.account_generation
    UNION ALL
    SELECT created_at AS fact_created_at
    FROM savings_events
    WHERE savings_events.user_id = ledger_settings.user_id
      AND savings_events.account_generation = ledger_settings.account_generation
  )
)
WHERE initial_balance_locked_at IS NULL
  AND (
    EXISTS (
      SELECT 1 FROM ledger_entries
      WHERE ledger_entries.user_id = ledger_settings.user_id
        AND ledger_entries.account_generation = ledger_settings.account_generation
    )
    OR EXISTS (
      SELECT 1 FROM savings_events
      WHERE savings_events.user_id = ledger_settings.user_id
        AND savings_events.account_generation = ledger_settings.account_generation
    )
  );

CREATE TABLE balance_adjustments (
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN ('reconciliation', 'opening_correction')),
  amount_minor INTEGER NOT NULL
    CHECK (
      amount_minor <> 0
      AND amount_minor BETWEEN -9000000000000000 AND 9000000000000000
    ),
  note TEXT NOT NULL CHECK (length(note) <= 200),
  occurred_at TEXT NOT NULL,
  local_date_key TEXT NOT NULL
    CHECK (length(local_date_key) = 10 AND date(local_date_key) = local_date_key),
  local_month_key TEXT NOT NULL CHECK (length(local_month_key) = 7),
  timezone_offset_minutes INTEGER NOT NULL
    CHECK (timezone_offset_minutes BETWEEN -840 AND 840),
  balance_before_minor INTEGER,
  observed_balance_minor INTEGER,
  previous_opening_minor INTEGER,
  next_opening_minor INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 128),
  last_mutation_hash TEXT NOT NULL CHECK (length(last_mutation_hash) = 64),
  server_updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  CHECK (local_month_key = substr(local_date_key, 1, 7)),
  CHECK (
    (kind = 'reconciliation'
      AND balance_before_minor BETWEEN -9000000000000000 AND 9000000000000000
      AND observed_balance_minor BETWEEN -9000000000000000 AND 9000000000000000
      AND previous_opening_minor IS NULL
      AND next_opening_minor IS NULL
      AND amount_minor = observed_balance_minor - balance_before_minor)
    OR
    (kind = 'opening_correction'
      AND previous_opening_minor BETWEEN -9000000000000000 AND 9000000000000000
      AND next_opening_minor BETWEEN -9000000000000000 AND 9000000000000000
      AND balance_before_minor IS NULL
      AND observed_balance_minor IS NULL
      AND amount_minor = next_opening_minor - previous_opening_minor)
  ),
  CHECK (
    deleted_at IS NULL
    OR (
      deleted_at = updated_at
      AND julianday(deleted_at) >= julianday(created_at)
      AND (julianday(deleted_at) - julianday(created_at)) * 86400.0 <= 8.0005
    )
  ),
  FOREIGN KEY (user_id, account_generation)
    REFERENCES users(id, generation) ON DELETE CASCADE
);

CREATE INDEX idx_balance_adjustments_user_date
  ON balance_adjustments(user_id, local_date_key DESC, occurred_at DESC);
CREATE INDEX idx_balance_adjustments_user_deleted
  ON balance_adjustments(user_id, deleted_at);

CREATE TRIGGER balance_adjustments_block_insert_when_sync_inactive
BEFORE INSERT ON balance_adjustments
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER balance_adjustments_block_update_when_sync_inactive
BEFORE UPDATE ON balance_adjustments
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER balance_adjustments_preserve_audit_before_update
BEFORE UPDATE ON balance_adjustments
WHEN OLD.user_id IS NOT NEW.user_id
  OR OLD.account_generation IS NOT NEW.account_generation
  OR OLD.id IS NOT NEW.id
  OR OLD.kind IS NOT NEW.kind
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.note IS NOT NEW.note
  OR OLD.occurred_at IS NOT NEW.occurred_at
  OR OLD.local_date_key IS NOT NEW.local_date_key
  OR OLD.local_month_key IS NOT NEW.local_month_key
  OR OLD.timezone_offset_minutes IS NOT NEW.timezone_offset_minutes
  OR OLD.balance_before_minor IS NOT NEW.balance_before_minor
  OR OLD.observed_balance_minor IS NOT NEW.observed_balance_minor
  OR OLD.previous_opening_minor IS NOT NEW.previous_opening_minor
  OR OLD.next_opening_minor IS NOT NEW.next_opening_minor
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.deleted_at IS NOT NULL
  OR NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'immutable_balance_adjustment');
END;

CREATE TRIGGER ledger_settings_preserve_initial_balance_lock_before_update
BEFORE UPDATE ON ledger_settings
WHEN OLD.initial_balance_locked_at IS NOT NULL
  AND (
    NEW.initial_balance_locked_at IS NULL
    OR NEW.initial_balance_locked_at > OLD.initial_balance_locked_at
    OR NEW.initial_balance_minor IS NOT OLD.initial_balance_minor
  )
BEGIN
  SELECT RAISE(ABORT, 'initial_balance_locked');
END;

CREATE TRIGGER ledger_entries_lock_initial_balance_after_insert
AFTER INSERT ON ledger_entries
BEGIN
  UPDATE ledger_settings
  SET initial_balance_locked_at = CASE
    WHEN initial_balance_locked_at IS NULL
      OR NEW.created_at < initial_balance_locked_at
    THEN NEW.created_at
    ELSE initial_balance_locked_at
  END
  WHERE user_id = NEW.user_id
    AND account_generation = NEW.account_generation
    AND (initial_balance_locked_at IS NULL
      OR NEW.created_at < initial_balance_locked_at);
END;

CREATE TRIGGER savings_events_lock_initial_balance_after_insert
AFTER INSERT ON savings_events
BEGIN
  UPDATE ledger_settings
  SET initial_balance_locked_at = CASE
    WHEN initial_balance_locked_at IS NULL
      OR NEW.created_at < initial_balance_locked_at
    THEN NEW.created_at
    ELSE initial_balance_locked_at
  END
  WHERE user_id = NEW.user_id
    AND account_generation = NEW.account_generation
    AND (initial_balance_locked_at IS NULL
      OR NEW.created_at < initial_balance_locked_at);
END;

CREATE TRIGGER balance_adjustments_lock_initial_balance_after_insert
AFTER INSERT ON balance_adjustments
BEGIN
  UPDATE ledger_settings
  SET initial_balance_locked_at = CASE
    WHEN initial_balance_locked_at IS NULL
      OR NEW.created_at < initial_balance_locked_at
    THEN NEW.created_at
    ELSE initial_balance_locked_at
  END
  WHERE user_id = NEW.user_id
    AND account_generation = NEW.account_generation
    AND (initial_balance_locked_at IS NULL
      OR NEW.created_at < initial_balance_locked_at);
END;

CREATE TRIGGER ledger_settings_backfill_initial_balance_lock_after_insert
AFTER INSERT ON ledger_settings
WHEN NEW.initial_balance_locked_at IS NULL
BEGIN
  UPDATE ledger_settings
  SET initial_balance_locked_at = (
    SELECT MIN(fact_created_at)
    FROM (
      SELECT created_at AS fact_created_at FROM ledger_entries
      WHERE user_id = NEW.user_id AND account_generation = NEW.account_generation
      UNION ALL
      SELECT created_at AS fact_created_at FROM savings_events
      WHERE user_id = NEW.user_id AND account_generation = NEW.account_generation
      UNION ALL
      SELECT created_at AS fact_created_at FROM balance_adjustments
      WHERE user_id = NEW.user_id AND account_generation = NEW.account_generation
    )
  )
  WHERE user_id = NEW.user_id
    AND account_generation = NEW.account_generation
    AND initial_balance_locked_at IS NULL
    AND (
      EXISTS (SELECT 1 FROM ledger_entries
        WHERE user_id = NEW.user_id AND account_generation = NEW.account_generation)
      OR EXISTS (SELECT 1 FROM savings_events
        WHERE user_id = NEW.user_id AND account_generation = NEW.account_generation)
      OR EXISTS (SELECT 1 FROM balance_adjustments
        WHERE user_id = NEW.user_id AND account_generation = NEW.account_generation)
    );
END;

DROP TRIGGER ledger_settings_sync_after_insert;
DROP TRIGGER ledger_settings_sync_after_update;
DROP TRIGGER ledger_entries_sync_after_insert;
DROP TRIGGER ledger_entries_sync_after_update;
DROP TRIGGER recovery_allocations_sync_after_insert;
DROP TRIGGER recovery_allocations_sync_after_update;
DROP TRIGGER savings_events_sync_after_insert;
DROP TRIGGER savings_events_sync_after_update;
DROP TRIGGER sync_changes_block_insert_when_sync_inactive;
DROP TRIGGER sync_changes_block_update_when_sync_inactive;

CREATE TABLE sync_changes_v8 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'entry', 'settings', 'recoveryAllocation', 'savingsEvent', 'balanceAdjustment'
    )
  ),
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

INSERT INTO sync_changes_v8 (
  seq, user_id, account_generation, entity_type, entity_id, entity_version,
  mutation_id, mutation_hash, payload_json, created_at
)
SELECT
  seq, user_id, account_generation, entity_type, entity_id, entity_version,
  mutation_id, mutation_hash, payload_json, created_at
FROM sync_changes;

DROP TABLE sync_changes;
ALTER TABLE sync_changes_v8 RENAME TO sync_changes;

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

-- Entry and savings payloads are projected from their authoritative rows by
-- the Worker. The stored JSON only needs to remain valid for compaction.
CREATE TRIGGER ledger_entries_sync_after_insert
AFTER INSERT ON ledger_entries
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id, NEW.account_generation, 'entry', NEW.id, NEW.version,
    NEW.last_mutation_id, NEW.last_mutation_hash, '{}', NEW.server_updated_at
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
    NEW.user_id, NEW.account_generation, 'entry', NEW.id, NEW.version,
    NEW.last_mutation_id, NEW.last_mutation_hash, '{}', NEW.server_updated_at
  );
END;

CREATE TRIGGER savings_events_sync_after_insert
AFTER INSERT ON savings_events
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id, NEW.account_generation, 'savingsEvent', NEW.id, NEW.version,
    NEW.last_mutation_id, NEW.last_mutation_hash, '{}', NEW.server_updated_at
  );
END;

CREATE TRIGGER savings_events_sync_after_update
AFTER UPDATE ON savings_events
WHEN OLD.last_mutation_id IS NOT NEW.last_mutation_id
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id, NEW.account_generation, 'savingsEvent', NEW.id, NEW.version,
    NEW.last_mutation_id, NEW.last_mutation_hash, '{}', NEW.server_updated_at
  );
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
      IIF(NEW.deleted_at IS NULL, '{}', json_object('deletedAt', NEW.deleted_at))
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
      IIF(NEW.deleted_at IS NULL, '{}', json_object('deletedAt', NEW.deleted_at))
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
    json_patch(
      json_object(
        'id', NEW.id,
        'currency', NEW.currency,
        'initialBalanceMinor', NEW.initial_balance_minor,
        'schemaVersion', NEW.schema_version,
        'updatedAt', NEW.updated_at
      ),
      IIF(NEW.initial_balance_locked_at IS NULL, '{}',
        json_object('initialBalanceLockedAt', NEW.initial_balance_locked_at))
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
    json_patch(
      json_object(
        'id', NEW.id,
        'currency', NEW.currency,
        'initialBalanceMinor', NEW.initial_balance_minor,
        'schemaVersion', NEW.schema_version,
        'updatedAt', NEW.updated_at
      ),
      IIF(NEW.initial_balance_locked_at IS NULL, '{}',
        json_object('initialBalanceLockedAt', NEW.initial_balance_locked_at))
    ),
    NEW.server_updated_at
  );
END;

CREATE TRIGGER balance_adjustments_sync_after_insert
AFTER INSERT ON balance_adjustments
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id,
    NEW.account_generation,
    'balanceAdjustment',
    NEW.id,
    NEW.version,
    NEW.last_mutation_id,
    NEW.last_mutation_hash,
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
        IIF(NEW.kind = 'reconciliation',
          json_object(
            'balanceBeforeMinor', NEW.balance_before_minor,
            'observedBalanceMinor', NEW.observed_balance_minor
          ),
          json_object(
            'previousOpeningMinor', NEW.previous_opening_minor,
            'nextOpeningMinor', NEW.next_opening_minor
          ))
      ),
      IIF(NEW.deleted_at IS NULL, '{}', json_object('deletedAt', NEW.deleted_at))
    ),
    NEW.server_updated_at
  );
END;

CREATE TRIGGER balance_adjustments_sync_after_update
AFTER UPDATE ON balance_adjustments
WHEN OLD.last_mutation_id IS NOT NEW.last_mutation_id
BEGIN
  INSERT INTO sync_changes (
    user_id, account_generation, entity_type, entity_id, entity_version,
    mutation_id, mutation_hash, payload_json, created_at
  ) VALUES (
    NEW.user_id,
    NEW.account_generation,
    'balanceAdjustment',
    NEW.id,
    NEW.version,
    NEW.last_mutation_id,
    NEW.last_mutation_hash,
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
        IIF(NEW.kind = 'reconciliation',
          json_object(
            'balanceBeforeMinor', NEW.balance_before_minor,
            'observedBalanceMinor', NEW.observed_balance_minor
          ),
          json_object(
            'previousOpeningMinor', NEW.previous_opening_minor,
            'nextOpeningMinor', NEW.next_opening_minor
          ))
      ),
      IIF(NEW.deleted_at IS NULL, '{}', json_object('deletedAt', NEW.deleted_at))
    ),
    NEW.server_updated_at
  );
END;
