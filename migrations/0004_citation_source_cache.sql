CREATE TABLE IF NOT EXISTS citation_source_states (
	normalized_citation TEXT PRIMARY KEY NOT NULL CHECK (length(normalized_citation) BETWEEN 1 AND 256),
	state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 1 AND 4096 AND json_valid(state_json)),
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citation_fetch_leases (
	normalized_citation TEXT PRIMARY KEY NOT NULL CHECK (length(normalized_citation) BETWEEN 1 AND 256),
	owner_token TEXT NOT NULL CHECK (length(owner_token) BETWEEN 1 AND 256),
	expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS citation_fetch_leases_expiry_idx
	ON citation_fetch_leases(expires_at);
