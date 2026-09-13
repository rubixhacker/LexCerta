-- Expand the shared audit record to include a source target. Existing key
-- events keep their customer and key semantics, including retained null keys.
ALTER TABLE lexcerta.admin_audit_events ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE lexcerta.admin_audit_events ADD COLUMN opinion_id bigint CHECK (opinion_id > 0);
ALTER TABLE lexcerta.admin_audit_events DROP CONSTRAINT admin_audit_events_action_check;
ALTER TABLE lexcerta.admin_audit_events ADD CONSTRAINT admin_audit_events_action_check
    CHECK (action IN ('key_issued', 'key_rotated', 'key_revoked', 'key_limits_changed', 'source_removed'));
ALTER TABLE lexcerta.admin_audit_events ADD CONSTRAINT admin_audit_events_target_check CHECK (
    (action = 'source_removed' AND opinion_id IS NOT NULL AND customer_id IS NULL AND public_id IS NULL)
    OR (action <> 'source_removed' AND opinion_id IS NULL AND customer_id IS NOT NULL)
);

-- The operator can execute this one-way transition without gaining direct
-- cache writes. Fully qualified objects and a fixed search path exclude caller
-- objects. All changes, including the audit, share the caller's transaction.
CREATE FUNCTION lexcerta.remove_opinion(target_id bigint, actor text, key_environment text)
RETURNS TABLE(removed_at timestamptz, pending_deletions integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    recorded_at timestamptz;
BEGIN
    IF target_id IS NULL OR target_id < 1 OR target_id > 9007199254740991
        OR actor IS NULL OR length(actor) NOT BETWEEN 1 AND 256
        OR key_environment IS NULL OR key_environment NOT IN ('production', 'test') THEN
        RAISE EXCEPTION 'invalid source removal' USING ERRCODE = '22023';
    END IF;

    -- Same lock order as publication and collection: capacity, then opinion.
    PERFORM 1 FROM lexcerta.cache_capacity WHERE singleton FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'source authority unavailable';
    END IF;
    INSERT INTO lexcerta.opinion_sources(opinion_id) VALUES (target_id) ON CONFLICT DO NOTHING;
    SELECT s.removed_at INTO recorded_at FROM lexcerta.opinion_sources s
        WHERE s.opinion_id = target_id FOR UPDATE;
    IF recorded_at IS NULL THEN
        recorded_at := clock_timestamp();
        UPDATE lexcerta.opinion_sources SET removed_at = recorded_at, body_key = NULL,
            epoch = epoch + 1, owner_token = NULL, lease_expires_at = NULL, updated_at = recorded_at
            WHERE opinion_id = target_id;
        INSERT INTO lexcerta.admin_audit_events
            (id, action, actor_subject, environment, opinion_id, occurred_at, retention_expires_at)
            VALUES (gen_random_uuid(), 'source_removed', actor, key_environment, target_id,
                recorded_at, recorded_at + interval '1 year');
    END IF;
    -- Repeating removal must not reset a collector's in-flight delete fence.
    UPDATE lexcerta.source_objects SET phase = 'deleting', delete_after = clock_timestamp(),
        delete_token = NULL WHERE opinion_id = target_id AND phase <> 'deleting';
    RETURN QUERY SELECT recorded_at, count(*)::integer FROM lexcerta.source_objects
        WHERE opinion_id = target_id;
END;
$function$;
REVOKE ALL ON FUNCTION lexcerta.remove_opinion(bigint, text, text) FROM PUBLIC;
