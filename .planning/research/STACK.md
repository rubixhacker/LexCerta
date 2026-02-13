# Stack Research

**Domain:** Legal citation verification MCP server
**Researched:** 2026-02-13
**Confidence:** MEDIUM-HIGH

## Critical Finding: CAP API is Shut Down

The PRD references `https://api.case.law/v1/cases/` for Tier 3 (full-text quote verification). **This API no longer exists.** Harvard's Caselaw Access Project wound down its API and search in September 2024, with the Library Innovation Lab transitioning data stewardship to Free Law Project / CourtListener.

**Impact on architecture:** The tiered lookup must be redesigned. CourtListener now serves as the single primary data source for both existence checks (Tier 2) AND full-text opinion retrieval (Tier 3). CourtListener absorbed CAP's 6.4 million case corpus and now provides full opinion text through its `/api/rest/v4/opinions/` endpoint.

**Confidence:** HIGH -- verified through Harvard LIL official blog post (March 2024) and Library of Congress research guide confirming the transition.

**Source:** https://lil.law.harvard.edu/blog/2024/03/26/transitions-for-the-caselaw-access-project/

---

## Critical Finding: SSE Transport is Deprecated

The PRD specifies SSE transport. **SSE was deprecated in MCP specification 2025-03-26** in favor of Streamable HTTP. The `@modelcontextprotocol/sdk` v1.10.0+ supports Streamable HTTP natively, and Vercel's deployment tooling (`mcp-handler`) is built around it.

**Impact on architecture:** Use Streamable HTTP transport instead of SSE. Streamable HTTP is stateless (perfect for serverless/edge), bidirectional, and reduced CPU usage by 50%+ in production deployments. The SDK still supports SSE for backward compatibility with older clients, but new implementations should target Streamable HTTP.

**Confidence:** HIGH -- MCP specification changelog, Vercel blog, SDK release notes all confirm.

**Source:** https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/

---

## Critical Finding: Eyecite is Python-Only

The PRD references Eyecite for Tier 1 citation parsing. **Eyecite is a Python library with no official JavaScript/TypeScript port.** There is no npm package for it. An incomplete Rust port exists but is not production-ready.

**Impact on architecture:** You cannot use Eyecite directly in a TypeScript/Node.js project. Options:
1. **Build a custom citation parser** in TypeScript using regex patterns derived from Eyecite's logic (West Reporter patterns are well-documented)
2. **Use the `citation` npm package** (unitedstates/citation) -- but it's 8 years unmaintained and focused on statutory citations, not West Reporter case law
3. **Use CourtListener's citation-lookup API** which uses Eyecite server-side -- this means Tier 1 parsing and Tier 2 existence verification collapse into a single API call

**Recommendation:** Option 3. CourtListener's citation-lookup endpoint (`/api/rest/v3/citation-lookup/`) accepts raw text up to 64,000 characters and returns parsed + verified citations in one call. This eliminates the need for a local parser entirely and simplifies the architecture from three tiers to two network calls.

**Confidence:** HIGH -- Eyecite PyPI page confirms Python-only; CourtListener citation-lookup API documented by Free Law Project.

**Sources:**
- https://pypi.org/project/eyecite/
- https://free.law/2024/04/16/citation-lookup-api/

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| TypeScript | 5.7+ | Language | Required by project constraints. Strict mode for legal-grade reliability. | HIGH |
| Node.js | 20 LTS / 22 LTS | Runtime | LTS stability required for legal tooling. 20 is minimum per PRD; 22 is current LTS. | HIGH |
| `@modelcontextprotocol/sdk` | 1.26.0 | MCP server framework | Official SDK. Only supported TypeScript MCP implementation. Supports Streamable HTTP, tool/resource registration, Zod schema validation. | HIGH |
| `mcp-handler` | latest | Vercel deployment adapter | Successor to `@vercel/mcp-adapter`. Handles Streamable HTTP + SSE backward compat on Vercel. Required for Vercel deployment. | HIGH |
| `zod` | 3.25+ | Schema validation | Peer dependency of `@modelcontextprotocol/sdk`. SDK imports from `zod/v4` internally but is backward-compatible with v3.25+. Use `zod@^3.25` to avoid compatibility issues documented in SDK issue #1429. | HIGH |

### API Integrations

| Service | Endpoint | Purpose | Why Recommended | Confidence |
|---------|----------|---------|-----------------|------------|
| CourtListener Citation Lookup | `POST /api/rest/v3/citation-lookup/` | Tier 1+2: Parse citations from text AND verify existence | Single call replaces both Eyecite parsing and existence verification. Built on Eyecite server-side. Accepts up to 64K chars. Returns parsed citations with matches to opinion clusters. | HIGH |
| CourtListener Opinions API | `GET /api/rest/v4/opinions/{id}/` | Tier 3: Retrieve full opinion text for quote verification | Returns `plain_text` and `html` fields. Must fetch by opinion ID (not search snippet). Now contains CAP corpus data. | MEDIUM |
| CourtListener Search API | `GET /api/rest/v4/search/` | Fallback: Search by citation string if citation-lookup returns ambiguous results | Elasticsearch-backed. Supports filtering by reporter, volume, page. | MEDIUM |
| CourtListener Semantic Search | `POST /api/rest/v4/search/` | Future: Semantic search for quote fuzzy matching | Launched November 2025. Could improve quote verification accuracy. | LOW |

### Supporting Libraries

| Library | Version | Purpose | When to Use | Confidence |
|---------|---------|---------|-------------|------------|
| `string-similarity` or `fastest-levenshtein` | latest | Fuzzy string matching for quote verification | When comparing quoted text against full opinion text. Needed for Tier 3 quote integrity scoring. | MEDIUM |
| `p-queue` | latest | Concurrency-limited API request queue | Rate limiting outbound CourtListener requests (5,000/day free tier, 5,000/hour authenticated). Prevents hitting limits under load. | HIGH |
| `lru-cache` | latest | In-memory citation cache | Cache frequently verified citations (Miranda, Roe, Marbury, etc.) to stay within rate limits and meet <1.5s latency target. | HIGH |

### Development Tools

| Tool | Version | Purpose | Notes | Confidence |
|------|---------|---------|-------|------------|
| Vitest | 4.0.x | Testing | Standard for TypeScript projects in 2025-2026. 10-20x faster than Jest. Native TypeScript/ESM support. | HIGH |
| `tsx` | latest | TypeScript execution | For running scripts and local dev without compilation step. | MEDIUM |
| `@modelcontextprotocol/inspector` | latest | MCP debugging | Official MCP Inspector for testing tool registration, request/response cycles. | MEDIUM |
| Biome | latest | Lint + format | Faster than ESLint + Prettier combined. Single tool for both concerns. | MEDIUM |

---

## Installation

```bash
# Core
npm install @modelcontextprotocol/sdk@^1.26 mcp-handler zod@^3.25

# API and utilities
npm install p-queue lru-cache fastest-levenshtein

# Dev dependencies
npm install -D typescript@^5.7 vitest@^4.0 tsx @modelcontextprotocol/inspector
```

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| `@modelcontextprotocol/sdk` (official) | `fastmcp` (v3.32.0, 672 dependents) | FastMCP adds convenience but is a third-party wrapper. For a legal-grade tool, use the official SDK directly to avoid abstraction drift. FastMCP is better suited for rapid prototyping. Revisit if SDK DX proves painful. |
| `mcp-handler` (Vercel adapter) | `@vercel/mcp-adapter` | `@vercel/mcp-adapter` is deprecated. It re-exports from `mcp-handler`. Use `mcp-handler` directly. |
| Streamable HTTP transport | SSE transport | SSE is deprecated in MCP spec 2025-03-26. Streamable HTTP is stateless (ideal for serverless), bidirectional, and 50% less CPU. SSE backward compat is handled automatically by `mcp-handler`. |
| CourtListener citation-lookup (server-side Eyecite) | Local TypeScript citation parser | Building a reliable West Reporter parser from scratch is a significant effort (55M+ citation patterns). CourtListener runs Eyecite server-side and returns structured results. One network call vs. months of regex engineering. |
| CourtListener for everything | CourtListener + CAP split | CAP API is shut down. CourtListener now has the CAP corpus. No reason to use two APIs when one serves both needs. |
| `lru-cache` (in-memory) | Redis / Supabase cache | Start with in-memory. If deployed to multiple edge regions, promote to Vercel KV or Supabase. Premature distributed caching adds complexity for a v1. |
| Vitest | Jest | Vitest is the standard for new TypeScript projects. Native ESM, no transform config, dramatically faster. Jest requires `ts-jest` or SWC config. |
| Biome | ESLint + Prettier | Biome is a single Rust-based tool replacing both. Faster, zero-config for TypeScript. ESLint v9 flat config migration is painful. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| CAP API (`api.case.law`) | **Shut down September 2024.** Harvard LIL wound down the API. All data migrated to CourtListener. | CourtListener API v4 for full-text opinions |
| SSE transport (as primary) | **Deprecated in MCP spec 2025-03-26.** Still works for backward compat but should not be the target transport. | Streamable HTTP via `@modelcontextprotocol/sdk` |
| Eyecite (direct, in TypeScript) | **Python-only library.** No JS port exists. No npm package. | CourtListener citation-lookup endpoint (uses Eyecite server-side) |
| `citation` npm package | **Last updated 8 years ago.** Focuses on US Code/CFR statutory citations, not West Reporter case law citations. | CourtListener citation-lookup or custom minimal parser |
| `@vercel/mcp-adapter` | **Deprecated.** Re-exports from `mcp-handler`. | `mcp-handler` |
| Jest | Vitest has won. Jest requires transform config for TypeScript ESM. | Vitest 4.x |
| `zod@^4.0` (direct) | MCP SDK has documented compatibility issues with Zod v4 (issue #1429). SDK uses `zod/v4` subpath internally. | `zod@^3.25` (SDK-compatible range) |

---

## Stack Patterns by Variant

**If deploying to Vercel (recommended for v1):**
- Use `mcp-handler` for Streamable HTTP transport
- Deploy as Next.js API route or standalone serverless function
- Use Vercel KV for citation cache if multi-region
- Stateless architecture fits Vercel's function model perfectly

**If deploying to Supabase Edge Functions:**
- Use `@modelcontextprotocol/sdk` with `WebStandardStreamableHTTPServerTransport`
- Or use `mcp-lite` (zero-dependency, Fetch API compatible)
- Auth for MCP on Edge Functions is coming soon (not yet available)
- Supabase PostgreSQL can serve as the cache layer

**If both Vercel and Supabase:**
- Vercel for MCP server (compute)
- Supabase for persistent cache / citation history (storage)
- This is likely the production architecture but is overkill for v1

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@modelcontextprotocol/sdk@^1.25.1` | `zod@^3.25` | Versions prior to 1.25.1 have a security vulnerability (CVE-2025-66414: DNS rebinding). Minimum safe version is 1.25.1. |
| `@modelcontextprotocol/sdk@^1.26` | `mcp-handler@latest` | mcp-handler pegs SDK at >=1.25.2 |
| `mcp-handler` | Next.js 14+, Nuxt, SvelteKit | Framework-agnostic Vercel adapter |
| `zod@^3.25` | `@modelcontextprotocol/sdk@^1.17.6+` | v3.25 is the minimum for SDK's internal zod/v4 subpath usage |
| Node.js 20 LTS | All above | Minimum runtime. Node 22 LTS also supported. |

---

## CourtListener API: Key Constraints

| Constraint | Value | Impact |
|------------|-------|--------|
| Free tier rate limit | 5,000 requests/day | Must implement caching aggressively. Top 1,000 cases should be cached. |
| Authenticated rate limit | 5,000 requests/hour | Sufficient for most use cases with caching. |
| Token expiry | 90 days (requires 2FA) | Must implement token refresh workflow or document manual rotation. |
| Citation lookup max text | 64,000 characters (~50 pages) | Sufficient for single-document verification. For bulk, batch requests. |
| Full opinion text retrieval | Requires opinion ID, not available in search snippets | Citation lookup returns cluster ID -> fetch opinions for that cluster -> get full text. Two API calls minimum for quote verification. |

---

## Revised Tiered Architecture (Post-Research)

The PRD's original 3-tier architecture must be updated:

| Original Tier | Original Tool | Revised Approach |
|---------------|---------------|------------------|
| Tier 1: Parsing | Eyecite (local) | CourtListener citation-lookup (remote, uses Eyecite server-side) |
| Tier 2: Existence | CourtListener API | CourtListener citation-lookup (same call as Tier 1) |
| Tier 3: Quote Verification | CAP API | CourtListener Opinions API v4 (CAP is dead) |
| Tier 4: Good Law Status | Westlaw/KeyCite (future) | Unchanged -- still future work |

**Net effect:** Tiers 1 and 2 collapse into a single API call. Tier 3 changes data source but same concept. Simpler architecture.

---

## Sources

- [@modelcontextprotocol/sdk npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- version 1.26.0 verified, HIGH confidence
- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk) -- transport docs, Zod compatibility, HIGH confidence
- [MCP SSE Deprecation](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/) -- Streamable HTTP rationale, HIGH confidence
- [Vercel MCP Deployment Docs](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel) -- mcp-handler usage, HIGH confidence
- [Vercel: Building efficient MCP servers](https://vercel.com/blog/building-efficient-mcp-servers) -- 50% CPU reduction with Streamable HTTP, MEDIUM confidence
- [CourtListener Citation Lookup API](https://free.law/2024/04/16/citation-lookup-api/) -- endpoint, usage, text limits, HIGH confidence
- [CourtListener surpasses 100M requests](https://free.law/2025/09/29/one-hundred-million-requests/) -- API v4 adoption, MEDIUM confidence
- [CourtListener Semantic Search launch](https://free.law/2025/11/05/semantic-search-api/) -- future capability, LOW confidence
- [CAP Transition Announcement](https://lil.law.harvard.edu/blog/2024/03/26/transitions-for-the-caselaw-access-project/) -- API shutdown confirmed, HIGH confidence
- [Library of Congress: CourtListener and CAP](https://guides.loc.gov/free-case-law/courtlistener) -- data migration confirmed, HIGH confidence
- [Eyecite on PyPI](https://pypi.org/project/eyecite/) -- Python-only confirmed, HIGH confidence
- [unitedstates/citation GitHub](https://github.com/unitedstates/citation) -- JS legal citation extractor, unmaintained, MEDIUM confidence
- [@us-legal-tools/courtlistener-sdk npm](https://www.npmjs.com/package/@us-legal-tools/courtlistener-sdk) -- third-party SDK option, MEDIUM confidence
- [Zod v4 + MCP SDK Issue #1429](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1429) -- compatibility resolution, HIGH confidence
- [CVE-2025-66414](https://advisories.gitlab.com/pkg/npm/@modelcontextprotocol/sdk/CVE-2025-66414/) -- DNS rebinding vulnerability, HIGH confidence
- [Vitest 4.0 release](https://www.infoq.com/news/2025/12/vitest-4-browser-mode/) -- version verified, HIGH confidence
- [FastMCP npm](https://www.npmjs.com/package/fastmcp) -- v3.32.0, 672 dependents, MEDIUM confidence
- [mcp-handler npm](https://www.npmjs.com/package/mcp-handler) -- Vercel adapter successor, HIGH confidence
- [Supabase MCP Edge Functions docs](https://supabase.com/docs/guides/getting-started/byo-mcp) -- deployment option, MEDIUM confidence

---
*Stack research for: LexCerta legal citation verification MCP server*
*Researched: 2026-02-13*
