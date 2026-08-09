CREATE TABLE IF NOT EXISTS opinion_source_metadata (
	opinion_id INTEGER PRIMARY KEY NOT NULL CHECK (opinion_id > 0),
	cluster_id INTEGER NOT NULL CHECK (cluster_id > 0),
	canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
	representation TEXT NOT NULL CHECK (representation IN ('html_with_citations', 'html', 'plain_text')),
	retrieved_at TEXT NOT NULL,
	fresh_until TEXT NOT NULL,
	content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
	object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024)
);

CREATE TABLE IF NOT EXISTS opinion_fetch_leases (
	opinion_id INTEGER PRIMARY KEY NOT NULL CHECK (opinion_id > 0),
	owner_token TEXT NOT NULL CHECK (length(owner_token) BETWEEN 1 AND 256),
	expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS opinion_fetch_leases_expiry_idx
	ON opinion_fetch_leases(expires_at);

CREATE TABLE IF NOT EXISTS cluster_source_metadata (
	cluster_id INTEGER PRIMARY KEY NOT NULL CHECK (cluster_id > 0),
	canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
	opinions_json TEXT NOT NULL CHECK (length(opinions_json) BETWEEN 1 AND 262144 AND json_valid(opinions_json)),
	retrieved_at TEXT NOT NULL,
	fresh_until TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cluster_fetch_leases (
	cluster_id INTEGER PRIMARY KEY NOT NULL CHECK (cluster_id > 0),
	owner_token TEXT NOT NULL CHECK (length(owner_token) BETWEEN 1 AND 256),
	expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS cluster_fetch_leases_expiry_idx
	ON cluster_fetch_leases(expires_at);
