CREATE TABLE IF NOT EXISTS customers (
	id TEXT PRIMARY KEY NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	retired_at TEXT
);

CREATE TABLE IF NOT EXISTS api_key_records (
	public_id TEXT PRIMARY KEY NOT NULL,
	customer_id TEXT NOT NULL REFERENCES customers(id),
	environment TEXT NOT NULL CHECK (environment IN ('production', 'test')),
	hmac_sha256_hex TEXT NOT NULL CHECK (length(hmac_sha256_hex) = 64),
	status TEXT NOT NULL CHECK (status IN ('active', 'revoked')) DEFAULT 'active',
	issued_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	revoked_at TEXT,
	rotation_parent_id TEXT REFERENCES api_key_records(public_id),
	rotation_overlap_until TEXT,
	minute_limit INTEGER NOT NULL DEFAULT 60 CHECK (minute_limit > 0),
	day_limit INTEGER NOT NULL DEFAULT 1000 CHECK (day_limit > 0),
	last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS api_key_records_customer_idx ON api_key_records(customer_id);
CREATE INDEX IF NOT EXISTS api_key_records_active_idx ON api_key_records(environment, status, expires_at);
