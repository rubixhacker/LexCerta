# Coordinate endpoint-specific CourtListener circuits

The CourtListener budget Durable Object will maintain separate failure circuits for citation lookup and case-law fetching. A circuit opens after three consecutive timeouts or `5xx` responses for 30 seconds, permits one half-open probe, doubles the open period after each failed probe up to five minutes, and closes immediately after success. A `429` honors `Retry-After` as quota state rather than counting as a circuit failure. Usable cached evidence remains available while an upstream circuit is open.
