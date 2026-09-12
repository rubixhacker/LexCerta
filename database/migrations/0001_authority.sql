-- Compatibility: expand. Keep existing tables/columns through application promotion.
CREATE SCHEMA IF NOT EXISTS lexcerta;

CREATE TABLE lexcerta.customers (
    id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    retired_at timestamptz,
    retention_expires_at timestamptz
);
CREATE TABLE lexcerta.api_keys (
    public_id text PRIMARY KEY CHECK (public_id ~ '^[A-Za-z0-9-]{1,64}$'),
    customer_id text NOT NULL REFERENCES lexcerta.customers(id),
    environment text NOT NULL CHECK (environment IN ('production', 'test')),
    hmac_sha256_hex text NOT NULL CHECK (hmac_sha256_hex ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('active', 'revoked')),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
    revoked_at timestamptz,
    rotation_parent_id text REFERENCES lexcerta.api_keys(public_id) ON DELETE SET NULL,
    rotation_overlap_until timestamptz,
    minute_limit integer NOT NULL CHECK (minute_limit BETWEEN 1 AND 600),
    day_limit integer NOT NULL CHECK (day_limit BETWEEN 1 AND 10000),
    limits_version integer NOT NULL DEFAULT 0 CHECK (limits_version >= 0),
    retention_expires_at timestamptz NOT NULL,
    CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE TABLE lexcerta.api_key_admission_locks (
    public_id text PRIMARY KEY REFERENCES lexcerta.api_keys(public_id) ON DELETE CASCADE
);
CREATE TABLE lexcerta.key_admissions (
    public_id text NOT NULL REFERENCES lexcerta.api_keys(public_id) ON DELETE CASCADE,
    admitted_at timestamptz NOT NULL
);
CREATE INDEX key_admissions_window ON lexcerta.key_admissions(public_id, admitted_at);
CREATE INDEX key_admissions_retention ON lexcerta.key_admissions(admitted_at);
CREATE INDEX api_keys_retention ON lexcerta.api_keys(retention_expires_at);
CREATE TABLE lexcerta.admin_audit_events (
    id uuid PRIMARY KEY,
    action text NOT NULL CHECK (action IN ('key_issued', 'key_rotated', 'key_revoked', 'key_limits_changed')),
    actor_subject text NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 256),
    customer_id text NOT NULL REFERENCES lexcerta.customers(id),
    public_id text REFERENCES lexcerta.api_keys(public_id) ON DELETE SET NULL,
    environment text NOT NULL CHECK (environment IN ('production', 'test')),
    occurred_at timestamptz NOT NULL,
    retention_expires_at timestamptz NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 2048)
);
CREATE INDEX admin_audit_retention ON lexcerta.admin_audit_events(retention_expires_at);
CREATE TABLE lexcerta.upstream_budgets (
    credential_id text PRIMARY KEY CHECK (length(credential_id) BETWEEN 1 AND 128),
    enabled boolean NOT NULL DEFAULT false,
    state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 65536),
    max_minute integer NOT NULL DEFAULT 3 CHECK (max_minute BETWEEN 1 AND 3),
    max_hour integer NOT NULL DEFAULT 30 CHECK (max_hour BETWEEN 1 AND 30),
    max_day integer NOT NULL DEFAULT 80 CHECK (max_day BETWEEN 1 AND 80),
    daily_reserve integer NOT NULL DEFAULT 20 CHECK (daily_reserve >= 20)
);
CREATE TABLE lexcerta.upstream_attempts (
    credential_id text NOT NULL REFERENCES lexcerta.upstream_budgets(credential_id),
    token text NOT NULL CHECK (length(token) BETWEEN 1 AND 128),
    kind text NOT NULL CHECK (kind IN ('citation', 'case_law', 'quota_sync')),
    reserved_at timestamptz NOT NULL,
    completed_at timestamptz,
    PRIMARY KEY (credential_id, token)
);
CREATE INDEX upstream_attempts_window ON lexcerta.upstream_attempts(credential_id, reserved_at);

CREATE TABLE lexcerta.citation_sources (
    citation text PRIMARY KEY CHECK (length(citation) BETWEEN 1 AND 256),
    state jsonb CHECK (octet_length(state::text) <= 4096),
    epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    owner_token text CHECK (length(owner_token) BETWEEN 1 AND 128),
    lease_expires_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((owner_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE TABLE lexcerta.opinion_sources (
    opinion_id bigint PRIMARY KEY CHECK (opinion_id > 0),
    state jsonb CHECK (octet_length(state::text) <= 8192),
    epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    owner_token text CHECK (length(owner_token) BETWEEN 1 AND 128),
    lease_expires_at timestamptz,
    removed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((owner_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE TABLE lexcerta.source_objects (
    object_key text PRIMARY KEY CHECK (length(object_key) BETWEEN 1 AND 1024),
    opinion_id bigint NOT NULL REFERENCES lexcerta.opinion_sources(opinion_id),
    epoch bigint NOT NULL CHECK (epoch > 0),
    content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
    representation text NOT NULL CHECK (representation IN ('plain_text', 'html', 'html_with_citations')),
    byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 1048576),
    generation text CHECK (generation ~ '^[0-9]{1,32}$'),
    acquired_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at <= acquired_at + interval '720 hours'),
    phase text NOT NULL CHECK (phase IN ('uploading', 'ready', 'deleting')),
    delete_token uuid,
    delete_after timestamptz,
    CHECK (phase <> 'ready' OR generation IS NOT NULL)
);
CREATE INDEX source_objects_expiry ON lexcerta.source_objects(expires_at);
CREATE INDEX source_objects_opinion ON lexcerta.source_objects(opinion_id);
-- Marks survive a lost delete acknowledgement. Publishers cannot attach a key
-- while any of its generations is being collected.
CREATE TABLE lexcerta.orphan_object_deletions (
    object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
    generation text NOT NULL CHECK (generation ~ '^[0-9]{1,32}$'),
    marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (object_key, generation)
);
CREATE TABLE lexcerta.cache_capacity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    max_opinions integer NOT NULL DEFAULT 1000 CHECK (max_opinions BETWEEN 1 AND 1000),
    max_bytes bigint NOT NULL DEFAULT 268435456 CHECK (max_bytes BETWEEN 1 AND 268435456)
);
INSERT INTO lexcerta.cache_capacity(singleton) VALUES (true);

ALTER TABLE lexcerta.opinion_sources ADD COLUMN body_key text REFERENCES lexcerta.source_objects(object_key) ON DELETE SET NULL;
ALTER TABLE lexcerta.opinion_sources ADD CONSTRAINT body_matches_state CHECK (
    body_key IS NULL OR coalesce(state->>'kind' = 'positive' AND state->'positive'->>'objectKey' = body_key, false)
);
ALTER TABLE lexcerta.opinion_sources ADD CONSTRAINT removed_body_absent CHECK (removed_at IS NULL OR body_key IS NULL);
