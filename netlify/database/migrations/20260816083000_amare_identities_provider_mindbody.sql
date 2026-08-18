-- AMARÉ Auth 2A.1 — allow Mindbody as an identity provider.
-- Does not change associations, booking, or Mindbody OAuth.
-- Do not edit 20260816000100_amare_identity.sql (already applied).

ALTER TABLE amare_identities
  DROP CONSTRAINT amare_identities_provider_chk;

ALTER TABLE amare_identities
  ADD CONSTRAINT amare_identities_provider_chk
  CHECK (provider IN ('google', 'apple', 'email', 'mindbody'));
