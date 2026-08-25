-- AMARÉ app account deletion (MVP).
-- Soft-delete amare_users tombstone; release email identity for Policy A re-registration.

ALTER TABLE amare_users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;

ALTER TABLE amare_users
  DROP CONSTRAINT IF EXISTS amare_users_status_chk;

ALTER TABLE amare_users
  ADD CONSTRAINT amare_users_status_chk
  CHECK (status IN ('active', 'deleted'));

CREATE INDEX IF NOT EXISTS amare_users_status_idx
  ON amare_users (status)
  WHERE status = 'deleted';

ALTER TABLE amare_studio_associations
  DROP CONSTRAINT IF EXISTS amare_studio_assoc_block_reason_chk;

ALTER TABLE amare_studio_associations
  ADD CONSTRAINT amare_studio_assoc_block_reason_chk
  CHECK (
    block_reason IS NULL
    OR block_reason IN (
      'apple_relay',
      'email_mismatch',
      'duplicate_clients',
      'session_conflict',
      'shared_computer_continue_as_new',
      'staff_zero_match',
      'staff_search_unavailable',
      'client_owned_elsewhere',
      'account_deleted'
    )
  );
