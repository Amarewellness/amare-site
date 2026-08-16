-- AMARÉ Auth Phase 1 — identity store only.
-- Does not change Mindbody OAuth, booking, or Stripe.

CREATE TABLE amare_users (
  amare_user_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE amare_identities (
  id BIGSERIAL PRIMARY KEY,
  amare_user_id TEXT NOT NULL REFERENCES amare_users (amare_user_id),
  provider TEXT NOT NULL,
  provider_sub TEXT NOT NULL,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_private_relay BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT amare_identities_provider_chk
    CHECK (provider IN ('google', 'apple', 'email'))
);

CREATE UNIQUE INDEX amare_identities_provider_sub_uidx
  ON amare_identities (provider, provider_sub);

CREATE INDEX amare_identities_user_idx
  ON amare_identities (amare_user_id);

CREATE TABLE amare_studio_associations (
  id BIGSERIAL PRIMARY KEY,
  amare_user_id TEXT NOT NULL REFERENCES amare_users (amare_user_id),
  system TEXT NOT NULL DEFAULT 'mindbody',
  site_id TEXT NOT NULL,
  client_id BIGINT,
  status TEXT NOT NULL,
  claim_method TEXT NOT NULL DEFAULT 'none',
  claim_proof_ref TEXT,
  candidate_client_ids JSONB,
  block_reason TEXT,
  claimed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT amare_studio_assoc_system_chk
    CHECK (system IN ('mindbody')),
  CONSTRAINT amare_studio_assoc_status_chk
    CHECK (status IN ('unlinked', 'candidate', 'ambiguous', 'verified', 'linked', 'conflict')),
  CONSTRAINT amare_studio_assoc_claim_method_chk
    CHECK (
      claim_method IN (
        'none',
        'mb_sess_confirmed',
        'email_unique_confirmed',
        'email_phone_confirmed',
        'staff_manual'
      )
    ),
  CONSTRAINT amare_studio_assoc_block_reason_chk
    CHECK (
      block_reason IS NULL
      OR block_reason IN ('apple_relay', 'email_mismatch', 'duplicate_clients', 'session_conflict')
    ),
  CONSTRAINT amare_studio_assoc_active_has_client_chk
    CHECK (
      status NOT IN ('verified', 'linked')
      OR client_id IS NOT NULL
    )
);

-- A studio client cannot be verified/linked to two AMARÉ users.
CREATE UNIQUE INDEX amare_studio_assoc_site_client_active_uidx
  ON amare_studio_associations (site_id, client_id)
  WHERE status IN ('verified', 'linked') AND client_id IS NOT NULL;

-- A user cannot have two active associations on the same site.
CREATE UNIQUE INDEX amare_studio_assoc_user_site_active_uidx
  ON amare_studio_associations (amare_user_id, system, site_id)
  WHERE status IN ('verified', 'linked');

CREATE INDEX amare_studio_assoc_user_idx
  ON amare_studio_associations (amare_user_id);
