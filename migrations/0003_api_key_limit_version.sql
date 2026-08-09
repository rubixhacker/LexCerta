ALTER TABLE api_key_records
	ADD COLUMN limits_version INTEGER NOT NULL DEFAULT 0 CHECK (limits_version >= 0);

CREATE TRIGGER api_key_records_limit_maximum_insert
BEFORE INSERT ON api_key_records
FOR EACH ROW
WHEN NEW.minute_limit > 600 OR NEW.day_limit > 10000
BEGIN
	SELECT RAISE(ABORT, 'api key limit exceeds maximum');
END;

CREATE TRIGGER api_key_records_limit_maximum_update
BEFORE UPDATE OF minute_limit, day_limit ON api_key_records
FOR EACH ROW
WHEN NEW.minute_limit > 600 OR NEW.day_limit > 10000
BEGIN
	SELECT RAISE(ABORT, 'api key limit exceeds maximum');
END;
