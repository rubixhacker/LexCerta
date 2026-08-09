# Operational telemetry

Workers Logs retain events for seven days on the paid Workers plan. Invocation logs remain disabled because they can capture request authorization material. Structured `mcp.request.completed` events and persisted traces are enabled; their only correlation values are service-generated request and trace IDs.

Analytics Engine has separate production, test, and local datasets. The production dataset is `lexcerta_mcp_production`; tests use `lexcerta_mcp_test`; local development uses `lexcerta_mcp_local`. It receives only fixed dimensions and measurements:

| Analytics column | Meaning |
| --- | --- |
| `blob1` through `blob7` | `tool`, `outcome`, `cache_status`, `freshness`, `circuit_status`, `upstream_status`, `error_category` |
| `double1` through `double3` | `latency_ms`, `response_bytes`, event count |

No dataset receives a Customer or key identifier, request or trace correlation value, citation, quotation, opinion text, request body, header, or error value. Metrics are operational aggregates and never evidence authority.

## Saved operational views

Run these against `lexcerta_mcp_production` over the selected incident window; replace it with the test/local dataset only for non-production verification.

| View | Filter and grouping | Operator decision |
| --- | --- | --- |
| Authentication denial | `blob2 IN ('unauthorized', 'authentication_unavailable')`, grouped by `blob2` | Separate invalid credentials from key-auth infrastructure failure. |
| Key admission | `blob2 IN ('admission_exhausted', 'admission_unavailable')`, grouped by `blob2` | Identify allowance exhaustion versus limiter availability. |
| CourtListener budget and health | `blob6 IN ('rate_limited', 'quota_limited', 'quota_unknown', 'unavailable', 'timeout', 'server_error', 'malformed_response')`, grouped by `blob6`, with p50/p95 `double1` | Protect the service-wide CourtListener budget and decide whether to retry or investigate upstream. |
| Circuit state | `blob5 IN ('open', 'half_open')`, grouped by `blob5` | Confirm circuit protection is active before changing upstream traffic. |
| Cache freshness | grouped by `blob3, blob4`; alert on `blob3 = 'source_changed'` | Observe source-cache freshness without asserting a cache hit from public provenance alone. |
| Source contradiction | `blob3 = 'source_changed'`, grouped by `blob1, blob2` | Investigate a revalidation conflict before treating the evidence as conclusive. |
| Tool outcomes and latency | grouped by `blob1, blob2`, with p50/p95/p99 `double1` and `SUM(double3)` | Detect regression by tool and outcome without Customer linkage. |
| Response size | grouped by `blob1, blob2`, with p95 `double2` | Detect protocol or response-shape expansion. |

Equivalent Analytics Engine SQL uses the fixed columns above, for example:

```sql
SELECT blob6 AS upstream_status,
       SUM(_sample_interval) AS events,
       quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_latency_ms
FROM lexcerta_mcp_production
WHERE blob6 IN ('rate_limited', 'quota_limited', 'quota_unknown', 'unavailable', 'timeout', 'server_error', 'malformed_response')
GROUP BY blob6
```

Use the native Cloudflare service views for runtime and storage signals that Analytics Engine does not collect:

- [Workers metrics and CPU/memory errors](https://dash.cloudflare.com/?to=/:account/workers/services/view/lexcerta-mcp/production/metrics)
- [D1 database storage](https://dash.cloudflare.com/?to=/:account/workers/d1)
- [R2 bucket storage](https://dash.cloudflare.com/?to=/:account/r2)
- [Durable Object storage and metrics](https://dash.cloudflare.com/?to=/:account/workers/durable-objects)

The daily `0 3 * * *` UTC Worker cron runs lifecycle retention. Limiter Durable Object buckets expire within 48 hours; sanitized key lifecycle, tombstone, and administrative records expire one year after expiry or revocation. The Worker never creates a per-request D1 telemetry ledger.
