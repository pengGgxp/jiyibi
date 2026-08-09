ALTER TABLE ledger_settings
  ADD COLUMN month_end_balance_goal_minor INTEGER
  CHECK (
    month_end_balance_goal_minor IS NULL
    OR month_end_balance_goal_minor BETWEEN -9000000000000000 AND 9000000000000000
  );

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
      json_object(
        'id', NEW.id,
        'currency', NEW.currency,
        'initialBalanceMinor', NEW.initial_balance_minor,
        'schemaVersion', NEW.schema_version,
        'updatedAt', NEW.updated_at
      ),
      CASE WHEN NEW.month_end_balance_goal_minor IS NULL
        THEN '{}'
        ELSE json_object('monthEndBalanceGoalMinor', NEW.month_end_balance_goal_minor)
      END
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
      CASE WHEN NEW.month_end_balance_goal_minor IS NULL
        THEN '{}'
        ELSE json_object('monthEndBalanceGoalMinor', NEW.month_end_balance_goal_minor)
      END
    ),
    NEW.server_updated_at
  );
END;
