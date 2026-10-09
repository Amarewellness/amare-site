-- AMARÉ attendance fees — Postgres ledger (Phase 1).
-- One row per Mindbody class visit; Unlimited visit-scoped $10 late cancel / no-show.
-- Does not charge Stripe in this migration; collection is a later phase.

CREATE TABLE amare_attendance_fees (
  visit_id BIGINT PRIMARY KEY,
  site_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  client_id BIGINT NOT NULL,
  client_service_id BIGINT,
  mindbody_product_id INTEGER,

  fee_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 1000,
  currency TEXT NOT NULL DEFAULT 'usd',

  status TEXT NOT NULL,
  failure_class TEXT,
  skip_reason TEXT,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,

  trigger_source TEXT NOT NULL,

  stripe_customer_id TEXT,
  stripe_invoice_id TEXT,
  stripe_payment_intent_id TEXT,

  failure_code TEXT,
  failure_message TEXT,

  processing_token UUID,
  processing_started_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,

  class_start_at TIMESTAMPTZ,
  trigger_at TIMESTAMPTZ NOT NULL,
  charged_at TIMESTAMPTZ,

  webhook_message_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT amare_attendance_fees_fee_type_chk
    CHECK (fee_type IN ('late_cancel', 'no_show')),
  CONSTRAINT amare_attendance_fees_status_chk
    CHECK (status IN ('pending', 'processing', 'charged', 'failed', 'waived', 'skipped')),
  CONSTRAINT amare_attendance_fees_failure_class_chk
    CHECK (failure_class IS NULL OR failure_class IN ('retryable', 'permanent')),
  CONSTRAINT amare_attendance_fees_amount_chk
    CHECK (amount_cents = 1000),
  CONSTRAINT amare_attendance_fees_currency_chk
    CHECK (currency = 'usd'),
  CONSTRAINT amare_attendance_fees_failed_requires_class_chk
    CHECK (status <> 'failed' OR failure_class IS NOT NULL)
);

CREATE INDEX amare_attendance_fees_status_created_idx
  ON amare_attendance_fees (status, created_at DESC);

CREATE INDEX amare_attendance_fees_client_created_idx
  ON amare_attendance_fees (client_id, created_at DESC);

CREATE INDEX amare_attendance_fees_class_idx
  ON amare_attendance_fees (class_id);

CREATE INDEX amare_attendance_fees_failure_class_idx
  ON amare_attendance_fees (failure_class)
  WHERE status = 'failed';

CREATE INDEX amare_attendance_fees_processable_idx
  ON amare_attendance_fees (status, next_retry_at, processing_started_at)
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX amare_attendance_fees_dry_run_idx
  ON amare_attendance_fees (dry_run, created_at DESC)
  WHERE dry_run = TRUE;
