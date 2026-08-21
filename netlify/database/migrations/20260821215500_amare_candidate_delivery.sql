-- Candidate delivery claim/result. Does not enable global automatic Push.

ALTER TABLE amare_notification_candidates
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_result TEXT;

ALTER TABLE amare_notification_candidates
  DROP CONSTRAINT IF EXISTS amare_notification_candidates_delivery_status_chk;

ALTER TABLE amare_notification_candidates
  ADD CONSTRAINT amare_notification_candidates_delivery_status_chk
  CHECK (delivery_status IN ('pending', 'claimed', 'delivered', 'skipped'));

CREATE INDEX IF NOT EXISTS amare_notification_candidates_delivery_idx
  ON amare_notification_candidates (delivery_status, created_at);

-- Historical book/cancel candidates are never eligible for the QA auto sender.
UPDATE amare_notification_candidates
   SET delivery_status = 'skipped',
       delivery_result = 'historical_before_qa_boundary'
 WHERE delivery_status = 'pending'
   AND kind IN ('booking_created', 'booking_cancelled');
