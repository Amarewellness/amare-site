-- AMARÉ Notifications foundation.
-- Durable inbox, booking/waitlist/class/reminder state, prefs, installations.
-- Does not send FCM. Does not change auth, booking, or Stripe.

CREATE TABLE amare_notification_inbox (
  message_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  site_id BIGINT,
  event_origination_at TIMESTAMPTZ,
  transaction_key TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT amare_notification_inbox_status_chk
    CHECK (status IN ('pending', 'processed', 'ignored', 'failed'))
);

CREATE INDEX amare_notification_inbox_status_idx
  ON amare_notification_inbox (status, received_at);

CREATE INDEX amare_notification_inbox_site_idx
  ON amare_notification_inbox (site_id, received_at DESC)
  WHERE site_id IS NOT NULL;

CREATE TABLE amare_class_descriptions (
  site_id BIGINT NOT NULL,
  class_description_id BIGINT NOT NULL,
  class_name TEXT,
  last_event_origination_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, class_description_id)
);

CREATE TABLE amare_roster_bookings (
  site_id BIGINT NOT NULL,
  class_roster_booking_id BIGINT NOT NULL,
  class_id BIGINT,
  client_id BIGINT,
  amare_user_id TEXT,
  class_start_at TIMESTAMPTZ,
  class_name TEXT,
  client_pass_id TEXT,
  item_id BIGINT,
  item_name TEXT,
  last_message_id TEXT,
  status TEXT NOT NULL,
  originated_from_waitlist BOOLEAN NOT NULL DEFAULT FALSE,
  last_event_origination_at TIMESTAMPTZ NOT NULL,
  transaction_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, class_roster_booking_id),
  CONSTRAINT amare_roster_bookings_status_chk
    CHECK (status IN ('booked', 'cancelled', 'early_cancelled', 'late_cancelled'))
);

CREATE INDEX amare_roster_bookings_user_idx
  ON amare_roster_bookings (amare_user_id)
  WHERE amare_user_id IS NOT NULL;

CREATE INDEX amare_roster_bookings_class_idx
  ON amare_roster_bookings (site_id, class_id);

CREATE INDEX amare_roster_bookings_active_class_idx
  ON amare_roster_bookings (site_id, class_id)
  WHERE status = 'booked';

CREATE TABLE amare_waitlist_entries (
  site_id BIGINT NOT NULL,
  waitlist_entry_id BIGINT NOT NULL,
  class_id BIGINT,
  client_id BIGINT,
  amare_user_id TEXT,
  class_start_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  last_event_origination_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, waitlist_entry_id),
  CONSTRAINT amare_waitlist_entries_status_chk
    CHECK (status IN ('active', 'cancelled', 'promoted'))
);

CREATE INDEX amare_waitlist_entries_lookup_idx
  ON amare_waitlist_entries (site_id, class_id, client_id);

CREATE TABLE amare_class_notification_state (
  site_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  start_at TIMESTAMPTZ,
  is_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  staff_id BIGINT,
  class_description_id BIGINT,
  class_name TEXT,
  last_event_origination_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, class_id)
);

CREATE INDEX amare_class_notification_state_desc_idx
  ON amare_class_notification_state (site_id, class_description_id)
  WHERE class_description_id IS NOT NULL;

CREATE TABLE amare_class_reminders (
  reminder_id TEXT PRIMARY KEY,
  amare_user_id TEXT NOT NULL,
  site_id BIGINT NOT NULL,
  class_id BIGINT,
  class_roster_booking_id BIGINT NOT NULL,
  reminder_type TEXT NOT NULL DEFAULT 'class_reminder',
  class_start_at TIMESTAMPTZ,
  scheduled_for TIMESTAMPTZ,
  status TEXT NOT NULL,
  last_event_origination_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT amare_class_reminders_status_chk
    CHECK (status IN ('scheduled', 'cancelled', 'due', 'suppressed', 'sent')),
  CONSTRAINT amare_class_reminders_type_chk
    CHECK (reminder_type IN ('class_reminder'))
);

CREATE UNIQUE INDEX amare_class_reminders_booking_uidx
  ON amare_class_reminders (amare_user_id, site_id, class_roster_booking_id, reminder_type);

CREATE INDEX amare_class_reminders_due_idx
  ON amare_class_reminders (status, scheduled_for);

CREATE TABLE amare_notification_preferences (
  amare_user_id TEXT PRIMARY KEY,
  class_booking_updates BOOLEAN NOT NULL DEFAULT TRUE,
  class_reminders BOOLEAN NOT NULL DEFAULT TRUE,
  waitlist_updates BOOLEAN NOT NULL DEFAULT TRUE,
  studio_news BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE amare_push_installations (
  installation_id TEXT PRIMARY KEY,
  amare_user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  push_token TEXT,
  permission_state TEXT NOT NULL DEFAULT 'unknown',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT amare_push_installations_platform_chk
    CHECK (platform IN ('android', 'ios', 'web')),
  CONSTRAINT amare_push_installations_permission_chk
    CHECK (permission_state IN ('unknown', 'prompt', 'granted', 'denied', 'revoked'))
);

CREATE INDEX amare_push_installations_user_idx
  ON amare_push_installations (amare_user_id)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX amare_push_installations_token_uidx
  ON amare_push_installations (push_token)
  WHERE push_token IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE amare_notification_candidates (
  candidate_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  amare_user_id TEXT,
  site_id BIGINT,
  class_id BIGINT,
  class_roster_booking_id BIGINT,
  waitlist_entry_id BIGINT,
  transaction_key TEXT,
  suppress_push BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT amare_notification_candidates_kind_chk
    CHECK (
      kind IN (
        'booking_created',
        'booking_cancelled',
        'waitlist_joined',
        'waitlist_removed',
        'waitlist_promoted',
        'class_cancelled',
        'class_time_changed',
        'class_reminder_due'
      )
    )
);

CREATE INDEX amare_notification_candidates_user_idx
  ON amare_notification_candidates (amare_user_id, created_at DESC);
