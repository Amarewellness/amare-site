-- AMARÉ billing administrators — per-admin credentials for membership billing changes.
-- Keys are stored only as salted scrypt hashes. The shared admin read token never authorizes
-- billing writes. First owner is enrolled out-of-band by a Netlify-authenticated operator
-- (scripts/membership-billing-admin-enroll.mjs); there is no HTTP bootstrap route.

CREATE TABLE amare_billing_admins (
  actor_id TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL,
  key_salt TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_algo TEXT NOT NULL DEFAULT 'scrypt-n16384-r8-p1-32',
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  key_rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  last_verified_at TIMESTAMPTZ,

  CONSTRAINT amare_billing_admins_actor_chk CHECK (actor_id ~ '^[a-z0-9][a-z0-9._-]{1,39}$'),
  CONSTRAINT amare_billing_admins_role_chk CHECK (role IN ('owner', 'superadmin')),
  CONSTRAINT amare_billing_admins_status_chk CHECK (status IN ('active', 'revoked')),
  CONSTRAINT amare_billing_admins_salt_chk CHECK (key_salt ~ '^[0-9a-f]{32,}$'),
  CONSTRAINT amare_billing_admins_hash_chk CHECK (key_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE amare_billing_auth_attempts (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT,
  ip_hash TEXT,
  success BOOLEAN NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX amare_billing_auth_attempts_actor_idx
  ON amare_billing_auth_attempts (actor_id, created_at DESC);

CREATE INDEX amare_billing_auth_attempts_ip_idx
  ON amare_billing_auth_attempts (ip_hash, created_at DESC);

CREATE TABLE amare_billing_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  subscription_record_id TEXT,
  operation_id TEXT,
  outcome TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX amare_billing_audit_log_actor_idx
  ON amare_billing_audit_log (actor_id, created_at DESC);

CREATE INDEX amare_billing_audit_log_subscription_idx
  ON amare_billing_audit_log (subscription_record_id, created_at DESC);
