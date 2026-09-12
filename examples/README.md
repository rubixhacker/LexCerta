# Supported pilot client

This is the supported developer integration for LexCerta's custom bearer-key pilot. It uses `@modelcontextprotocol/client` **2.0.0** from the root lockfile and pins **2026-07-28** without a legacy fallback. It has been exercised locally over HTTP against the emitted product bundle; a deployed Cloud Run revision still needs qualification. No named GUI client or OAuth onboarding is certified by this example.

From a clean checkout, use the Node version in `.nvmrc`:

```sh
nvm use
npm ci
export LEXCERTA_URL='https://<issued-pilot-host>/'
export LEXCERTA_API_KEY='<operator-issued-key>'
export LEXCERTA_CITATION='347 U.S. 483'
export LEXCERTA_QUOTE='<exact passage to check>'
npm run client
```

Supply the key through your environment or secret manager. The endpoint must be HTTPS, or loopback HTTP for local qualification. Credentials in URLs, query parameters and fragments are rejected. Redirects are not followed. Quotes must be 20–10,000 Unicode code points.

The client first discovers the server during `connect()`, then lists tools, parses the citation, verifies the citation, and verifies the quotation: five authenticated requests. It reuses the discovery result rather than spending an extra request. Discovery is an optional capability query at the server; separate product tests send tools directly as their first request.

For use from another Node application, import `connectPilot` and `runPilot` from `pilot-client.ts` and always close the returned client in a `finally` block. The same SDK APIs work in compiled TypeScript; the pinned Node version can execute this example's erasable TypeScript directly.

Interpret `structuredContent.outcome`, not HTTP success alone:

- `parsed`: a recognized citation shape, without an existence check.
- `verified`: citation existence or exact normalized text presence in the identified CourtListener source.
- `not_found`: a completed source-scoped search found no match.
- `indeterminate`: the search could not establish a result; retry guidance is in the structured result. This is never a negative evidence finding.

Transport failures remain failures. Revoked or expired keys return 401. Allowance exhaustion returns HTTP 429, `Retry-After`, `Cache-Control: no-store`, and JSON-RPC application code `1001` with a bounded string/integer request ID when readable. The SDK surfaces a non-success HTTP response as `SdkHttpError` with `data.status`; inspect the raw wire separately for the application code. The example does not retry automatically or print transport exception text.

Server clients omit `Origin`. All supplied Origins are rejected for this pilot, including the service's own Origin; browser embedding is not enabled. Sessions, legacy initialization and subscription streams are excluded.

Local regressions include positive and negative citation/quote evidence, unavailable source evidence, expired and revoked credentials, quota exhaustion, and a legacy-only fixture that must fail explicitly. See [protocol qualification](../operations/mcp-qualification.md) for the separate diagnostic-suite and product evidence.
