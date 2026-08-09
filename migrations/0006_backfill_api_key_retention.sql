UPDATE api_key_records
SET retention_expires_at = strftime(
	'%Y-%m-%dT%H:%M:%fZ',
	COALESCE(revoked_at, expires_at),
	'+365 days'
)
WHERE retention_expires_at IS NULL;
