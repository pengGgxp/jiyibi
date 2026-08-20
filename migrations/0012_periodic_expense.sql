-- v9 stores the analysis treatment separately from the legacy v5-v8 shadow.
-- The shadow cannot represent periodic expenses, so they project as one-time
-- expenses for storage compatibility while older clients are blocked.
ALTER TABLE ledger_entries
  ADD COLUMN analysis_treatment TEXT
  CHECK (
    analysis_treatment IS NULL
    OR analysis_treatment IN (
      'ordinary_expense',
      'periodic_expense',
      'one_time_expense',
      'reimbursable_expense',
      'ordinary_income',
      'refund_reimbursement',
      'account_transfer'
    )
  );

UPDATE ledger_entries
SET analysis_treatment = treatment;

CREATE INDEX idx_ledger_entries_user_analysis_treatment
  ON ledger_entries(
    user_id,
    account_generation,
    analysis_treatment,
    deleted_at
  );

DROP TRIGGER ledger_entries_analysis_fields_before_insert;
DROP TRIGGER ledger_entries_analysis_fields_before_update;
DROP TRIGGER recovery_allocations_validate_before_insert;
DROP TRIGGER recovery_allocations_validate_before_update;
DROP TRIGGER ledger_entries_preserve_active_recovery_before_update;

-- Old Workers omit analysis_treatment during the short migration rollout
-- window. Their inserts remain valid and are promoted to the canonical column
-- immediately after the row is written.
CREATE TRIGGER ledger_entries_analysis_fields_before_insert
BEFORE INSERT ON ledger_entries
WHEN NEW.treatment IS NULL
  OR (
    NEW.analysis_treatment IS NOT NULL
    AND NEW.analysis_treatment NOT IN (
      'ordinary_expense',
      'periodic_expense',
      'one_time_expense',
      'reimbursable_expense',
      'ordinary_income',
      'refund_reimbursement',
      'account_transfer'
    )
  )
  OR (
    NEW.analysis_treatment IS NOT NULL
    AND NEW.treatment IS NOT CASE NEW.analysis_treatment
      WHEN 'periodic_expense' THEN 'one_time_expense'
      ELSE NEW.analysis_treatment
    END
  )
  OR (
    COALESCE(NEW.analysis_treatment, NEW.treatment) IN (
      'ordinary_expense',
      'periodic_expense',
      'one_time_expense',
      'reimbursable_expense'
    )
    AND NEW.amount_minor >= 0
  )
  OR (
    COALESCE(NEW.analysis_treatment, NEW.treatment) IN (
      'ordinary_income', 'refund_reimbursement'
    )
    AND NEW.amount_minor <= 0
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_entry_treatment');
END;

CREATE TRIGGER ledger_entries_analysis_treatment_after_legacy_insert
AFTER INSERT ON ledger_entries
WHEN NEW.analysis_treatment IS NULL
BEGIN
  UPDATE ledger_entries
  SET analysis_treatment = NEW.treatment
  WHERE user_id = NEW.user_id
    AND account_generation = NEW.account_generation
    AND id = NEW.id;
END;

-- A treatment-only update is a legacy Worker write. It may update any
-- representable treatment, but it cannot rewrite an existing periodic fact.
CREATE TRIGGER ledger_entries_analysis_fields_before_update
BEFORE UPDATE ON ledger_entries
WHEN NEW.analysis_treatment IS NULL
  OR NEW.analysis_treatment NOT IN (
    'ordinary_expense',
    'periodic_expense',
    'one_time_expense',
    'reimbursable_expense',
    'ordinary_income',
    'refund_reimbursement',
    'account_transfer'
  )
  OR (
    OLD.analysis_treatment = 'periodic_expense'
    AND NEW.analysis_treatment IS OLD.analysis_treatment
    AND NEW.treatment IS NOT OLD.treatment
  )
  OR (
    NOT (
      NEW.analysis_treatment IS OLD.analysis_treatment
      AND NEW.treatment IS NOT OLD.treatment
    )
    AND NEW.treatment IS NOT CASE NEW.analysis_treatment
      WHEN 'periodic_expense' THEN 'one_time_expense'
      ELSE NEW.analysis_treatment
    END
  )
  OR (
    CASE
      WHEN NEW.analysis_treatment IS OLD.analysis_treatment
        AND NEW.treatment IS NOT OLD.treatment
      THEN NEW.treatment
      ELSE NEW.analysis_treatment
    END IN (
      'ordinary_expense',
      'periodic_expense',
      'one_time_expense',
      'reimbursable_expense'
    )
    AND NEW.amount_minor >= 0
  )
  OR (
    CASE
      WHEN NEW.analysis_treatment IS OLD.analysis_treatment
        AND NEW.treatment IS NOT OLD.treatment
      THEN NEW.treatment
      ELSE NEW.analysis_treatment
    END IN ('ordinary_income', 'refund_reimbursement')
    AND NEW.amount_minor <= 0
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_entry_treatment');
END;

CREATE TRIGGER ledger_entries_analysis_treatment_after_legacy_update
AFTER UPDATE ON ledger_entries
WHEN OLD.analysis_treatment <> 'periodic_expense'
  AND NEW.analysis_treatment IS OLD.analysis_treatment
  AND NEW.treatment IS NOT OLD.treatment
BEGIN
  UPDATE ledger_entries
  SET analysis_treatment = NEW.treatment
  WHERE user_id = NEW.user_id
    AND account_generation = NEW.account_generation
    AND id = NEW.id;
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
      AND analysis_treatment = 'refund_reimbursement'
      AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'invalid_recovery_refund') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND id = NEW.expense_entry_id
      AND amount_minor < 0
      AND analysis_treatment IN (
        'ordinary_expense',
        'periodic_expense',
        'one_time_expense',
        'reimbursable_expense'
      )
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
      AND analysis_treatment = 'refund_reimbursement'
      AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'invalid_recovery_refund') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE user_id = NEW.user_id
      AND account_generation = NEW.account_generation
      AND id = NEW.expense_entry_id
      AND amount_minor < 0
      AND analysis_treatment IN (
        'ordinary_expense',
        'periodic_expense',
        'one_time_expense',
        'reimbursable_expense'
      )
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
    AND (refund_entry_id = NEW.id OR expense_entry_id = NEW.id)
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
      OR CASE
        WHEN NEW.analysis_treatment IS OLD.analysis_treatment
          AND NEW.treatment IS NOT OLD.treatment
        THEN NEW.treatment
        ELSE NEW.analysis_treatment
      END <> 'refund_reimbursement'
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
      OR CASE
        WHEN NEW.analysis_treatment IS OLD.analysis_treatment
          AND NEW.treatment IS NOT OLD.treatment
        THEN NEW.treatment
        ELSE NEW.analysis_treatment
      END NOT IN (
        'ordinary_expense',
        'periodic_expense',
        'one_time_expense',
        'reimbursable_expense'
      )
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
