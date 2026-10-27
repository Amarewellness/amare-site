-- The configured admin username was briefly given front-desk sessions.
-- Those sessions cannot be upgraded in place. Revoke them so the next sign-in
-- is the Owner session. Owner and superadmin sessions are left as they are.

UPDATE amare_admin_sessions
SET revoked_at = NOW()
WHERE role = 'frontdesk' AND revoked_at IS NULL;
