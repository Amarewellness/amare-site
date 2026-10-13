-- AMARÉ in-app announcement MVP (one active row globally).

CREATE TABLE amare_app_announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  require_acknowledgment BOOLEAN NOT NULL DEFAULT false,
  cta_label TEXT NOT NULL DEFAULT 'Got it',
  cta_url TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT amare_app_announcements_expires_after_starts_chk
    CHECK (expires_at > starts_at),
  CONSTRAINT amare_app_announcements_title_len_chk
    CHECK (char_length(title) <= 120),
  CONSTRAINT amare_app_announcements_message_len_chk
    CHECK (char_length(message) <= 2000)
);

CREATE UNIQUE INDEX amare_app_announcements_one_active_uidx
  ON amare_app_announcements ((1))
  WHERE is_active = true;

CREATE INDEX amare_app_announcements_window_idx
  ON amare_app_announcements (is_active, starts_at, expires_at);

CREATE TABLE amare_app_announcement_receipts (
  announcement_id TEXT NOT NULL
    REFERENCES amare_app_announcements (id) ON DELETE CASCADE,
  amare_user_id TEXT NOT NULL
    REFERENCES amare_users (amare_user_id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NULL,
  acknowledged_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, amare_user_id)
);

CREATE INDEX amare_app_announcement_receipts_ann_first_seen_idx
  ON amare_app_announcement_receipts (announcement_id, first_seen_at);

CREATE INDEX amare_app_announcement_receipts_ann_ack_idx
  ON amare_app_announcement_receipts (announcement_id, acknowledged_at);
