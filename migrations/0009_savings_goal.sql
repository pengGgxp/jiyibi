ALTER TABLE ledger_settings
  ADD COLUMN savings_goal_target_date_key TEXT
  CHECK (
    savings_goal_target_date_key IS NULL
    OR (
      length(savings_goal_target_date_key) = 10
      AND date(savings_goal_target_date_key) = savings_goal_target_date_key
    )
  );

ALTER TABLE ledger_settings
  ADD COLUMN savings_goal_target_minor INTEGER
  CHECK (
    savings_goal_target_minor IS NULL
    OR savings_goal_target_minor BETWEEN 1 AND 9000000000000000
  );

ALTER TABLE ledger_settings
  ADD COLUMN last_expected_income_minor INTEGER
  CHECK (
    last_expected_income_minor IS NULL
    OR last_expected_income_minor BETWEEN 0 AND 9000000000000000
  );

ALTER TABLE ledger_settings
  ADD COLUMN savings_goal_needs_setup INTEGER NOT NULL DEFAULT 0
  CHECK (savings_goal_needs_setup IN (0, 1));

-- A per-cycle target has no reliable cumulative-goal date. Keep all actual
-- savings events and ask the v7 client to choose a new target explicitly.
UPDATE ledger_settings
SET savings_goal_needs_setup = 1
WHERE COALESCE(default_savings_target_minor, cycle_end_balance_goal_minor, 0) <> 0
   OR COALESCE(savings_override_target_minor, 0) <> 0;

DROP TRIGGER ledger_settings_planning_complete_before_insert;
DROP TRIGGER ledger_settings_planning_complete_before_update;

CREATE TRIGGER ledger_settings_planning_complete_before_insert
BEFORE INSERT ON ledger_settings
WHEN (NEW.income_forecast_id IS NULL) <>
      (NEW.income_forecast_target_payday_date_key IS NULL)
  OR (NEW.income_forecast_id IS NULL) <> (NEW.expected_income_minor IS NULL)
  OR (NEW.income_forecast_id IS NULL AND NEW.minimum_income_minor IS NOT NULL)
  OR (NEW.income_forecast_id IS NOT NULL AND NEW.payday_day IS NULL)
  OR (NEW.minimum_income_minor IS NOT NULL
    AND NEW.expected_income_minor IS NOT NULL
    AND NEW.minimum_income_minor > NEW.expected_income_minor)
  OR (NEW.savings_override_target_payday_date_key IS NULL) <>
    (NEW.savings_override_target_minor IS NULL)
  OR (NEW.savings_override_target_payday_date_key IS NOT NULL
    AND NEW.payday_day IS NULL)
  OR (NEW.savings_goal_target_date_key IS NULL) <>
    (NEW.savings_goal_target_minor IS NULL)
  OR (NEW.savings_goal_target_date_key IS NOT NULL
    AND NEW.savings_goal_needs_setup = 1)
  OR (NEW.payday_day IS NULL AND (
    NEW.monthly_salary_minor IS NOT NULL
    OR NEW.cycle_end_balance_goal_minor IS NOT NULL
    OR NEW.default_savings_target_minor IS NOT NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'incomplete_income_or_savings_planning');
END;

CREATE TRIGGER ledger_settings_planning_complete_before_update
BEFORE UPDATE ON ledger_settings
WHEN (NEW.income_forecast_id IS NULL) <>
      (NEW.income_forecast_target_payday_date_key IS NULL)
  OR (NEW.income_forecast_id IS NULL) <> (NEW.expected_income_minor IS NULL)
  OR (NEW.income_forecast_id IS NULL AND NEW.minimum_income_minor IS NOT NULL)
  OR (NEW.income_forecast_id IS NOT NULL AND NEW.payday_day IS NULL)
  OR (NEW.minimum_income_minor IS NOT NULL
    AND NEW.expected_income_minor IS NOT NULL
    AND NEW.minimum_income_minor > NEW.expected_income_minor)
  OR (NEW.savings_override_target_payday_date_key IS NULL) <>
    (NEW.savings_override_target_minor IS NULL)
  OR (NEW.savings_override_target_payday_date_key IS NOT NULL
    AND NEW.payday_day IS NULL)
  OR (NEW.savings_goal_target_date_key IS NULL) <>
    (NEW.savings_goal_target_minor IS NULL)
  OR (NEW.savings_goal_target_date_key IS NOT NULL
    AND NEW.savings_goal_needs_setup = 1)
  OR (NEW.payday_day IS NULL AND (
    NEW.monthly_salary_minor IS NOT NULL
    OR NEW.cycle_end_balance_goal_minor IS NOT NULL
    OR NEW.default_savings_target_minor IS NOT NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'incomplete_income_or_savings_planning');
END;

-- A v6 client can still write its old per-cycle target after this migration.
-- Preserve that write, but make the required v7 review durable so another
-- legacy client cannot later overwrite the new interpretation silently.
CREATE TRIGGER ledger_settings_mark_legacy_savings_after_insert
AFTER INSERT ON ledger_settings
WHEN NEW.savings_goal_target_date_key IS NULL
  AND NEW.savings_goal_needs_setup = 0
  AND (
    COALESCE(NEW.default_savings_target_minor, NEW.cycle_end_balance_goal_minor, 0) <> 0
    OR COALESCE(NEW.savings_override_target_minor, 0) <> 0
  )
BEGIN
  UPDATE ledger_settings
  SET savings_goal_needs_setup = 1
  WHERE user_id = NEW.user_id AND id = NEW.id;
END;

CREATE TRIGGER ledger_settings_mark_legacy_savings_after_update
AFTER UPDATE OF default_savings_target_minor, cycle_end_balance_goal_minor,
  savings_override_target_minor ON ledger_settings
WHEN NEW.savings_goal_target_date_key IS NULL
  AND NEW.savings_goal_needs_setup = 0
  AND (
    COALESCE(NEW.default_savings_target_minor, NEW.cycle_end_balance_goal_minor, 0) <> 0
    OR COALESCE(NEW.savings_override_target_minor, 0) <> 0
  )
BEGIN
  UPDATE ledger_settings
  SET savings_goal_needs_setup = 1
  WHERE user_id = NEW.user_id AND id = NEW.id;
END;
