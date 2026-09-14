# Coordinate each API key limit with a Durable Object

Each LexCerta API key will have one SQLite-backed Durable Object that authoritatively admits requests and records usage against the key's configurable limits stored in D1. This per-key coordination boundary scales independently and hibernates when idle. Cloudflare's permissive location-local Rate Limiting binding may later provide an outer burst shield but cannot define Customer entitlement or authoritative accounting.

An exhausted API-key limit is rejected before MCP dispatch with HTTP `429 Too Many Requests`, a `Retry-After` header, and a JSON-RPC error body when the request ID is available. This admission limit covers the whole service, while CourtListener-budget exhaustion remains an `indeterminate` result inside verification tools.

Operator-issued pilot keys default to 60 requests per rolling minute and 1,000 requests per rolling day. Both limits are stored with the key record in D1 and may be overridden per key without changing the MCP contract or redeploying the Worker.
