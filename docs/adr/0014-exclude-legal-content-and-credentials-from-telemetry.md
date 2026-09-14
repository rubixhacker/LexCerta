# Exclude legal content and credentials from telemetry

Production logs and traces will not retain Customer-submitted citations, quotation text, opinion text, plaintext API keys, or Authorization headers. Operational telemetry is limited to a non-reversible key identifier, tool and outcome, latency and response size, cache and freshness status, upstream quota status, sanitized error category, and trace or request identifier. Temporary payload logging requires an explicit time-bounded operator action and Customer consent.

For submitted draft content and extracted Customer text, [ADR 0041](0041-process-full-drafts-transiently-for-coverage.md) supersedes the temporary payload-logging exception with a no-retention requirement.
