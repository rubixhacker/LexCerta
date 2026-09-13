-- Recovery runs only against an isolated restore. Sealing is one way through
-- the packaged replay path; completing an inventory does not reopen traffic.
CREATE TABLE lexcerta.recovery_control (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    sealed_at timestamptz,
    environment text CHECK (environment IN ('staging', 'production')),
    CHECK ((sealed_at IS NULL) = (environment IS NULL))
);
INSERT INTO lexcerta.recovery_control(singleton) VALUES (true);

CREATE TABLE lexcerta.recovery_runs (
    inventory_sha256 text PRIMARY KEY CHECK (inventory_sha256 ~ '^[0-9a-f]{64}$'),
    environment text NOT NULL CHECK (environment IN ('staging', 'production')),
    record_count integer NOT NULL CHECK (record_count BETWEEN 0 AND 10000),
    next_index integer NOT NULL DEFAULT 0 CHECK (next_index BETWEEN 0 AND record_count),
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    CHECK (completed_at IS NULL OR next_index = record_count)
);
CREATE TABLE lexcerta.recovery_receipts (
    object_key text PRIMARY KEY CHECK (
        object_key ~ '^restrictions/v1/(staging|production)/[0-9a-f]{64}\.json$'
    ),
    generation text NOT NULL CHECK (generation ~ '^[1-9][0-9]{0,31}$'),
    object_created_at text NOT NULL CHECK (length(object_created_at) BETWEEN 20 AND 40),
    record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object' AND octet_length(record::text) <= 1024),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- No credential or customer material, and deliberately no FK to api_keys:
-- a key created after the restore point may be absent from the restored SQL.
CREATE TABLE lexcerta.recovered_key_restrictions (
    public_id text NOT NULL CHECK (public_id ~ '^[A-Za-z0-9-]{1,64}$'),
    environment text NOT NULL CHECK (environment IN ('production', 'test')),
    revoked boolean NOT NULL DEFAULT false,
    not_after timestamptz,
    PRIMARY KEY (public_id, environment),
    CHECK (revoked OR not_after IS NOT NULL)
);

ALTER TABLE lexcerta.admin_audit_events DROP CONSTRAINT admin_audit_events_action_check;
ALTER TABLE lexcerta.admin_audit_events ADD CONSTRAINT admin_audit_events_action_check CHECK (
    action IN ('key_issued', 'key_rotated', 'key_revoked', 'key_limits_changed',
        'source_removed', 'key_recovery_restricted')
);

-- Runtime roles cannot read/change the restriction table. A fixed-path definer
-- trigger nevertheless enforces its restrictions on operator writes and keeps
-- retired absent IDs from being reissued with different credential material.
CREATE FUNCTION lexcerta.enforce_recovered_key_restriction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    restriction lexcerta.recovered_key_restrictions%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' AND
        (OLD.public_id IS DISTINCT FROM NEW.public_id OR OLD.environment IS DISTINCT FROM NEW.environment)
        AND EXISTS (SELECT 1 FROM lexcerta.recovered_key_restrictions r
            WHERE r.public_id = OLD.public_id AND r.environment = OLD.environment) THEN
        RAISE EXCEPTION 'key identity is immutable' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO restriction FROM lexcerta.recovered_key_restrictions r
        WHERE r.public_id = NEW.public_id AND r.environment = NEW.environment;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'key identity restricted by recovery' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'active' AND (restriction.revoked OR OLD.status = 'revoked'
        OR (restriction.not_after IS NOT NULL AND NEW.expires_at > restriction.not_after)) THEN
        RAISE EXCEPTION 'key restricted by recovery' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION lexcerta.enforce_recovered_key_restriction() FROM PUBLIC;
CREATE TRIGGER enforce_recovered_key_restriction BEFORE INSERT OR UPDATE ON lexcerta.api_keys
    FOR EACH ROW EXECUTE FUNCTION lexcerta.enforce_recovered_key_restriction();
