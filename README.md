# LexCerta

LexCerta's target product is a hosted citation and quotation verification service for lawyers working in Claude or ChatGPT. It supports reviewing supplied drafts and checking evidence while an AI host creates a draft, followed by a final whole-draft review and verification report.

The [confirmed product scope](docs/product-scope.md), accepted September 13, 2026, defines the workflows, evidence boundaries, pilot, commercial model, and public-launch criteria. Implementation and host qualification require the separate evidence specified there.

Use the [domain glossary](CONTEXT.md) for terminology and the [architecture decisions](docs/adr/) for recorded boundaries and tradeoffs. The original [product brief](LexCerta.md) and legacy `.planning` project, roadmap, and state files are historical records; their conflicting promises and milestones are superseded by the confirmed scope.

## Implementation checkpoint

LexCerta provides three MCP tools for checking supported U.S. case citations and quoted opinion text against CourtListener. Results distinguish supporting evidence, a source-scoped miss, and an incomplete or unavailable check.

This repository contains a tested service implementation, but the replacement production service is not yet qualified for launch. The recorded runtime decision rejects the Cloudflare Worker candidate and selects TypeScript on Cloud Run. Follow [Deliver isolated staging and immutable promotion](https://github.com/rubixhacker/LexCerta/issues/11) and [Cut over production and retire the legacy runtime](https://github.com/rubixhacker/LexCerta/issues/12). `npm run deploy` intentionally fails until that delivery is implemented.

## What the tools establish

| Tool | Result | Limits |
| --- | --- | --- |
| `parse_citation` | Parses and normalizes a supported volume/reporter/page citation. | Trailing pin cites and parentheticals are preserved without interpretation. This does not check existence. |
| `verify_citation` | Looks for a matching citation in CourtListener, returning source URL, retrieval time, and freshness. | It does not validate the case name, pin cite, legal proposition, or subsequent treatment. A miss is limited to CourtListener. |
| `verify_quote` | Searches for an exact quote after safe text normalization, identifying the matching opinion. | A match proves text presence, including potentially a dissent or quoted material. It does not establish the court's holding or good-law status. |

Verification returns `verified`, `not_found`, or `indeterminate` under contract version 1. A negative quote result requires a complete search of the required opinion sources. Stale positive evidence is disclosed; incomplete searches and operational failures do not become negative claims. Whitespace-only quotes are rejected.

Inputs are bounded: citations are limited to 256 characters, quotes to 20–10,000 Unicode code points, and quote searches to 100 opinions. Each upstream JSON response and source body is limited to 1 MiB, with independent aggregate response and processed-source limits of 16 MiB per request. These are operational bounds; the [frozen corpus replay](operations/qualification/corpus-2026-09-12/README.md) records the tested source coverage. Quote matching preserves substantive wording, case, brackets, ellipses, and ordering.

The service accepts only stateless MCP `2026-07-28`, with the protocol's request headers and metadata, at `POST /`. This is the [latest official specification](https://modelcontextprotocol.io/specification/2026-07-28) as checked on September 12, 2026, and the pinned `@modelcontextprotocol/server` 2.0.0 is the latest stable server SDK release on npm on that date. Authentication uses operator-issued LexCerta bearer keys. `GET /healthz` is the unauthenticated health route. Legacy initialization, sessions and subscriptions are rejected. Supplied browser Origins return 403. The [pinned TypeScript client](examples/README.md) has local HTTP and fixture qualification; deployed-client verification remains open.

## Development and checks

Use Node 24.21.0, pinned in `.nvmrc`. The check command verifies the actual executable version before running the suite.

```sh
nvm use
npm ci
npm run check
```

The check command runs formatting, lint, strict TypeScript checks, unit and local workerd integration tests, qualification-script tests, telemetry/admin tests, and emitted Worker bundle tests. Fixture-backed integrations exercise real local D1, R2, and Durable Objects without live CourtListener traffic. Passing these checks does not qualify a Cloud Run artifact or prove production behavior.

The replacement PostgreSQL/GCS adapters have a separate real-PostgreSQL suite: see [storage qualification](operations/postgres-storage.md) for the disposable fixture and `npm run test:postgres`. CI runs both suites.

The [Node public service](operations/node-runtime.md) is executable through `npm run build:node` and `npm run start:public`. It targets Google Cloud Run with Neon PostgreSQL and GCS, allowing service and database compute to sleep when idle. A separate `npm run test:container` exercises its amd64 image with real local Postgres and HTTP source fixtures. The separate [private operator service and CLI](operations/operator-service.md) implement key issuance, rotation, revocation, limits and status. The [maintenance entry point](operations/maintenance-jobs.md) implements fenced, resumable cleanup. The [migration command](operations/database-migrations.md) applies packaged SQL and restricted runtime grants. The [cloud configuration](infrastructure/README.md) defines isolated GCP resources and maintenance alerts. A [thirty-minute local soak](operations/node-soak.md) and [sealed replay against a restored local database](operations/recovery-journal.md) have passed. Provider setup, complete restore reconciliation and live deployment qualification remain open.

For focused quote regressions:

```sh
npx vitest run test/issue-7-quote-hardening.integration.test.ts src/verification/verify-quote.test.ts
```

`npm run dev` starts the retained local Worker adapter. Authenticated use needs local D1 migrations, an issued test key, and local secrets; the integration fixtures set these up automatically for tests. There is no working self-service account, billing, or dashboard flow in the current package.

## Code map

- `src/verification/`: parsing, citation/quote contracts, matching, source-cache policies, and MCP tool registration in `tools.ts`.
- `src/courtlistener/`: bounded upstream requests, quotas, leases, circuits, and source adapters.
- `src/cache/`: shared source contracts and retained D1/R2 reference persistence.
- `src/postgres/`, `database/migrations/`: replacement PostgreSQL authority, immutable GCS source storage and retention.
- `src/node/`: public HTTP process, bounded Google identity/object transports and parsing workers.
- `src/auth/`, `src/admission/`, `src/admin/`: key authentication, per-key limits, and isolated administration.
- `src/telemetry/`, `src/retention/`: sanitized operational facts and record expiry.
- `src/worker.ts`, `src/worker-request.ts`: retained Worker reference transport; `src/mcp.ts`: shared MCP boundary and dispatch.

The unused Next.js/Express implementation, legacy SDK transports, fuzzy matcher, in-memory authority and their disconnected tests have been removed. The user authorized early obsolete-code removal on September 12, 2026. The active Worker adapter remains a behavioral reference until its Cloud Run replacement is qualified. Vercel Git deployments are disabled in `vercel.json`; existing remote deployments and hostname retirement still require the verified cutover procedure.

## Delivery records

- [PRD: Ship stateless LexCerta on Cloud Run](https://github.com/rubixhacker/LexCerta/issues/1): evidence contract and launch gates. Its original Worker delivery plan is superseded by the runtime decision below.
- [Runtime qualification](operations/worker-runtime-qualification.md): recorded failed Worker memory gate and selected Cloud Run fallback. Linked `.omo/evidence/` artifacts are not included in this checkout, so their measurements are historical records rather than independently reproduced evidence here.
- [Product assessment](docs/product-assessment.md): current strengths, limits and unresolved product evidence.
- [Frozen source corpus](operations/qualification/corpus-2026-09-12/README.md): 60 real cases, a 20-case holdout and source-reviewed quote annotations, frozen before tuning. Source-integrity checks do not establish product or live API accuracy.
- [Observability and retention](operations/observability.md): operational privacy and lifecycle rules.

The [confirmed product scope](docs/product-scope.md) governs product requirements. The [MVP route](docs/mvp-route.md) retains earlier runtime decisions and evidence pointers; its developer-pilot assumptions are superseded. The `.planning/` archive describes the earlier Vercel/Supabase/Stripe proposal and has no authority over current scope or behavior. Paid onboarding requires a written Free Law Project commercial arrangement.
