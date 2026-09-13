-- Compatibility: expand. The earlier public/operator image ignores these tables.
CREATE TABLE lexcerta.maintenance_owner (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    owner_token uuid,
    lease_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at timestamptz,
    finished_at timestamptz,
    outcome text CHECK (outcome IN ('running', 'complete', 'partial', 'failed')),
    CHECK ((owner_token IS NULL) = (lease_expires_at IS NULL))
);
INSERT INTO lexcerta.maintenance_owner(singleton) VALUES (true);

CREATE TABLE lexcerta.maintenance_progress (
    name text PRIMARY KEY CHECK (name IN ('cleanup', 'lifecycle')),
    scheduled_for timestamptz,
    completed_for timestamptz,
    completed_at timestamptz,
    stage text NOT NULL DEFAULT 'retention' CHECK (stage IN ('retention', 'citations', 'opinions', 'objects', 'orphans')),
    citation_cursor text CHECK (length(citation_cursor) BETWEEN 1 AND 256),
    opinion_cursor bigint CHECK (opinion_cursor > 0),
    orphan_page_token text CHECK (octet_length(orphan_page_token) BETWEEN 1 AND 8192),
    orphan_after_key text CHECK (length(orphan_after_key) BETWEEN 1 AND 1024),
    orphan_after_generation text CHECK (orphan_after_generation ~ '^[0-9]{1,32}$'),
    CHECK ((orphan_after_key IS NULL) = (orphan_after_generation IS NULL)),
    CHECK (name <> 'cleanup' OR stage = 'retention'),
    CHECK (stage = 'citations' OR citation_cursor IS NULL),
    CHECK (stage = 'opinions' OR opinion_cursor IS NULL),
    CHECK (stage = 'orphans' OR orphan_page_token IS NULL),
    CHECK (stage = 'orphans' OR orphan_after_key IS NULL),
    CHECK (scheduled_for IS NOT NULL OR (stage = 'retention' AND citation_cursor IS NULL AND opinion_cursor IS NULL AND orphan_page_token IS NULL AND orphan_after_key IS NULL)),
    CHECK ((completed_for IS NULL) = (completed_at IS NULL))
);
INSERT INTO lexcerta.maintenance_progress(name) VALUES ('cleanup'), ('lifecycle');

-- Maintenance scans retain source history and do not repeatedly scan positives.
CREATE INDEX citation_negative_sweep ON lexcerta.citation_sources(citation) WHERE state->>'kind' = 'negative';
CREATE INDEX opinion_negative_sweep ON lexcerta.opinion_sources(opinion_id) WHERE state->>'kind' = 'negative';
