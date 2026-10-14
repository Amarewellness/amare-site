-- POPUP + BOARD display types; one active row per display_type.

ALTER TABLE amare_app_announcements
  ADD COLUMN IF NOT EXISTS display_type TEXT NOT NULL DEFAULT 'popup';

UPDATE amare_app_announcements
   SET display_type = 'popup'
 WHERE display_type IS NULL OR display_type = '';

ALTER TABLE amare_app_announcements
  DROP CONSTRAINT IF EXISTS amare_app_announcements_display_type_chk;

ALTER TABLE amare_app_announcements
  ADD CONSTRAINT amare_app_announcements_display_type_chk
    CHECK (display_type IN ('popup', 'board'));

DROP INDEX IF EXISTS amare_app_announcements_one_active_uidx;

CREATE UNIQUE INDEX amare_app_announcements_one_active_per_type_uidx
  ON amare_app_announcements (display_type)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS amare_app_announcements_display_window_idx
  ON amare_app_announcements (display_type, is_active, starts_at, expires_at);
