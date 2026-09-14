# Use discriminated tool results

The `verify_citation` and `verify_quote` tools will return an `outcome`-discriminated union with exactly one of `verified`, `not_found`, or `indeterminate`; `parse_citation` will return `parsed` or `unrecognized`. Each tool will publish a JSON Schema 2020-12 `outputSchema`, return conforming `structuredContent`, and include a concise text rendering. MCP's SDK-managed wire-level `resultType` is not reused for LexCerta's business outcome. Normal domain outcomes use `isError: false`; an `indeterminate` execution failure uses `isError: true`; malformed MCP requests remain JSON-RPC protocol errors, and authentication failures are rejected at HTTP before dispatch.

Public inputs are bounded at the schema boundary: citations accept 1–256 characters and quotes accept 20–10,000 characters. Oversized upstream opinion sets produce `indeterminate` rather than risking Worker termination. The quote and source-processing ceilings remain configurable and must pass the worst-case Cloudflare Worker benchmark before deployment.

Launch citation support is limited to a documented set of case-law reporters in `volume reporter page` form. `parse_citation` preserves trailing pin cites and parentheticals as an uninterpreted suffix, rejects unsupported citation families as `unrecognized`, and does not claim general Bluebook parsing.
