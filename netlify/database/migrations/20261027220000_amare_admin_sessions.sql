-- Server-side admin sessions. The cookie holds an opaque id; only its hash is stored.
-- Frontdesk rows have a null actor_id (shared studio login, read-only).
-- Owner and superadmin rows point at amare_billing_admins. Revoking that admin
-- invalidates these sessions. There is no HTTP route that creates the first owner.

CREATE TABLE amare_admin_sessions (
  session_hash TEXT PRIMARY KEY,
  actor_id TEXT,
  role TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  ip_hash TEXT,

  CONSTRAINT amare_admin_sessions_role_chk CHECK (role IN ('owner', 'superadmin', 'frontdesk')),
  CONSTRAINT amare_admin_sessions_hash_chk CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT amare_admin_sessions_csrf_chk CHECK (csrf_token ~ '^[0-9a-f]{64}$'),
  CONSTRAINT amare_admin_sessions_actor_chk CHECK (
    (role = 'frontdesk' AND actor_id IS NULL)
    OR (role IN ('owner', 'superadmin') AND actor_id IS NOT NULL)
  )
);

CREATE INDEX amare_admin_sessions_actor_idx
  ON amare_admin_sessions (actor_id)
  WHERE revoked_at IS NULL;
