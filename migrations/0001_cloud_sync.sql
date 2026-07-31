PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9000000000000000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deletion_started_at TEXT,
  UNIQUE (issuer, subject),
  UNIQUE (id, generation)
);

CREATE TABLE cloud_sync_state (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('disabled', 'enabled', 'deleting')),
  generation INTEGER NOT NULL DEFAULT 0
    CHECK (generation BETWEEN 0 AND 9000000000000000),
  last_deleted_generation INTEGER
    CHECK (last_deleted_generation BETWEEN 0 AND 9000000000000000),
  updated_at TEXT NOT NULL,
  CHECK (last_deleted_generation IS NULL OR last_deleted_generation < generation)
);

CREATE TABLE ledger_settings (
  user_id TEXT PRIMARY KEY,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  id TEXT NOT NULL DEFAULT 'primary' CHECK (id = 'primary'),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  initial_balance_minor INTEGER NOT NULL
    CHECK (initial_balance_minor BETWEEN -9000000000000000 AND 9000000000000000),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 128),
  last_mutation_hash TEXT NOT NULL CHECK (length(last_mutation_hash) = 64),
  server_updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id, account_generation)
    REFERENCES users(id, generation) ON DELETE CASCADE
);

CREATE TABLE ledger_entries (
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL
    CHECK (amount_minor != 0 AND amount_minor BETWEEN -9000000000000000 AND 9000000000000000),
  note TEXT NOT NULL CHECK (length(note) <= 200),
  occurred_at TEXT NOT NULL,
  local_date_key TEXT NOT NULL CHECK (length(local_date_key) = 10),
  local_month_key TEXT NOT NULL CHECK (length(local_month_key) = 7),
  timezone_offset_minutes INTEGER NOT NULL
    CHECK (timezone_offset_minutes BETWEEN -840 AND 840),
  attachment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 128),
  last_mutation_hash TEXT NOT NULL CHECK (length(last_mutation_hash) = 64),
  server_updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, account_generation)
    REFERENCES users(id, generation) ON DELETE CASCADE
);

CREATE TABLE attachments (
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type = 'image/jpeg'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 2048),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 2048),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, r2_key),
  CHECK (
    substr(
      r2_key,
      1,
      length(user_id || '/g' || account_generation || '/' || id || '/')
    ) = user_id || '/g' || account_generation || '/' || id || '/'
  ),
  FOREIGN KEY (user_id, account_generation)
    REFERENCES users(id, generation) ON DELETE CASCADE
);

CREATE TABLE sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('entry', 'settings')),
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

CREATE TABLE attachment_cleanup (
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  attachment_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, account_generation, attachment_id, r2_key),
  CHECK (
    substr(
      r2_key,
      1,
      length(user_id || '/g' || account_generation || '/' || attachment_id || '/')
    ) = user_id || '/g' || account_generation || '/' || attachment_id || '/'
  ),
  FOREIGN KEY (user_id, account_generation)
    REFERENCES users(id, generation) ON DELETE CASCADE
);

CREATE TABLE cloud_attachment_cleanup (
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  attachment_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, account_generation, attachment_id, r2_key),
  CHECK (
    substr(
      r2_key,
      1,
      length(user_id || '/g' || account_generation || '/' || attachment_id || '/')
    ) = user_id || '/g' || account_generation || '/' || attachment_id || '/'
  )
);

CREATE TABLE cloud_upload_leases (
  user_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL
    CHECK (account_generation BETWEEN 1 AND 9000000000000000),
  lease_id TEXT NOT NULL CHECK (length(lease_id) BETWEEN 1 AND 128),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, account_generation, lease_id),
  FOREIGN KEY (user_id, account_generation)
    REFERENCES users(id, generation) ON DELETE CASCADE
);

CREATE INDEX idx_ledger_entries_user_date
  ON ledger_entries(user_id, local_date_key DESC, occurred_at DESC);
CREATE INDEX idx_ledger_entries_user_deleted
  ON ledger_entries(user_id, deleted_at);
CREATE INDEX idx_attachments_user_entry
  ON attachments(user_id, entry_id);
CREATE INDEX idx_sync_changes_user_seq
  ON sync_changes(user_id, seq);
CREATE INDEX idx_sync_changes_user_entity
  ON sync_changes(user_id, entity_type, entity_id, seq DESC);
CREATE INDEX idx_attachment_cleanup_user_created
  ON attachment_cleanup(user_id, account_generation, created_at);
CREATE INDEX idx_cloud_attachment_cleanup_user_created
  ON cloud_attachment_cleanup(user_id, account_generation, created_at);
CREATE INDEX idx_cloud_upload_leases_user_expiry
  ON cloud_upload_leases(user_id, account_generation, expires_at);

CREATE TRIGGER users_block_insert_when_sync_inactive
BEFORE INSERT ON users
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.id AND status = 'enabled' AND generation = NEW.generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER users_block_update_when_sync_inactive
BEFORE UPDATE ON users
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.id AND status = 'enabled' AND generation = NEW.generation
)
AND NEW.deletion_started_at IS OLD.deletion_started_at
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER cloud_upload_leases_block_insert_when_sync_inactive
BEFORE INSERT ON cloud_upload_leases
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER ledger_entries_block_insert_when_sync_inactive
BEFORE INSERT ON ledger_entries
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER ledger_entries_block_update_when_sync_inactive
BEFORE UPDATE ON ledger_entries
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER ledger_settings_block_insert_when_sync_inactive
BEFORE INSERT ON ledger_settings
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER ledger_settings_block_update_when_sync_inactive
BEFORE UPDATE ON ledger_settings
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER attachments_block_insert_when_sync_inactive
BEFORE INSERT ON attachments
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER attachments_block_update_when_sync_inactive
BEFORE UPDATE ON attachments
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER attachment_cleanup_block_insert_when_sync_inactive
BEFORE INSERT ON attachment_cleanup
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

CREATE TRIGGER attachment_cleanup_block_update_when_sync_inactive
BEFORE UPDATE ON attachment_cleanup
WHEN NOT EXISTS (
  SELECT 1 FROM cloud_sync_state
  WHERE user_id = NEW.user_id AND status = 'enabled'
    AND generation = NEW.account_generation
)
BEGIN
  SELECT RAISE(ABORT, 'stale_cloud_generation');
END;

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
        json_object(
          'id', NEW.id,
          'amountMinor', NEW.amount_minor,
          'note', NEW.note,
          'occurredAt', NEW.occurred_at,
          'localDateKey', NEW.local_date_key,
          'localMonthKey', NEW.local_month_key,
          'timezoneOffsetMinutes', NEW.timezone_offset_minutes,
          'createdAt', NEW.created_at,
          'updatedAt', NEW.updated_at
        ),
        CASE WHEN NEW.attachment_id IS NULL
          THEN '{}'
          ELSE json_object('attachmentId', NEW.attachment_id)
        END
      ),
      CASE WHEN NEW.deleted_at IS NULL
        THEN '{}'
        ELSE json_object('deletedAt', NEW.deleted_at)
      END
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
        json_object(
          'id', NEW.id,
          'amountMinor', NEW.amount_minor,
          'note', NEW.note,
          'occurredAt', NEW.occurred_at,
          'localDateKey', NEW.local_date_key,
          'localMonthKey', NEW.local_month_key,
          'timezoneOffsetMinutes', NEW.timezone_offset_minutes,
          'createdAt', NEW.created_at,
          'updatedAt', NEW.updated_at
        ),
        CASE WHEN NEW.attachment_id IS NULL
          THEN '{}'
          ELSE json_object('attachmentId', NEW.attachment_id)
        END
      ),
      CASE WHEN NEW.deleted_at IS NULL
        THEN '{}'
        ELSE json_object('deletedAt', NEW.deleted_at)
      END
    ),
    NEW.server_updated_at
  );
END;

CREATE TRIGGER ledger_entries_attachment_cleanup_after_update
AFTER UPDATE ON ledger_entries
WHEN OLD.attachment_id IS NOT NULL
  AND OLD.attachment_id IS NOT NEW.attachment_id
BEGIN
  INSERT INTO attachment_cleanup (
    user_id, account_generation, attachment_id, r2_key, created_at
  )
  SELECT OLD.user_id, OLD.account_generation, OLD.attachment_id, r2_key,
         NEW.server_updated_at
  FROM attachments
  WHERE user_id = OLD.user_id
    AND account_generation = OLD.account_generation
    AND id = OLD.attachment_id
  ON CONFLICT(user_id, account_generation, attachment_id, r2_key) DO NOTHING;
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
