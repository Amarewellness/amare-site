-- AMARÉ Auth 2A.5 — Email OTP challenges.
-- Forward-only. Does not edit Phase 1 / 2A.1 migrations.
-- Does not change Mindbody OAuth, booking, or Stripe.

CREATE TABLE amare_otp_challenges (
  id BIGSERIAL PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_key TEXT
);

CREATE INDEX amare_otp_challenges_email_created_idx
  ON amare_otp_challenges (email_normalized, created_at DESC);

CREATE INDEX amare_otp_challenges_request_key_created_idx
  ON amare_otp_challenges (request_key, created_at DESC);

-- Allow the 2A.3/2A.5 shared-computer continue-as-new marker on associations.
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
      'shared_computer_continue_as_new'
    )
  );
