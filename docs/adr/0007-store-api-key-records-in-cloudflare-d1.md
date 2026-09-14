# Store API key records in Cloudflare D1

Cloudflare D1 will be the authoritative store for Customer and LexCerta API key records. Each key record stores a keyed hash and lifecycle metadata, while the plaintext credential is displayed only once at issuance. Worker secrets remain reserved for LexCerta's own service credentials; Workers KV is rejected because its eventual consistency would delay reliable revocation, and Supabase is excluded because it would duplicate the authoritative database and add another operational and billing surface.

Keys use `lc_live_<public-key-id>_<32-byte-random-secret>` in production and `lc_test_<public-key-id>_<32-byte-random-secret>` outside production. D1 stores the public identifier and an HMAC-SHA-256 of the complete token; the HMAC pepper is a Cloudflare Worker secret, verification is timing-safe, and the plaintext token is shown only once.

Every pre-shared key expires after 90 days by default and may be revoked immediately. Rotation creates a new key and allows at most seven days of overlap before the prior key expires. Expired, revoked, and otherwise invalid credentials receive the same generic HTTP `401` response. Records retain issuance, expiry, revocation, and last-used timestamps.
