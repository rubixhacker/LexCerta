UPDATE api_key_records
SET retention_expires_at = CASE
	WHEN strftime('%m-%d', COALESCE(revoked_at, expires_at)) = '02-29' THEN printf(
		'%04d-03-01T%sZ',
		CAST(strftime('%Y', COALESCE(revoked_at, expires_at)) AS INTEGER) + 1,
		strftime('%H:%M:%f', COALESCE(revoked_at, expires_at))
	)
	ELSE printf(
		'%04d-%s-%sT%sZ',
		CAST(strftime('%Y', COALESCE(revoked_at, expires_at)) AS INTEGER) + 1,
		strftime('%m', COALESCE(revoked_at, expires_at)),
		strftime('%d', COALESCE(revoked_at, expires_at)),
		strftime('%H:%M:%f', COALESCE(revoked_at, expires_at))
	)
END
;
