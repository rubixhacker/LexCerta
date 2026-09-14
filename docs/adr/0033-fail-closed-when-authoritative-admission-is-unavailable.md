# Fail closed when authoritative admission is unavailable

If D1 cannot authoritatively validate a LexCerta API key or its per-key Durable Object cannot complete admission, LexCerta will fail closed with HTTP `503 Service Unavailable` and `Retry-After`. It will not return `401`, execute discovery or tools, bypass admission for cache hits, or otherwise grant unmetered access. The unauthenticated health endpoint remains dependency-free; authenticated deployment smoke tests detect this degraded state.
