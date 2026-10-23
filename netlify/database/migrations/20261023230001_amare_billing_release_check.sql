-- Billing admin "qa-release-check" (superadmin). Salted scrypt hash only; no plaintext key.

-- Expires 2 hours after this migration is applied.

INSERT INTO amare_billing_admins (actor_id, display_name, role, key_salt, key_hash, created_by, must_rotate, expires_at)
VALUES ('qa-release-check', 'Release check (temporary, expires 2h)', 'superadmin', '30b2f28958f76dd9cd47712838b2007d', '753f1643b72d9f0fd454bfd85a8f6f61cf685a2aa547e83b822ccc0cac468a6f', 'netlify:snir1212@gmail.com', FALSE, NOW() + INTERVAL '2 hours')
ON CONFLICT (actor_id) DO NOTHING;

INSERT INTO amare_billing_audit_log (actor_id, action, outcome, detail)
VALUES ('netlify:snir1212@gmail.com', 'migration_enroll', 'ok', '{"enrolled":"qa-release-check","role":"superadmin","mustRotate":false,"expires":"2 hours"}'::jsonb);
