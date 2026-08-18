-- AMARÉ Auth D28 — brand-new Email OTP Studio profile creation.
-- Forward-only. Does not edit Phase 1 / 2A.5 migrations.
-- Does not change Mindbody OAuth, booking, or Stripe.

ALTER TABLE amare_studio_associations
  DROP CONSTRAINT IF EXISTS amare_studio_assoc_claim_method_chk;

ALTER TABLE amare_studio_associations
  ADD CONSTRAINT amare_studio_assoc_claim_method_chk
  CHECK (
    claim_method IN (
      'none',
      'mb_sess_confirmed',
      'email_unique_confirmed',
      'email_phone_confirmed',
      'staff_manual',
      'new_profile_created'
    )
  );

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
      'client_owned_elsewhere'
    )
  );
