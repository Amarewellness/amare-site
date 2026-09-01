-- AMARÉ Annual Membership Phase 1 — Postgres entitlement ledger.
-- Stripe = financial source of truth; this schema = annual period ledger.
-- Does not modify Mindbody, Stripe checkout, or monthly membership flows.

CREATE TABLE annual_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amare_user_id TEXT,
  mindbody_client_id BIGINT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT NOT NULL,
  stripe_invoice_id TEXT NOT NULL,
  stripe_price_id TEXT,
  sku TEXT NOT NULL,
  status TEXT NOT NULL,
  term_start_date DATE NOT NULL,
  term_end_date DATE NOT NULL,
  stripe_period_start_at TIMESTAMPTZ,
  stripe_period_end_at TIMESTAMPTZ,
  annual_amount_cents INTEGER NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT annual_memberships_status_chk
    CHECK (status IN ('pending', 'active', 'past_due', 'canceled', 'refunded', 'completed')),
  CONSTRAINT annual_memberships_annual_amount_positive_chk
    CHECK (annual_amount_cents > 0)
);

CREATE UNIQUE INDEX annual_memberships_stripe_invoice_uidx
  ON annual_memberships (stripe_invoice_id);

CREATE UNIQUE INDEX annual_memberships_sub_term_start_uidx
  ON annual_memberships (stripe_subscription_id, term_start_date);

CREATE INDEX annual_memberships_mindbody_client_idx
  ON annual_memberships (mindbody_client_id);

CREATE INDEX annual_memberships_amare_user_idx
  ON annual_memberships (amare_user_id)
  WHERE amare_user_id IS NOT NULL;

CREATE TABLE annual_membership_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  annual_membership_id UUID NOT NULL REFERENCES annual_memberships (id) ON DELETE CASCADE,
  period_index INTEGER NOT NULL,
  period_start_date DATE NOT NULL,
  period_end_date DATE NOT NULL,
  status TEXT NOT NULL,
  mindbody_product_id INTEGER NOT NULL,
  expected_list_amount_cents INTEGER NOT NULL,
  expected_discount_amount_cents INTEGER NOT NULL,
  expected_net_amount_cents INTEGER NOT NULL,
  mindbody_sale_id BIGINT,
  mindbody_client_service_id BIGINT,
  claim_token UUID,
  claim_started_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  pre_issue_client_service_ids JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT annual_membership_periods_index_chk
    CHECK (period_index >= 0 AND period_index <= 11),
  CONSTRAINT annual_membership_periods_status_chk
    CHECK (
      status IN (
        'pending',
        'claiming',
        'issued',
        'failed',
        'ambiguous',
        'manual_review',
        'skipped'
      )
    ),
  CONSTRAINT annual_membership_periods_dates_chk
    CHECK (period_start_date < period_end_date),
  CONSTRAINT annual_membership_periods_expected_amounts_chk
    CHECK (
      expected_list_amount_cents > 0
      AND expected_discount_amount_cents >= 0
      AND expected_net_amount_cents > 0
      AND expected_list_amount_cents - expected_discount_amount_cents = expected_net_amount_cents
    )
);

CREATE UNIQUE INDEX annual_membership_periods_membership_index_uidx
  ON annual_membership_periods (annual_membership_id, period_index);

CREATE INDEX annual_membership_periods_status_start_idx
  ON annual_membership_periods (status, period_start_date);

CREATE INDEX annual_membership_periods_membership_idx
  ON annual_membership_periods (annual_membership_id);

CREATE INDEX annual_membership_periods_claim_started_idx
  ON annual_membership_periods (status, claim_started_at)
  WHERE status = 'claiming';
