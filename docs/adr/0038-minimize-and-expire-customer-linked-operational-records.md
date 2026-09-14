# Minimize and expire Customer-linked operational records

LexCerta will keep no per-request D1 ledger, expire Durable Object usage buckets within 48 hours, and rely on Cloudflare's seven-day Workers Logs retention. Sanitized key lifecycle records, tombstones, and administrative audit events will be retained for one year after expiration or revocation and then deleted automatically. Longer-lived aggregate metrics must exclude API-key and Customer identifiers; public CourtListener source-cache data remains governed by its separate retention policy.
