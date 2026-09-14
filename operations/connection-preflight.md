# Connection preflight

This is a machine preflight for the connection frontier in the confirmed [product scope](../docs/product-scope.md). It neither implements OAuth login nor qualifies Claude or ChatGPT. A successful parsing call does not establish that a citation exists.

## Run

Use the repository-pinned Node 24.21.0 and the repository's installed dependencies. Set `LEXCERTA_PREFLIGHT_ENDPOINT` to the exact MCP URL and `LEXCERTA_PREFLIGHT_TOKEN` through your environment or secret manager, then run:

```sh
node scripts/connection-preflight.mjs
```

The endpoint must use HTTPS (HTTP is allowed only for literal loopback IPs), with no URL credentials, query, or fragment. There are no command-line arguments. The token is sent only to the selected endpoint. Each request has a five-second deadline, including body consumption, and a 64 KiB response bound. No requests are retried and no redirects are followed. An operator may redirect stdout to retain the allowlisted JSON report; the CLI never writes files.

The preflight makes two or three requests: unauthenticated `tools/list`, optional unauthenticated retrieval of advertised same-origin protected-resource metadata, and authenticated `parse_citation` using fixed synthetic input. It calls no citation/quote verification tools and needs no CourtListener credentials. Normal endpoint admission may count these requests against the test key's API-key limit.

Exit codes:

- `0`: all three implemented checks passed. OAuth authorization and both hosts remain untested.
- `1`: at least one check failed or remains untested. Inspect the individual statuses.
- `2`: invalid invocation. Diagnostics do not echo environment values.

Only schema version, timestamp, pinned protocol, fixed statuses, and HTTP status codes are emitted. Endpoint URLs, challenges, issuer URLs, tokens, response text, and parsed Customer data are excluded. Use synthetic data and a qualification key; this tool has no draft input.

A cross-origin metadata URL is reported as `cross_origin_not_tested` and is not fetched. This is a probe limitation, not a finding that cross-origin discovery is invalid. Discovery without an explicit `resource_metadata` challenge is `not_advertised`; fallback well-known probing and authorization-server metadata, PKCE, consent, tokens, refresh, eligibility, and host tool selection are outside this check. The parsing response must match request id 2 and the expected structured contract; HTTP 200 alone is insufficient.

## Reproducing local evidence

```sh
npm run build:node
node --test --test-timeout=20000 scripts/worker-qualification-connection-preflight.test.mjs
```

The tests use real loopback HTTP. One launches the real `src/mcp.ts` handler with fixture-only bearer admission and gateways that throw on source access, then invokes the CLI as a separate process. This establishes CLI-to-handler behavior; it does not exercise the full Worker/Node admission and storage path. `scripts/connection-preflight-runtime-fixture.mjs` is a local test fixture only, not a deployable service. The existing `test:worker-qualification` command builds the Node handler and includes this test file.

For interactive inspection, start the fixture in one terminal:

```sh
npm run build:node
node scripts/connection-preflight-runtime-fixture.mjs
```

Use its printed loopback URL as the endpoint and the public synthetic value `fixture-preflight-token` as the token in another terminal. Stop the fixture afterward. Its expected CLI exit is 1: unauthenticated access is rejected and parsing passes, but OAuth metadata is not advertised.

## Contract findings checked September 14, 2026

[OpenAI authentication](https://developers.openai.com/plugins/build/auth) documents a 401 bearer challenge pointing to protected-resource metadata. [Claude authentication](https://claude.com/docs/connectors/building/authentication) documents the same discovery mechanism and exact resource URL matching. Claude also documents organization-admin static request headers in beta; this does not establish an individual lawyer's accepted cross-host account journey.

Both the local Worker baseline and Node checkpoint `65d5259` retain stateless MCP `2026-07-28` and bearer admission. This slice changes neither ADR 0001 nor ADR 0006. OAuth reconciliation and actual host protocol evidence remain implementation work. The complete supplied-draft and drafting workflows, three intake formats, transient PDF delivery, reference-test expectations, measured limits, pilot participation and public listings remain outstanding gates, as mapped in the [implementation plan](../docs/superpowers/plans/2026-09-14-connection-preflight.md).

The probe deliberately accepts the parser's current plain text content blocks only (plus its structured result), rather than implementing all MCP media types. Its challenge recognizer accepts a single Bearer challenge with `resource_metadata` first and optional quoted `scope`, `error`, or `error_description` parameters afterward. Other challenge encodings are unrecognized by this probe; `not_advertised` means no supported challenge was recognized, not that every standards-compliant discovery path is absent.
