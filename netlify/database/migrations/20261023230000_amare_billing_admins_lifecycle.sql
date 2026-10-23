-- Billing admin credential lifecycle.
-- must_rotate: the key was set by someone else (bootstrap migration / enrolling owner); only
--              key rotation is allowed until the admin sets their own key.
-- expires_at:  optional hard expiry (temporary credentials); expired rows never authenticate.

ALTER TABLE amare_billing_admins ADD COLUMN must_rotate BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE amare_billing_admins ADD COLUMN expires_at TIMESTAMPTZ;
