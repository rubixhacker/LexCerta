# Isolate staging from production

LexCerta staging will run at `https://mcp-staging.lexcerta.ai/`, with its operator service at `admin-staging.lexcerta.ai`. Staging and production use separate D1 databases, R2 buckets, Durable Object namespaces, CourtListener credentials and budgets, HMAC peppers, and API keys. No production Customer, credential, cache, or quota state is reachable from staging; staging keys use the `lc_test_` prefix.
