-- Supports daily batch reminder selection by class_start_at.

CREATE INDEX IF NOT EXISTS amare_class_reminders_scheduled_start_idx
  ON amare_class_reminders (status, class_start_at)
  WHERE status = 'scheduled';
