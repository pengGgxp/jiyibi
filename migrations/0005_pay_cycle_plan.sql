ALTER TABLE ledger_settings
  ADD COLUMN payday_day INTEGER
  CHECK (payday_day IS NULL OR payday_day BETWEEN 1 AND 31);

ALTER TABLE ledger_settings
  ADD COLUMN monthly_salary_minor INTEGER
  CHECK (
    monthly_salary_minor IS NULL
    OR monthly_salary_minor BETWEEN 1 AND 9000000000000000
  );

ALTER TABLE ledger_settings
  ADD COLUMN cycle_end_balance_goal_minor INTEGER
  CHECK (
    cycle_end_balance_goal_minor IS NULL
    OR cycle_end_balance_goal_minor BETWEEN -9000000000000000 AND 9000000000000000
  );

CREATE TRIGGER ledger_settings_pay_cycle_complete_before_insert
BEFORE INSERT ON ledger_settings
WHEN (NEW.payday_day IS NULL) <> (NEW.monthly_salary_minor IS NULL)
  OR (NEW.payday_day IS NULL) <> (NEW.cycle_end_balance_goal_minor IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'incomplete_pay_cycle');
END;

CREATE TRIGGER ledger_settings_pay_cycle_complete_before_update
BEFORE UPDATE ON ledger_settings
WHEN (NEW.payday_day IS NULL) <> (NEW.monthly_salary_minor IS NULL)
  OR (NEW.payday_day IS NULL) <> (NEW.cycle_end_balance_goal_minor IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'incomplete_pay_cycle');
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
        NEW.payday_day IS NULL,
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
        NEW.payday_day IS NULL,
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
