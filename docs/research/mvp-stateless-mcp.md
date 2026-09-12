# LexCerta MVP: stateless MCP and the first supported client

Research date: 2026-09-12. Decision: [Verify the latest stateless MCP and a supported client path](https://github.com/rubixhacker/LexCerta/issues/25). Source baseline: `7f5f3eaa6154a1834def2ebcd8af3c44d52bb38d`. This is planning evidence; no production code was changed and no endpoint, external GUI client, or conformance suite was exercised in this research.

## Recommendation

Ship a developer pilot that speaks **MCP 2026-07-28 exclusively**, using `@modelcontextprotocol/server@2.0.0` and a small supported Node/TypeScript integration using `@modelcontextprotocol/client@2.0.0`. Keep protocol sessions and initialization out of the product. Publish one runnable integration and its captured, redacted wire evidence before advertising compatibility. Defer OAuth onboarding and named GUI clients until a customer needs one and its actual released client has passed the same acceptance path.

Use manually issued, expiring, revocable LexCerta bearer API keys for this limited developer pilot. Describe that as a **custom API-key authentication profile**, with its own tested contract; do not call it complete MCP OAuth interoperability. Custom authentication is allowed by the base specification, while HTTP implementations are encouraged to follow MCP authorization. [Base protocol: Auth](https://modelcontextprotocol.io/specification/2026-07-28/basic#auth)

## What is current, and what has been verified

| Item | Verified finding | Consequence |
| --- | --- | --- |
| Protocol | The official `/specification` endpoint redirects to the dated `2026-07-28` specification. Its base design is stateless requests with per-request capability metadata. | Retain the existing dated protocol pin. [Official specification](https://modelcontextprotocol.io/specification/2026-07-28) |
| TypeScript packages | Public npm registry metadata reports `latest: 2.0.0` for both server and client, published 2026-07-27. The official client README calls v2 the stable release line. | Pin both exact package versions and refresh at release qualification. [Server metadata](https://registry.npmjs.org/@modelcontextprotocol%2fserver), [client metadata](https://registry.npmjs.org/@modelcontextprotocol%2fclient), [official client README](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/README.md) |
| Important final-wire detail | The stable SDK release moved server identity into result `_meta` and made request `clientInfo` optional, matching the final specification. | Do not reconstruct an earlier v2-alpha wire shape. [Official release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fserver%402.0.0) |
| Conformance package | npm `latest` remains `0.1.16`, published 2026-03-30; `alpha` is `0.2.0-alpha.11`. | A bare `npx ...@latest` is not sufficient evidence for the July protocol. [Registry metadata](https://registry.npmjs.org/@modelcontextprotocol%2fconformance) |
| Conformance source | Official `main` was `7169291ec0b68eb370fddcd9947313ab0d5e4156`, dated 2026-09-11. It has the dated requirements selector and manifest. | Pin this source revision for the initial qualification harness. [Pinned source](https://github.com/modelcontextprotocol/conformance/tree/7169291ec0b68eb370fddcd9947313ab0d5e4156) |

The npm registry was read directly during research. Source examples and specification documents were inspected, not executed. No released Claude, ChatGPT, Codex, Cursor, or other GUI client is certified by these findings.

## Required wire contract

Requests must carry a valid JSON-RPC ID, `params._meta['io.modelcontextprotocol/protocolVersion']`, and `params._meta['io.modelcontextprotocol/clientCapabilities']`. Empty capabilities are valid for this product. Client identity is recommended, not mandatory. Requests cannot depend on earlier requests. Successful wire results include `resultType`; server identity belongs in result `_meta`. Missing required body metadata produces `-32602` and HTTP 400. [Base protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic)

Serve one POST endpoint. Clients send `Accept: application/json, text/event-stream`, matching `MCP-Protocol-Version` and `Mcp-Method` headers, plus `Mcp-Name` for tool calls. Validate mirrored headers; missing or mismatched required headers produce HTTP 400 and `-32020`. Unsupported versions produce HTTP 400 and `-32022` with supported versions; unknown methods produce HTTP 404 and `-32601`. Validate any presented Origin; an invalid Origin produces HTTP 403. No GET event stream or protocol session is needed. These rules apply to the mounted application as well as the SDK transport. [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

The server must implement `server/discover`; clients may skip it and call a tool directly. Discovery reports supported versions and capabilities. It is a capability query, not an initialization handshake. Test direct `tools/list` and `tools/call` as the first authenticated request on a fresh instance. [Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)

Keep the current three evidence tools and `capabilities: { tools: {} }`. Do not advertise change notifications, sampling, roots, elicitation, tasks, or other extensions the product does not use. Statelessness does allow request-scoped streaming; it does not itself mean that every SSE response is stateful. JSON terminal responses remain a reasonable choice for these tools. The official handler's JSON mode does not itself disable subscriptions, and the handler validates neither tokens nor Host/Origin. [SDK HTTP hosting](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)

## Source-confirmed gaps to fix before qualification

These are direct source/spec comparisons, not measured live failures.

1. **The quota error uses a reserved MCP code.** `createAdmissionExhaustedResponse` currently constructs `{ jsonrpc: '2.0', id, error: { code: -32029, message: 'API key allowance exhausted' } }` when it recovers an ID, then returns HTTP 429 with `Retry-After` and `Cache-Control: no-store`. The current specification reserves `-32020` through `-32099` for defined MCP errors and prohibits emitting undefined codes from that range. `-32029` is undefined. Replace it with a documented application code outside the JSON-RPC reserved range, such as positive `1001`, retaining the transport status and bounded ID handling. [Exact source](https://github.com/rubixhacker/LexCerta/blob/7f5f3eaa6154a1834def2ebcd8af3c44d52bb38d/src/worker-request.ts#L172), [normative Error Codes section](https://modelcontextprotocol.io/specification/2026-07-28/basic#error-codes)

   Bounded acceptance: use an authenticated request with a valid string ID, fully valid modern headers/body, and an exhausted fixture limiter. Through the public handler assert 429, positive integer `Retry-After`, `no-store`, the same ID, the documented application code, no upstream call, and no credential or submitted quote in the response. Repeat with a valid integer ID. Keep malformed/oversized ID recovery bounded and make no claim that null or fractional request IDs are valid modern MCP requests. Update the existing admission-boundary tests that currently expect `-32029`; test behavior, not source substrings. [Existing regression location](https://github.com/rubixhacker/LexCerta/blob/7f5f3eaa6154a1834def2ebcd8af3c44d52bb38d/test/worker-admission-boundary.integration.test.ts#L177)

2. **Missing protocol-header rejection loses the required error body.** `protocolBoundaryRejection` returns an empty 400 before the SDK receives the request. Make a well-formed authenticated request missing only `MCP-Protocol-Version` return 400 with `-32020`, correlated to its readable ID. Exercise all three mirrored-header failures through the mounted endpoint. [Source](https://github.com/rubixhacker/LexCerta/blob/7f5f3eaa6154a1834def2ebcd8af3c44d52bb38d/src/mcp.ts#L46), [Server Validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation)

3. **Origin validation is missing from the application boundary.** The Worker entry proceeds through authentication, quota, request checks, and `createMcpHandler` without an Origin guard; repository searches found no public Origin check. The SDK explicitly delegates this to the host. Add a documented deny-by-default Origin policy before processing requests. For the server-side developer pilot, permit absent Origin and reject unapproved supplied Origins; separately configure known browser origins only when supported. Assert hostile Origin -> 403 without a source request, and absent Origin -> normal API behavior. Include localhost Host checks in the Node adapter. [Worker boundary](https://github.com/rubixhacker/LexCerta/blob/7f5f3eaa6154a1834def2ebcd8af3c44d52bb38d/src/worker-request.ts#L28), [SDK hosting responsibilities](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md#validate-host-and-origin-in-front-of-it)

4. **Unsupported subscriptions return an empty 400.** Keep subscription capabilities absent, but return the protocol's unknown-method response, 404/`-32601`, for a valid unsupported `subscriptions/listen` request. The upstream stateless checker specifically accepts method-not-found when discovery advertises no subscription-delivered capability. Its existing Worker test omits the notifications filter, so add a valid-body case instead of treating malformed traffic as proof. [Application check](https://github.com/rubixhacker/LexCerta/blob/7f5f3eaa6154a1834def2ebcd8af3c44d52bb38d/src/mcp.ts#L53), [upstream checker](https://github.com/modelcontextprotocol/conformance/blob/7169291ec0b68eb370fddcd9947313ab0d5e4156/src/scenarios/server/stateless.ts#L993)

The pinned SDK and `legacy: 'reject'` setting are already present. The work is to qualify and correct the surrounding application, not to rewrite MCP. [Current handler](https://github.com/rubixhacker/LexCerta/blob/7f5f3eaa6154a1834def2ebcd8af3c44d52bb38d/src/mcp.ts)

## A concrete supported pilot client

Use `Client` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/client`. Explicitly configure:

```ts
const client = new Client(
  { name: 'lexcerta-pilot', version: '0.1.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
```

The default v2 client still performs the legacy initialization handshake. `auto` can fall back; the pinned modern mode cannot. The SDK adds the modern request envelope after selecting that mode. Implement authentication with the issued bearer credential on every request, sourced from an environment variable; never print it. Have the example discover, list tools, parse one citation, verify it, and check one exact quotation. Close the client when finished. Use the published client APIs for results and capture wire frames separately: the SDK consumes wire-only `resultType`, so high-level return values cannot prove its presence. [Official migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md), [client connection APIs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md)

Acceptance requires a clean-machine runnable example, pinned lockfile, and a redacted transcript against the actual deployed pilot revision. Prove all three tools, a negative citation/quotation, a source-unavailable outcome, expiration/revocation, and quota exhaustion. Recreate the client and route successive requests to fresh server instances to establish independence. Capture no `initialize`, `notifications/initialized`, GET stream, `Mcp-Session-Id`, or legacy retry. A legacy-only server fixture must fail explicitly. Product errors must remain distinguishable from a negative legal evidence finding.

After that path works, a legal-AI developer can invoke it from their own application without relying on GUI release timing. Any later claim such as “works with Client X” requires the exact released client version, configuration, authentication flow, protocol transcript, and complete tool journey. Official SDK compatibility alone is insufficient.

## Exact conformance path and evidence limits

Use the official conformance repository at the source SHA above and its frozen `2026-07-28` requirements. The following are **planned commands**, run inside that isolated conformance checkout after installing its locked dependencies:

```sh
npm ci
npm start -- list --requirements 2026-07-28
npm start -- server --url http://127.0.0.1:3001/mcp --requirements 2026-07-28
```

Archive the suite SHA, requirements manifest hash, exact command, server/client versions, scenario results, and wire-schema results. Report skipped, not measured, pending, optional, and expected failures separately. An expected-failures baseline can make a command exit successfully while the requirement still fails. [Pinned conformance instructions](https://github.com/modelcontextprotocol/conformance/blob/7169291ec0b68eb370fddcd9947313ab0d5e4156/README.md#conformance-requirements)

There is a necessary harness distinction: the full suite expects diagnostic tools, resources, prompts, and MRTR behavior for SDK testing. Even `server-stateless` probes names such as `test_missing_capability` and `test_logging_tool`. LexCerta's three-tool production endpoint does not expose them. Use an isolated fixture server to assess those SDK-level capabilities, and use the same production mount/auth pipeline in product-specific boundary tests. Never add diagnostic tools or a bypass credential to the deployed product merely to make the suite pass. An upstream fixture pass does not qualify LexCerta's wrapper. [Scenario requirements](https://github.com/modelcontextprotocol/conformance/blob/7169291ec0b68eb370fddcd9947313ab0d5e4156/src/scenarios/server/stateless.ts)

The dated manifest marks HTTP header validation scenarios as pending/not scored. Therefore a perfect required-scenario score still does not prove the product's mirrored-header checks. Make the application boundary tests above mandatory independently. The existing bundle “conformance” script covers discovery and a maximum-length quotation with fixtures; preserve it as bundle integration evidence, but label it accordingly. [Frozen manifest](https://github.com/modelcontextprotocol/conformance/blob/7169291ec0b68eb370fddcd9947313ab0d5e4156/requirements/2026-07-28.yaml), [LexCerta bundle script](https://github.com/rubixhacker/LexCerta/blob/7f5f3eaa6154a1834def2ebcd8af3c44d52bb38d/scripts/worker-bundle-conformance.mjs)

## OAuth boundary for a later client milestone

If generic remote-client onboarding becomes an MVP requirement, implement the MCP OAuth profile before claiming that compatibility. It needs protected-resource metadata identifying authorization servers and discoverability through a challenge `resource_metadata` URL or a well-known endpoint; clients must support both. The existing `WWW-Authenticate: Bearer` response and manual keys do not provide that flow. [Authorization discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery), [current authentication response](https://github.com/rubixhacker/LexCerta/blob/7f5f3eaa6154a1834def2ebcd8af3c44d52bb38d/src/auth/api-key.ts#L124)

OAuth qualification additionally needs PKCE support checks, resource/audience binding, issuer and credential isolation, secure token storage, and the relevant client authorization scenarios. The LexCerta credential and upstream CourtListener credential remain separate; never forward the caller's bearer token to CourtListener. These are requirements for that later authorization profile, not evidence already delivered by choosing SDK v2. [OAuth security requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations), [authorization scope](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

## Decision outcome

The protocol/client choice is resolved: latest dated stateless MCP, stable TypeScript v2, strict modern pin on both ends, custom-key developer pilot, and explicit product boundary qualification. Remaining work is implementation and demonstrated deployment/client evidence. No external-client or full-conformance claim is currently supported by this research.
