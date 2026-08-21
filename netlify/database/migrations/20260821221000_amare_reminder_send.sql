-- Reminder send claim/result. Does not change booking/cancel Push pipelines.

ALTER TABLE amare_class_reminders
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS amare_class_reminders_due_claim_idx
  ON amare_class_reminders (status, scheduled_for)
  WHERE status = 'scheduled';
