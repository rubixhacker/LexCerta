# Use Cloudflare-native observability at launch

LexCerta will use sanitized Workers Logs, Cloudflare tracing, and Workers Analytics Engine at launch, with no separate telemetry vendor. Analytics Engine is limited to non-authoritative aggregate usage and health metrics because it may sample data. Trace context remains W3C-compatible so an OpenTelemetry destination can be added later without changing application semantics.
