ALTER TABLE ledger_entries
  ADD COLUMN treatment TEXT
  CHECK (
    treatment IS NULL
    OR treatment IN (
      'ordinary_expense',
      'one_time_expense',
      'reimbursable_expense',
      'ordinary_income',
      'refund_reimbursement',
      'account_transfer'
    )
  );

ALTER TABLE ledger_entries
  ADD COLUMN confirmation_status TEXT NOT NULL DEFAULT 'not_needed'
  CHECK (confirmation_status IN ('not_needed', 'pending', 'confirmed'));

ALTER TABLE ledger_entries
  ADD COLUMN detection_rule_version INTEGER
  CHECK (detection_rule_version IS NULL OR detection_rule_version >= 0);

ALTER TABLE ledger_entries
  ADD COLUMN prompted_revision TEXT;

UPDATE ledger_entries
SET treatment = CASE
  WHEN amount_minor < 0 THEN 'ordinary_expense'
  ELSE 'ordinary_income'
END
WHERE treatment IS NULL;

CREATE TRIGGER ledger_entries_analysis_fields_before_insert
BEFORE INSERT ON ledger_entries
WHEN NEW.treatment IS NULL
  OR (
    NEW.treatment IN (
      'ordinary_expense',
      'one_time_expense',
      'reimbursable_expense'
    )
    AND NEW.amount_minor >= 0
  )
  OR (
    NEW.treatment IN ('ordinary_income', 'refund_reimbursement')
    AND NEW.amount_minor <= 0
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_entry_treatment');
END;

CREATE TRIGGER ledger_entries_analysis_fields_before_update
BEFORE UPDATE ON ledger_entries
WHEN NEW.treatment IS NULL
  OR (
    NEW.treatment IN (
      'ordinary_expense',
      'one_time_expense',
      'reimbursable_expense'
    )
    AND NEW.amount_minor >= 0
  )
  OR (
    NEW.treatment IN ('ordinary_income', 'refund_reimbursement')
    AND NEW.amount_minor <= 0
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_entry_treatment');
END;

DROP TRIGGER ledger_entries_sync_after_insert;
DROP TRIGGER ledger_entries_sync_after_update;
DROP TRIGGER ledger_settings_sync_after_insert;
DROP TRIGGER ledger_settings_sync_after_update;
DROP TRIGGER sync_changes_block_insert_when_sync_inactive;
DROP TRIGGER sync_changes_block_update_when_sync_inactive;

CREATE TABLE sync_changes_v5 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('entry', 'settings', 'recoveryAllocation')),
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

INSERT INTO sync_changes_v5 (
  seq,
  user_id,
  account_generation,
  entity_type,
  entity_id,
  entity_version,
  mutation_id,
  mutation_hash,
  payload_json,
  created_at
)
SELECT
  seq,
  user_id,
  account_generation,
  entity_type,
  entity_id,
  entity_version,
  mutation_id,
  mutation_hash,
  payload_json,
  created_at
FROM sync_changes;

DROP TABLE sync_changes;
ALTER TABLE sync_changes_v5 RENAME TO sync_changes;

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

CREATE TABLE recovery_allocations (
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  refund_entry_id TEXT NOT NULL CHECK (length(refund_entry_id) BETWEEN 1 AND 128),
  expense_entry_id TEXT NOT NULL CHECK (length(expense_entry_id) BETWEEN 1 AND 128),
  amount_minor INTEGER NOT NULL
    CHECK (amount_minor BETWEEN 1 AND 9000000000000000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 128),
  last_mutation_hash TEXT NOT NULL CHECK (length(last_mutation_hash) = 64),
  server_updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  CHECK (refund_entry_id <> expense_entry_id),
  CHECK (deleted_at IS NULL OR deleted_at = updated_at),
  FOREIGN KEY (user_id, account_generation)
    REFERENCES users(id, generation) ON DELETE CASCADE,
  FOREIGN KEY (user_id, refund_entry_id)
    REFERENCES ledger_entries(user_id, id),
  FOREIGN KEY (user_id, expense_entry_id)
    REFERENCES ledger_entries(user_id, id)
);

CREATE INDEX idx_recovery_allocations_user_refund
  ON recovery_allocations(user_id, refund_entry_id, deleted_at);
CREATE INDEX idx_recovery_allocations_user_expense
  ON recovery_allocations(user_id, expense_entry_id, deleted_at);

CREATE TRIGGER recovery_allocations_block_insert_when_sync_inactive
BEFORE INSERT ON recovery_allocations
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER recovery_allocations_block_update_when_sync_inactive
BEFORE UPDATE ON recovery_allocations
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER recovery_allocations_validate_before_insert
BEFORE INSERT ON recovery_allocations
WHEN NEW.deleted_at IS NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND id = NEW.refund_entry_id
      AND amount_minor > 0
      AND treatment = 'refund_reimbursement'
      AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'invalid_recovery_refund') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND id = NEW.expense_entry_id
      AND amount_minor < 0
      AND treatment IN ('ordinary_expense', 'one_time_expense', 'reimbursable_expense')
      AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'invalid_recovery_expense') END;
  SELECT CASE WHEN NEW.amount_minor + COALESCE((
    SELECT SUM(amount_minor) FROM recovery_allocations
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND refund_entry_id = NEW.refund_entry_id
      AND deleted_at IS NULL
  ), 0) > (
    SELECT amount_minor FROM ledger_entries
    WHERE user_id = NEW.user_id AND id = NEW.refund_entry_id
  ) THEN RAISE(ABORT, 'recovery_refund_exceeded') END;
  SELECT CASE WHEN NEW.amount_minor + COALESCE((
    SELECT SUM(amount_minor) FROM recovery_allocations
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND expense_entry_id = NEW.expense_entry_id
      AND deleted_at IS NULL
  ), 0) > -(
    SELECT amount_minor FROM ledger_entries
    WHERE user_id = NEW.user_id AND id = NEW.expense_entry_id
  ) THEN RAISE(ABORT, 'recovery_expense_exceeded') END;
END;

CREATE TRIGGER recovery_allocations_validate_before_update
BEFORE UPDATE ON recovery_allocations
WHEN NEW.deleted_at IS NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND id = NEW.refund_entry_id
      AND amount_minor > 0
      AND treatment = 'refund_reimbursement'
      AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'invalid_recovery_refund') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND id = NEW.expense_entry_id
      AND amount_minor < 0
      AND treatment IN ('ordinary_expense', 'one_time_expense', 'reimbursable_expense')
      AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'invalid_recovery_expense') END;
  SELECT CASE WHEN NEW.amount_minor + COALESCE((
    SELECT SUM(amount_minor) FROM recovery_allocations
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND refund_entry_id = NEW.refund_entry_id
      AND id <> OLD.id
      AND deleted_at IS NULL
  ), 0) > (
    SELECT amount_minor FROM ledger_entries
    WHERE user_id = NEW.user_id AND id = NEW.refund_entry_id
  ) THEN RAISE(ABORT, 'recovery_refund_exceeded') END;
  SELECT CASE WHEN NEW.amount_minor + COALESCE((
    SELECT SUM(amount_minor) FROM recovery_allocations
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND expense_entry_id = NEW.expense_entry_id
      AND id <> OLD.id
      AND deleted_at IS NULL
  ), 0) > -(
    SELECT amount_minor FROM ledger_entries
    WHERE user_id = NEW.user_id AND id = NEW.expense_entry_id
  ) THEN RAISE(ABORT, 'recovery_expense_exceeded') END;
END;

CREATE TRIGGER ledger_entries_preserve_active_recovery_before_update
BEFORE UPDATE ON ledger_entries
WHEN EXISTS (
  SELECT 1 FROM recovery_allocations
  WHERE user_id = NEW.user_id
    AND account_generation = NEW.account_generation
    AND deleted_at IS NULL
    AND (
      refund_entry_id = NEW.id
      OR expense_entry_id = NEW.id
    )
)
AND (
  NEW.deleted_at IS NOT NULL
  OR (
    EXISTS (
      SELECT 1 FROM recovery_allocations
      WHERE user_id = NEW.user_id
        AND account_generation = NEW.account_generation
        AND deleted_at IS NULL
        AND refund_entry_id = NEW.id
    )
    AND (
      NEW.amount_minor <= 0
      OR NEW.treatment <> 'refund_reimbursement'
      OR NEW.amount_minor < (
        SELECT COALESCE(SUM(amount_minor), 0)
        FROM recovery_allocations
        WHERE user_id = NEW.user_id
          AND account_generation = NEW.account_generation
          AND deleted_at IS NULL
          AND refund_entry_id = NEW.id
      )
    )
  )
  OR (
    EXISTS (
      SELECT 1 FROM recovery_allocations
      WHERE user_id = NEW.user_id
        AND account_generation = NEW.account_generation
        AND deleted_at IS NULL
        AND expense_entry_id = NEW.id
    )
    AND (
      NEW.amount_minor >= 0
      OR NEW.treatment NOT IN ('ordinary_expense', 'reimbursable_expense')
      OR -NEW.amount_minor < (
        SELECT COALESCE(SUM(amount_minor), 0)
        FROM recovery_allocations
        WHERE user_id = NEW.user_id
          AND account_generation = NEW.account_generation
          AND deleted_at IS NULL
          AND expense_entry_id = NEW.id
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'active_recovery_allocation');
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
