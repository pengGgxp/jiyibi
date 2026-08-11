ALTER TABLE ledger_settings
  ADD COLUMN income_forecast_id TEXT
  CHECK (
    income_forecast_id IS NULL
    OR length(income_forecast_id) BETWEEN 1 AND 128
  );

ALTER TABLE ledger_settings
  ADD COLUMN income_forecast_target_payday_date_key TEXT
  CHECK (
    income_forecast_target_payday_date_key IS NULL
    OR (
      length(income_forecast_target_payday_date_key) = 10
      AND date(income_forecast_target_payday_date_key) =
        income_forecast_target_payday_date_key
    )
  );

ALTER TABLE ledger_settings
  ADD COLUMN minimum_income_minor INTEGER
  CHECK (
    minimum_income_minor IS NULL
    OR minimum_income_minor BETWEEN 0 AND 9000000000000000
  );

ALTER TABLE ledger_settings
  ADD COLUMN expected_income_minor INTEGER
  CHECK (
    expected_income_minor IS NULL
    OR expected_income_minor BETWEEN 0 AND 9000000000000000
  );

DROP TRIGGER ledger_settings_pay_cycle_complete_before_insert;
DROP TRIGGER ledger_settings_pay_cycle_complete_before_update;

CREATE TRIGGER ledger_settings_planning_complete_before_insert
BEFORE INSERT ON ledger_settings
WHEN (NEW.payday_day IS NULL) <> (NEW.cycle_end_balance_goal_minor IS NULL)
  OR (NEW.monthly_salary_minor IS NOT NULL AND NEW.payday_day IS NULL)
  OR (NEW.income_forecast_id IS NULL) <>
    (NEW.income_forecast_target_payday_date_key IS NULL)
  OR (NEW.income_forecast_id IS NULL) <> (NEW.minimum_income_minor IS NULL)
  OR (NEW.income_forecast_id IS NULL) <> (NEW.expected_income_minor IS NULL)
  OR (NEW.income_forecast_id IS NOT NULL AND NEW.payday_day IS NULL)
  OR (NEW.minimum_income_minor IS NOT NULL
    AND NEW.minimum_income_minor > NEW.expected_income_minor)
BEGIN
  SELECT RAISE(ABORT, 'incomplete_income_planning');
END;

CREATE TRIGGER ledger_settings_planning_complete_before_update
BEFORE UPDATE ON ledger_settings
WHEN (NEW.payday_day IS NULL) <> (NEW.cycle_end_balance_goal_minor IS NULL)
  OR (NEW.monthly_salary_minor IS NOT NULL AND NEW.payday_day IS NULL)
  OR (NEW.income_forecast_id IS NULL) <>
    (NEW.income_forecast_target_payday_date_key IS NULL)
  OR (NEW.income_forecast_id IS NULL) <> (NEW.minimum_income_minor IS NULL)
  OR (NEW.income_forecast_id IS NULL) <> (NEW.expected_income_minor IS NULL)
  OR (NEW.income_forecast_id IS NOT NULL AND NEW.payday_day IS NULL)
  OR (NEW.minimum_income_minor IS NOT NULL
    AND NEW.minimum_income_minor > NEW.expected_income_minor)
BEGIN
  SELECT RAISE(ABORT, 'incomplete_income_planning');
END;

DROP TRIGGER ledger_settings_sync_after_insert;
DROP TRIGGER ledger_settings_sync_after_update;

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
      json_patch(
        json_object(
          'id', NEW.id,
          'currency', NEW.currency,
          'initialBalanceMinor', NEW.initial_balance_minor,
          'schemaVersion', NEW.schema_version,
          'updatedAt', NEW.updated_at
        ),
        IIF(
          NEW.month_end_balance_goal_minor IS NULL,
          '{}',
          json_object('monthEndBalanceGoalMinor', NEW.month_end_balance_goal_minor)
        )
      ),
      IIF(
        NEW.payday_day IS NULL OR NEW.monthly_salary_minor IS NULL,
        '{}',
        json_object(
          'payCycle',
          json_object(
            'paydayDay', NEW.payday_day,
            'monthlySalaryMinor', NEW.monthly_salary_minor,
            'cycleEndBalanceGoalMinor', NEW.cycle_end_balance_goal_minor
          )
        )
      )
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
      json_patch(
        json_object(
          'id', NEW.id,
          'currency', NEW.currency,
          'initialBalanceMinor', NEW.initial_balance_minor,
          'schemaVersion', NEW.schema_version,
          'updatedAt', NEW.updated_at
        ),
        IIF(
          NEW.month_end_balance_goal_minor IS NULL,
          '{}',
          json_object('monthEndBalanceGoalMinor', NEW.month_end_balance_goal_minor)
        )
      ),
      IIF(
        NEW.payday_day IS NULL OR NEW.monthly_salary_minor IS NULL,
        '{}',
        json_object(
          'payCycle',
          json_object(
            'paydayDay', NEW.payday_day,
            'monthlySalaryMinor', NEW.monthly_salary_minor,
            'cycleEndBalanceGoalMinor', NEW.cycle_end_balance_goal_minor
          )
        )
      )
    ),
    NEW.server_updated_at
  );
END;
