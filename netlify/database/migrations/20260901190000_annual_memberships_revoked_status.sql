-- Add explicit `revoked` terminal status for admin stop-current-term (distinct from renewal cancel).

ALTER TABLE annual_memberships
  DROP CONSTRAINT IF EXISTS annual_memberships_status_chk;

ALTER TABLE annual_memberships
  ADD CONSTRAINT annual_memberships_status_chk
    CHECK (
      status IN (
        'pending',
        'active',
        'past_due',
        'canceled',
        'refunded',
        'completed',
        'revoked'
      )
    );
