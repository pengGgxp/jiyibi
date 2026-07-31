ALTER TABLE users ADD COLUMN deletion_quiet_since TEXT;

DROP TRIGGER users_block_update_when_sync_inactive;

CREATE TRIGGER users_block_update_when_sync_inactive
BEFORE UPDATE ON users
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.id AND status = 'enabled' AND generation = NEW.generation
)
AND NOT (
  EXISTS (
    SELECT 1 FROM cloud_sync_state
    WHERE user_id = NEW.id AND status = 'deleting' AND generation = NEW.generation
  )
  AND OLD.deletion_started_at IS NOT NULL
  AND NEW.deletion_started_at IS OLD.deletion_started_at
  AND NEW.id IS OLD.id
  AND NEW.issuer IS OLD.issuer
  AND NEW.subject IS OLD.subject
  AND NEW.email IS OLD.email
  AND NEW.generation IS OLD.generation
  AND NEW.created_at IS OLD.created_at
  AND NEW.updated_at IS OLD.updated_at
)
AND NEW.deletion_started_at IS OLD.deletion_started_at
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;
