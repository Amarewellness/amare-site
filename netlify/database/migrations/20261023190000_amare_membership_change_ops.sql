-- AMARÉ admin membership plan changes — durable operation ledger.
-- One row per admin-initiated change. The partial unique index is the per-subscription lock:
-- at most one operation may be in an active state for a subscription at any time.

CREATE TABLE amare_membership_change_operations (
  id UUID PRIMARY KEY,
  request_id TEXT NOT NULL,

  subscription_record_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  stripe_customer_id TEXT,
  mindbody_client_id BIGINT,

  actor_id TEXT NOT NULL,
  actor_role TEXT,

  from_sku TEXT NOT NULL,
  to_sku TEXT NOT NULL,
  direction TEXT NOT NULL,
  timing TEXT NOT NULL,
  billing_policy TEXT NOT NULL,

  preview_amount_cents INTEGER,
  preview_fingerprint TEXT,
  preview_created_at TIMESTAMPTZ,
  target_amount_cents INTEGER NOT NULL,
  effective_at TIMESTAMPTZ,

  status TEXT NOT NULL,

  stripe_product_id TEXT,
  stripe_price_id TEXT,
  stripe_invoice_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_schedule_id TEXT,
  stripe_idempotency_key TEXT,
  amount_charged_cents INTEGER,

  mindbody_sale_id TEXT,
  mindbody_client_service_id TEXT,

  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  acknowledgements JSONB NOT NULL DEFAULT '{}'::jsonb,

  error_code TEXT,
  error_message TEXT,
  recovery_note TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  CONSTRAINT amare_mco_request_id_uq UNIQUE (request_id),
  CONSTRAINT amare_mco_direction_chk CHECK (direction IN ('upgrade', 'downgrade')),
  CONSTRAINT amare_mco_timing_chk CHECK (timing IN ('immediate', 'next_cycle')),
  CONSTRAINT amare_mco_policy_chk
    CHECK (billing_policy IN ('new_cycle_no_credit', 'new_cycle_with_credit', 'scheduled_no_charge')),
  CONSTRAINT amare_mco_status_chk
    CHECK (status IN (
      'executing',
      'scheduled',
      'syncing',
      'needs_reconciliation',
      'completed',
      'payment_required',
      'failed',
      'canceled'
    )),
  CONSTRAINT amare_mco_sku_change_chk CHECK (from_sku <> to_sku)
);

CREATE UNIQUE INDEX amare_mco_one_active_per_subscription
  ON amare_membership_change_operations (subscription_record_id)
  WHERE status IN ('executing', 'scheduled', 'syncing', 'needs_reconciliation');

CREATE INDEX amare_mco_subscription_created_idx
  ON amare_membership_change_operations (subscription_record_id, created_at DESC);

CREATE INDEX amare_mco_status_updated_idx
  ON amare_membership_change_operations (status, updated_at DESC);
