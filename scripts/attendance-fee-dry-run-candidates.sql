-- Read-only: AMARÉ attendance-fee dry-run candidates (production observation).
-- Run via Netlify DB console or: netlify database connect (then paste).
-- No PII beyond Mindbody numeric client_id already in the ledger.

SELECT
  visit_id,
  client_id,
  class_id,
  client_service_id,
  mindbody_product_id,
  fee_type,
  class_start_at,
  trigger_at,
  status,
  skip_reason,
  dry_run,
  created_at
FROM amare_attendance_fees
WHERE dry_run = TRUE
  AND skip_reason = 'dry_run_would_charge'
ORDER BY created_at DESC
LIMIT 100;
