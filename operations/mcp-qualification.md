# Stateless MCP qualification

Recorded September 12, 2026 for [Correct the stateless MCP boundary and ship the pinned SDK example](https://github.com/rubixhacker/LexCerta/issues/32). Protocol `2026-07-28`, server/client `2.0.0`, and Node `24.21.0` were checked against their official sources before this run. The [current specification](https://modelcontextprotocol.io/specification) redirected to the dated July revision; both npm `latest` metadata reads returned `2.0.0`.

## Product boundary and supported client

The mounted product tests enforce all three mirrored headers, required request metadata, modern-only dispatch, sessions excluded, valid unsupported subscriptions and unknown methods returning 404/-32601, supplied Origin returning 403 without admission/source work, and quota errors using application code 1001 with bounded string/integer ID correlation. Direct `tools/list` and `tools/call` requests succeed on fresh handler instances with no previous discovery. Buffering preserves request cancellation.

SDK 2.0.0 accepts a missing protocol-version header, so LexCerta fills that measured gap using the SDK's public request classifier before returning 400/-32020. Invalid JSON/envelopes and other SDK validation remain delegated. JSON response mode alone does not disable the SDK's subscription router, so the product explicitly returns method-not-found for that excluded surface.

The [TypeScript example](../examples/README.md) pins modern negotiation. The SDK sends a discovery probe even in pinned mode; it never falls back to initialize. The example consumes that discovery result, then sends one tools/list and three tools/call requests. Tests assert the actual wire metadata, method/name headers, resultType and server identity, as well as negative, unavailable, revoked/expired and exhausted fixtures. Source fixtures are synthetic and consume no CourtListener account quota.

The full required check passed 568 tests with zero npm audit findings. The retained [product wire record](qualification/mcp-2026-09-12/product-wire.json) contains five successful Node HTTP requests.

`npm run check` includes a Node 24 HTTP journey to the actual emitted Worker bundle through a loopback-only fixture bridge, in addition to workerd integration tests. To retain its redacted wire record:

```sh
node scripts/worker-bundle-conformance.mjs .omo/evidence/mcp-product-<unique-run>
```

The directory must be empty. `pilot-client-wire.json` records actual request/response protocol fields, replacing tool arguments/content and retaining only outcome/version from structured results. It omits credentials. This demonstrates a local Node SDK and emitted Worker adapter; it does not qualify Cloud Run or any external GUI client. The deployment ticket must rerun the example against the exact deployed revision. Host validation on the real Node public adapter remains part of that runtime ticket; the local bridge accepts only its loopback authority.

## Official SDK diagnostic fixture

The frozen July suite ran against the official SDK's separate everything-server fixture, **not** LexCerta. No diagnostic tool was added to the product.

- Conformance source: [`7169291ec0b68eb370fddcd9947313ab0d5e4156`](https://github.com/modelcontextprotocol/conformance/tree/7169291ec0b68eb370fddcd9947313ab0d5e4156).
- SDK fixture source: [`cc4b41617ce3601b1290d67216ea0b194a3cd9ac`](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/test/conformance/src/everythingServer.ts), the server 2.0.0 tag. The sole source adjustment bound its listener to `127.0.0.1`.
- [Frozen requirements](qualification/mcp-2026-09-12/requirements.yaml), [source hashes and command](qualification/mcp-2026-09-12/provenance.json), [exact fixture dependency manifest](qualification/mcp-2026-09-12/fixture-package.json), [lockfile](qualification/mcp-2026-09-12/fixture-package-lock.json), and [all 50 scenario results](qualification/mcp-2026-09-12/diagnostic-results.json) are retained.

All **37 required scenarios passed**, comprising 120 successful assertions and one informational result. The 13 unscored scenarios had 44 successful assertions, 30 failed assertions and one skip. Nine task-extension scenarios failed. JSON Schema and both HTTP-header scenarios passed but remain marked pending/not scored in the frozen manifest. The required-suite process exited 0; that does not erase the recorded optional failures.

The conformance Git source archive, unmodified SDK fixture and console log were also retained in the task workspace's `launch/qualification/` directory. Their source hashes are in the provenance record. No credentials or real submitted documents were used.

To reproduce, check out the conformance commit above and run `npm ci`. In a separate directory, save the archived fixture manifest/lockfile as `package.json`/`package-lock.json`, run `npm ci`, download the pinned fixture source, verify its SHA-256, and bind only its listener to loopback. Start it with Node 24.21.0 and `PORT=30317`. From the conformance checkout run:

```sh
npm start -- server --url http://127.0.0.1:30317/mcp \
  --requirements 2026-07-28 --output-dir <empty-evidence-directory>
```

Stop the fixture after the run. The older `@modelcontextprotocol/conformance@latest` npm label is not a substitute for this pinned source/requirements combination.

## Evidence still required

These checks establish protocol and local integration behavior. They do not establish real-opinion coverage, CourtListener permission for hosted multi-user access, deployment isolation and rollback, or an external integrator's repeated use. Those remain distinct gates in the [MVP route](../docs/mvp-route.md).
