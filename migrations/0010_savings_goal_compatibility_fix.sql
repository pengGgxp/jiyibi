-- Preserve the most recent expected amount when v7 normalizes an active
-- pre-v7 forecast. This value only pre-fills the next forecast form.
UPDATE ledger_settings
SET last_expected_income_minor = expected_income_minor
WHERE last_expected_income_minor IS NULL
  AND expected_income_minor IS NOT NULL;

-- 0009 used COALESCE for legacy targets. A canonical zero could therefore
-- hide a non-zero older shadow field. Mark every non-zero legacy target
-- explicitly so v7 asks the user to create a dated cumulative goal.
UPDATE ledger_settings
SET savings_goal_needs_setup = 1
WHERE savings_goal_target_date_key IS NULL
  AND savings_goal_target_minor IS NULL
  AND savings_goal_needs_setup = 0
  AND (
    (default_savings_target_minor IS NOT NULL
      AND default_savings_target_minor <> 0)
    OR (cycle_end_balance_goal_minor IS NOT NULL
      AND cycle_end_balance_goal_minor <> 0)
    OR (savings_override_target_minor IS NOT NULL
      AND savings_override_target_minor <> 0)
  );

DROP TRIGGER ledger_settings_mark_legacy_savings_after_insert;
DROP TRIGGER ledger_settings_mark_legacy_savings_after_update;

CREATE TRIGGER ledger_settings_mark_legacy_savings_after_insert
AFTER INSERT ON ledger_settings
WHEN NEW.savings_goal_target_date_key IS NULL
  AND NEW.savings_goal_needs_setup = 0
  AND (
    (NEW.default_savings_target_minor IS NOT NULL
      AND NEW.default_savings_target_minor <> 0)
    OR (NEW.cycle_end_balance_goal_minor IS NOT NULL
      AND NEW.cycle_end_balance_goal_minor <> 0)
    OR (NEW.savings_override_target_minor IS NOT NULL
      AND NEW.savings_override_target_minor <> 0)
  )
BEGIN
  UPDATE ledger_settings
  SET savings_goal_needs_setup = 1
  WHERE user_id = NEW.user_id
    AND account_generation = NEW.account_generation
    AND id = NEW.id;
END;

CREATE TRIGGER ledger_settings_mark_legacy_savings_after_update
AFTER UPDATE OF default_savings_target_minor, cycle_end_balance_goal_minor,
  savings_override_target_minor ON ledger_settings
WHEN NEW.savings_goal_target_date_key IS NULL
  AND NEW.savings_goal_needs_setup = 0
  AND (
    (NEW.default_savings_target_minor IS NOT NULL
      AND NEW.default_savings_target_minor <> 0)
    OR (NEW.cycle_end_balance_goal_minor IS NOT NULL
      AND NEW.cycle_end_balance_goal_minor <> 0)
    OR (NEW.savings_override_target_minor IS NOT NULL
      AND NEW.savings_override_target_minor <> 0)
  )
BEGIN
  UPDATE ledger_settings
  SET savings_goal_needs_setup = 1
  WHERE user_id = NEW.user_id
    AND account_generation = NEW.account_generation
    AND id = NEW.id;
END;

-- Internal idempotency receipts make income confirmation one cloud operation.
-- They are sync metadata, not ledger entries, and do not enter change feeds.
CREATE TABLE income_confirmations (
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL,
  forecast_id TEXT NOT NULL CHECK (length(forecast_id) BETWEEN 1 AND 128),
  confirmation_id TEXT NOT NULL CHECK (length(confirmation_id) BETWEEN 1 AND 128),
  target_payday_date_key TEXT NOT NULL CHECK (
    length(target_payday_date_key) = 10
    AND date(target_payday_date_key) = target_payday_date_key
  ),
  expected_income_minor INTEGER NOT NULL
    CHECK (expected_income_minor BETWEEN 0 AND 9000000000000000),
  actual_income_minor INTEGER NOT NULL
    CHECK (actual_income_minor BETWEEN 0 AND 9000000000000000),
  entry_id TEXT CHECK (entry_id IS NULL OR length(entry_id) BETWEEN 1 AND 128),
  confirmed_at TEXT NOT NULL,
  settings_mutation_id TEXT NOT NULL
    CHECK (length(settings_mutation_id) BETWEEN 1 AND 128),
  settings_mutation_hash TEXT NOT NULL CHECK (length(settings_mutation_hash) = 64),
  settings_version INTEGER NOT NULL CHECK (settings_version >= 1),
  entry_mutation_id TEXT
    CHECK (entry_mutation_id IS NULL OR length(entry_mutation_id) BETWEEN 1 AND 128),
  entry_mutation_hash TEXT
    CHECK (entry_mutation_hash IS NULL OR length(entry_mutation_hash) = 64),
  PRIMARY KEY (user_id, account_generation, forecast_id),
  UNIQUE (user_id, account_generation, confirmation_id),
  CHECK (
    (actual_income_minor = 0 AND entry_id IS NULL
      AND entry_mutation_id IS NULL AND entry_mutation_hash IS NULL)
    OR (actual_income_minor > 0 AND entry_id IS NOT NULL
      AND entry_mutation_id IS NOT NULL AND entry_mutation_hash IS NOT NULL)
  ),
  FOREIGN KEY (user_id, account_generation)
    REFERENCES users(id, generation) ON DELETE CASCADE
);
