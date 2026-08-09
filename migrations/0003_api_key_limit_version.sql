ALTER TABLE api_key_records
	ADD COLUMN limits_version INTEGER NOT NULL DEFAULT 0 CHECK (limits_version >= 0);
