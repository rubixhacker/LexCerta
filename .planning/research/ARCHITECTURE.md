# Architecture Research

**Domain:** MCP-native legal citation verification server
**Researched:** 2026-02-13
**Confidence:** HIGH

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                     MCP Transport Layer                              │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Streamable HTTP (POST/GET + SSE streaming)                  │    │
│  │  McpServer + StreamableHTTPServerTransport                   │    │
│  └──────────────────┬───────────────────────────────────────────┘    │
├─────────────────────┼────────────────────────────────────────────────┤
│                     │        Tool Layer                              │
│  ┌──────────────┐  ┌┴─────────────┐  ┌──────────────┐               │
│  │ verify_cite  │  │ check_quote  │  │ batch_verify │               │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│         │                 │                 │                        │
├─────────┴─────────────────┴─────────────────┴────────────────────────┤
│                     Citation Parser                                  │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Regex-based extraction (eyecite patterns ported to TS)      │    │
│  │  Volume + Reporter + Page normalization                      │    │
│  └──────────────────┬───────────────────────────────────────────┘    │
├─────────────────────┼────────────────────────────────────────────────┤
│                     │  Verification Pipeline                         │
│  ┌──────────────┐  ┌┴─────────────┐  ┌──────────────┐               │
│  │ Cache Check  │→ │ CourtListener│→ │ CAP Fallback │               │
│  │ (Redis/Supa) │  │ API v4       │  │ (bulk data)  │               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
├──────────────────────────────────────────────────────────────────────┤
│                     Data / Cache Layer                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ Redis Cache  │  │ Supabase     │  │ Reporter     │               │
│  │ (hot/TTL)    │  │ (persistent) │  │ Lookup Table │               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Communicates With |
|-----------|----------------|-------------------|
| **MCP Server** | Accepts tool calls via Streamable HTTP, routes to handlers, returns structured results | Transport layer, Tool handlers |
| **Tool Handlers** | Define MCP tool schemas (Zod), validate input, orchestrate verification flow, format responses | Citation Parser, Verification Pipeline |
| **Citation Parser** | Extracts citations from text, normalizes reporter abbreviations, produces structured citation objects | Tool Handlers (input), Verification Pipeline (output) |
| **Verification Pipeline** | Tiered lookup: cache -> CourtListener -> CAP fallback; manages circuit breakers and timeouts | Cache Layer, External APIs |
| **Cache Layer** | Two-tier: Redis for hot/TTL cache, Supabase for persistent verified results | Verification Pipeline |
| **CourtListener Client** | Wraps CourtListener API v4 citation-lookup endpoint; handles auth, rate limits (5,000/hr), retries | Verification Pipeline |
| **CAP Fallback Client** | Queries CAP bulk data or remaining API endpoints as secondary source when CourtListener fails or returns 404 | Verification Pipeline |
| **Config/Environment** | Zod-validated environment variables for API keys, cache TTLs, rate limits, timeouts | All components at startup |

## Recommended Project Structure

```
src/
├── server/              # MCP server setup and transport
│   ├── index.ts         # Entry point, McpServer instantiation
│   ├── transport.ts     # Streamable HTTP transport configuration
│   └── tools/           # Tool registrations
│       ├── verify-cite.ts
│       ├── check-quote.ts
│       └── batch-verify.ts
├── parser/              # Citation parsing
│   ├── index.ts         # Main parse function
│   ├── patterns.ts      # Regex patterns (ported from eyecite/citation-regexes)
│   ├── normalizer.ts    # Reporter abbreviation normalization
│   └── types.ts         # ParsedCitation, CitationType enums
├── pipeline/            # Verification pipeline orchestration
│   ├── index.ts         # Tiered pipeline orchestrator
│   ├── strategies/      # Individual verification strategies
│   │   ├── courtlistener.ts
│   │   └── cap.ts
│   ├── circuit-breaker.ts
│   └── types.ts         # VerificationResult, VerificationStatus
├── cache/               # Caching layer
│   ├── index.ts         # Cache interface + factory
│   ├── redis.ts         # Redis TTL cache implementation
│   └── supabase.ts      # Supabase persistent cache
├── clients/             # External API clients
│   ├── courtlistener.ts # CourtListener API v4 wrapper
│   ├── cap.ts           # CAP data access wrapper
│   └── http.ts          # Shared HTTP client with retry/timeout
├── config/              # Configuration
│   ├── index.ts         # Zod schema validation, env parsing
│   └── constants.ts     # Reporter tables, citation type maps
└── types/               # Shared types
    └── index.ts         # Cross-module type definitions
```

### Structure Rationale

- **server/:** Isolates MCP protocol concerns (transport, tool registration) from business logic. Tool files define schemas and delegate to pipeline.
- **parser/:** Self-contained module with zero external dependencies. Can be unit tested in isolation. Porting eyecite regex patterns to TypeScript keeps the parser pure TS without Python interop.
- **pipeline/:** Orchestration layer that manages the tiered fallback strategy. Each verification strategy is a separate module implementing a common interface, making it straightforward to add new sources.
- **cache/:** Abstracted behind an interface so Redis and Supabase implementations can be swapped or composed. The two-tier approach (hot cache + persistent store) is a common pattern for API-backed verification.
- **clients/:** HTTP wrapper modules for external APIs. Each encapsulates authentication, rate limiting, error handling, and response parsing for its API. Shared HTTP client provides retry and timeout defaults.
- **config/:** Single source of truth for environment configuration. Zod validation at startup prevents runtime configuration errors.

## Architectural Patterns

### Pattern 1: Tiered Verification Pipeline (Chain of Responsibility)

**What:** Each verification request flows through ordered tiers: Cache -> CourtListener -> CAP. Each tier either resolves the request or passes it to the next tier. The pipeline stops at the first successful resolution.
**When to use:** When multiple data sources provide overlapping coverage with different reliability/latency characteristics.
**Trade-offs:** Adds latency when primary sources fail (must wait for timeout before fallback). Simpler than parallel requests but slower in degraded scenarios. Clear debugging path since tiers execute in sequence.

**Example:**
```typescript
interface VerificationStrategy {
  name: string;
  verify(citation: ParsedCitation): Promise<VerificationResult | null>;
}

class VerificationPipeline {
  constructor(private strategies: VerificationStrategy[]) {}

  async verify(citation: ParsedCitation): Promise<VerificationResult> {
    for (const strategy of this.strategies) {
      const result = await strategy.verify(citation);
      if (result !== null) {
        return { ...result, source: strategy.name };
      }
    }
    return { status: 'unverified', confidence: 0, source: 'none' };
  }
}
```

### Pattern 2: Circuit Breaker for External APIs

**What:** Wraps external API calls with failure counting. After N failures in a window, the circuit "opens" and subsequent calls skip the API entirely, falling through to the next tier. After a cooldown period, the circuit enters "half-open" state and allows a single test request.
**When to use:** When external APIs have rate limits (CourtListener: 5,000/hr) or intermittent outages. Prevents cascading failures and wasted rate limit budget.
**Trade-offs:** Requires tuning thresholds (failure count, cooldown period). Can mask real issues if thresholds are too aggressive. Essential for meeting the <1.5s performance target.

**Example:**
```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold: number = 5,
    private cooldownMs: number = 30_000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.cooldownMs) {
        this.state = 'half-open';
      } else {
        return null; // Skip to next tier
      }
    }
    try {
      const result = await fn();
      this.reset();
      return result;
    } catch (error) {
      this.recordFailure();
      return null;
    }
  }

  private recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) this.state = 'open';
  }

  private reset() {
    this.failures = 0;
    this.state = 'closed';
  }
}
```

### Pattern 3: Structured Tool Response Envelope

**What:** All MCP tool handlers return a consistent envelope with verification status, confidence level, source attribution, and optional metadata. The LLM consumer receives structured data it can reason about.
**When to use:** Always. MCP tools return `content` arrays; structuring the text content as parseable data (or using structured `text` with clear sections) improves LLM consumption.
**Trade-offs:** Slightly more verbose responses. Requires discipline to maintain consistent format across tools.

## Data Flow

### Request Flow: Single Citation Verification

```
LLM calls verify_cite tool
    |
    v
[MCP Server] receives JSON-RPC call via Streamable HTTP POST
    |
    v
[Tool Handler] validates input with Zod schema
    |
    v
[Citation Parser] extracts/normalizes citation from input string
    |  Produces: { volume: 531, reporter: "U.S.", page: 98, ... }
    v
[Cache Check] lookup by normalized citation key
    |  HIT → return cached VerificationResult (< 50ms)
    |  MISS ↓
    v
[CourtListener Client] POST to /api/rest/v3/citation-lookup/
    |  Circuit breaker guards this call
    |  200 + clusters → citation verified, cache result, return
    |  404 → citation not found in CourtListener
    |  429/5xx → circuit breaker records failure
    |  FAIL ↓
    v
[CAP Fallback] query CAP bulk data / remaining endpoints
    |  FOUND → cache result, return
    |  NOT FOUND → return unverified status
    v
[Tool Handler] formats VerificationResult into MCP content response
    |
    v
[MCP Server] sends JSON-RPC response via Streamable HTTP
```

### Request Flow: Quote Verification (Extended)

```
LLM calls check_quote tool with citation + expected quote text
    |
    v
[Verify citation exists] (same flow as above)
    |  NOT FOUND → return { exists: false, quote_match: null }
    |  FOUND ↓
    v
[Retrieve full opinion text] from CourtListener clusters response
    |
    v
[Quote Matcher] fuzzy string match of expected quote against opinion text
    |  Uses normalized whitespace comparison
    |  Calculates similarity score
    v
[Return] { exists: true, quote_match: { found: bool, similarity: float, context: string } }
```

### Key Data Flows

1. **Citation normalization:** Raw text ("531 US 98") -> Parser -> Normalized form ("531 U.S. 98") -> Cache key generation. This normalization is critical because the same citation can appear in many formats.
2. **Cache write-through:** Successful verification results are written to both Redis (TTL: 24h for hot access) and Supabase (persistent, no expiry) simultaneously. Cache reads check Redis first, fall through to Supabase on miss.
3. **Batch verification fan-out:** The batch_verify tool parses all citations from a text block, deduplicates, checks cache for all at once, then sends only cache-misses through the verification pipeline. Results are aggregated and returned as a single response.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0-100 requests/hr | Single instance, Redis optional (in-memory cache sufficient). CourtListener free tier (5,000 req/day) is adequate. |
| 100-1,000 requests/hr | Redis required for cache hit rate. Circuit breaker essential. May approach CourtListener daily limits; CAP fallback becomes important for coverage. |
| 1,000+ requests/hr | Need CourtListener API quota increase or partnership. Supabase persistent cache becomes primary source for repeat citations (most legal citations are cited repeatedly). Consider pre-populating cache with common citations. |

### Scaling Priorities

1. **First bottleneck:** CourtListener API rate limits (5,000/hr authenticated). Mitigation: aggressive caching, batch deduplication, and circuit breaker to avoid wasting quota on failing requests.
2. **Second bottleneck:** Response latency under load. The <1.5s target is achievable with cache hits (~50ms) but challenging when hitting external APIs (200-800ms per request). Mitigation: pre-warm cache with common citations, parallel verification for batch requests.

## Anti-Patterns

### Anti-Pattern 1: Synchronous Waterfall for Batch Verification

**What people do:** Verify each citation in a batch sequentially, waiting for each to complete before starting the next.
**Why it's wrong:** A 10-citation batch would take 10x single-citation time (potentially 10-15 seconds). Unacceptable for the <3.0s target.
**Do this instead:** Parse all citations, deduplicate, batch-check cache, then run remaining verifications in parallel with `Promise.allSettled()`. Rate limit the parallel requests to stay within API quotas.

### Anti-Pattern 2: Parsing Citations Inside the Verification Pipeline

**What people do:** Combine parsing and verification into a single function that takes raw text and returns verified results.
**Why it's wrong:** Couples two distinct concerns. Makes it impossible to test parsing separately, cache normalized citations, or reuse the parser for non-verification use cases (like annotation).
**Do this instead:** Parser produces structured `ParsedCitation` objects. Pipeline consumes them. Clean interface boundary.

### Anti-Pattern 3: Using SSE Transport for New MCP Servers

**What people do:** Follow older tutorials that set up SSE-based MCP transport.
**Why it's wrong:** SSE transport was deprecated in the MCP specification as of March 2025. Streamable HTTP is the current standard, offering bidirectional communication and better alignment with modern web architecture.
**Do this instead:** Use `StreamableHTTPServerTransport` from the SDK. The SDK provides middleware packages for Express (`@modelcontextprotocol/express`) and Hono (`@modelcontextprotocol/hono`). For Vercel/Edge deployment, Hono is the better choice.

### Anti-Pattern 4: Unbounded External API Calls Without Timeout

**What people do:** Call CourtListener or CAP APIs without explicit timeouts, relying on default HTTP timeouts (often 30s+).
**Why it's wrong:** A single slow API response blocks the entire verification and blows the <1.5s performance target.
**Do this instead:** Set explicit timeouts per API call (e.g., 2s for CourtListener, 2s for CAP). Use `AbortController` with `setTimeout` in the fetch call. Let the circuit breaker handle timeouts as failures.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| **CourtListener API v4** | REST POST to `/api/rest/v3/citation-lookup/` with text body. Auth via API key in `Authorization` header. | Rate limited: 5,000 req/hr (authenticated). Returns citation matches with cluster data. Accepts up to 64,000 chars per request. Free account required. |
| **CAP (Caselaw Access Project)** | Harvard is winding down the API. Bulk data remains available. Use as fallback source, not primary. | API may be unavailable. Plan for bulk data import to Supabase as a more reliable fallback strategy. |
| **Supabase** | PostgreSQL via Supabase client. Stores persistent verification results and potentially CAP bulk data. | Edge Functions for serverless deployment. Row-level security for multi-tenant if needed later. |
| **Redis (Upstash)** | Key-value TTL cache via REST API (Upstash is serverless Redis compatible with Vercel Edge). | Use `@upstash/redis` for Edge-compatible Redis. TTL-based expiry for hot cache layer. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Tool Handler <-> Parser | Direct function call, sync | Parser is a pure function: text in, ParsedCitation[] out. No async, no side effects. |
| Tool Handler <-> Pipeline | Async function call | Pipeline returns Promise<VerificationResult>. Handler awaits and formats for MCP response. |
| Pipeline <-> Cache | Async, interface-based | Cache implements `get(key)` / `set(key, value, ttl?)`. Pipeline does not know if it is Redis, Supabase, or in-memory. |
| Pipeline <-> API Clients | Async, circuit-breaker wrapped | Each client call goes through a circuit breaker. Client returns typed response or null on failure. |
| Server <-> Config | Sync at startup | Config is loaded and validated once via Zod. Components receive typed config objects via dependency injection or module-level imports. |

## Build Order (Dependency Chain)

The following build order respects component dependencies (each phase can only be built after its dependencies exist):

1. **Config + Types** -- No dependencies. Defines shared types (`ParsedCitation`, `VerificationResult`, `VerificationStatus`) and Zod-validated config. Everything else imports from here.

2. **Citation Parser** -- Depends on: Types. Port eyecite regex patterns from `freelawproject/citation-regexes` (already JavaScript). Build normalizer for reporter abbreviations. Fully testable in isolation with no network or external dependencies.

3. **Cache Layer (interface + in-memory)** -- Depends on: Types. Define the cache interface first. Implement in-memory cache for development/testing. Redis and Supabase implementations can come later.

4. **External API Clients** -- Depends on: Types, Config. Build CourtListener client first (primary source). Build CAP client second (fallback). Each wraps HTTP calls with typed responses, auth headers, and timeout handling.

5. **Circuit Breaker** -- Depends on: nothing (utility). Generic circuit breaker that wraps any async function. Used by the pipeline to guard API client calls.

6. **Verification Pipeline** -- Depends on: Cache, API Clients, Circuit Breaker, Types. Composes the tiered strategy: cache -> CourtListener -> CAP. This is the core orchestration logic.

7. **MCP Server + Tool Handlers** -- Depends on: Parser, Pipeline, Config. Final integration layer. Registers tools with `McpServer`, wires up Streamable HTTP transport, connects to parser and pipeline.

8. **Cache Implementations (Redis/Supabase)** -- Depends on: Cache interface. Can be swapped in after the pipeline works with in-memory cache. No changes needed to pipeline code.

## Sources

- [MCP TypeScript SDK - Official Repository](https://github.com/modelcontextprotocol/typescript-sdk) -- HIGH confidence
- [MCP Official Documentation - Build a Server](https://modelcontextprotocol.io/docs/develop/build-server) -- HIGH confidence
- [MCP Transport Specification (June 2025)](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) -- HIGH confidence
- [Why MCP Deprecated SSE for Streamable HTTP](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/) -- MEDIUM confidence
- [CourtListener Citation Lookup API](https://free.law/2024/04/16/citation-lookup-api/) -- HIGH confidence
- [CourtListener API Rate Limits Discussion](https://github.com/freelawproject/courtlistener/discussions/1497) -- MEDIUM confidence
- [freelawproject/citation-regexes (JavaScript)](https://github.com/freelawproject/citation-regexes) -- HIGH confidence
- [eyecite: Legal Citation Parser](https://github.com/freelawproject/eyecite) -- HIGH confidence
- [CAP Transition Announcement](https://lil.law.harvard.edu/blog/2024/03/26/transitions-for-the-caselaw-access-project/) -- HIGH confidence
- [CourtListener MCP Server (reference implementation)](https://github.com/Travis-Prall/court-listener-mcp) -- MEDIUM confidence
- [MCP Streamable HTTP Hono Example](https://github.com/mhart/mcp-hono-stateless) -- MEDIUM confidence

---
*Architecture research for: MCP-native legal citation verification server*
*Researched: 2026-02-13*
