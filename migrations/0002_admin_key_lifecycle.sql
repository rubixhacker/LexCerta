ALTER TABLE customers ADD COLUMN retention_expires_at TEXT;
ALTER TABLE api_key_records ADD COLUMN retention_expires_at TEXT;

CREATE TABLE IF NOT EXISTS admin_audit_events (
	id TEXT PRIMARY KEY NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('key_issued', 'key_rotated', 'key_revoked', 'key_limits_changed')),
	actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 256),
	customer_id TEXT NOT NULL REFERENCES customers(id),
	public_id TEXT REFERENCES api_key_records(public_id) ON DELETE SET NULL,
	environment TEXT NOT NULL CHECK (environment IN ('production', 'test')),
	occurred_at TEXT NOT NULL,
	retention_expires_at TEXT NOT NULL,
	metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (length(metadata_json) <= 2048)
);

CREATE INDEX IF NOT EXISTS admin_audit_events_retention_idx
	ON admin_audit_events(retention_expires_at);
CREATE INDEX IF NOT EXISTS admin_audit_events_customer_idx
	ON admin_audit_events(customer_id, occurred_at);

CREATE INDEX IF NOT EXISTS api_key_records_retention_idx
	ON api_key_records(retention_expires_at);
