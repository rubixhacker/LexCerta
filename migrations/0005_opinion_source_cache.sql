CREATE TABLE IF NOT EXISTS opinion_source_states (
	opinion_id INTEGER PRIMARY KEY NOT NULL CHECK (opinion_id BETWEEN 1 AND 2147483647),
	state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 1 AND 8192 AND json_valid(state_json)),
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opinion_source_object_versions (
	opinion_id INTEGER NOT NULL CHECK (opinion_id BETWEEN 1 AND 2147483647),
	content_sha256_hex TEXT NOT NULL CHECK (length(content_sha256_hex) = 64 AND content_sha256_hex NOT GLOB '*[^0-9a-f]*'),
	object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
	metadata_json TEXT NOT NULL CHECK (length(metadata_json) BETWEEN 1 AND 4096 AND json_valid(metadata_json)),
	stored_at TEXT NOT NULL,
	PRIMARY KEY (opinion_id, content_sha256_hex)
);

CREATE TABLE IF NOT EXISTS opinion_source_fetch_leases (
	opinion_id INTEGER PRIMARY KEY NOT NULL CHECK (opinion_id BETWEEN 1 AND 2147483647),
	owner_token TEXT NOT NULL CHECK (length(owner_token) BETWEEN 1 AND 256),
	expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS opinion_source_fetch_leases_expiry_idx
	ON opinion_source_fetch_leases(expires_at);
