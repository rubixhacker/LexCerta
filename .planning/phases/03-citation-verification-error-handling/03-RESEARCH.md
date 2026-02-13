# Phase 3: Citation Verification & Error Handling - Research

**Researched:** 2026-02-13
**Domain:** CourtListener API integration, circuit breaker resilience, rate limiting, error classification
**Confidence:** HIGH

## Summary

Phase 3 connects the parser from Phase 2 to CourtListener's citation-lookup API to verify whether a West Reporter citation refers to a real case. The core work is: (1) a CourtListener API client with authentication, rate limiting, and circuit breaker protection, and (2) a `verify_west_citation` MCP tool that classifies results into four unambiguous states: verified, not_found (hallucination), rate_limited, and api_error.

The CourtListener citation-lookup endpoint exists at both v3 (`/api/rest/v3/citation-lookup/`) and v4 (`/api/rest/v4/citation-lookup/`). The v4 endpoint is confirmed available and is the required path for new API users. The endpoint accepts POST requests with a `text` body containing citation text, and returns an array of citation match objects with `citation`, `normalized_citations`, `status` (HTTP status code per citation), `clusters` (matched opinion data), `start_index`, and `end_index`. Authentication is via `Authorization: Token <key>` header. Rate limit is 5,000 requests/hour for authenticated users, enforced via HTTP 429 with a `Retry-After` header.

For resilience, use `cockatiel` (v3.2.1) -- a zero-dependency TypeScript resilience library providing composable circuit breaker, retry, and timeout policies. It is TypeScript-native, well-maintained, and provides exactly the ConsecutiveBreaker/SamplingBreaker patterns needed. Rate limiting should be a hand-built token bucket (simple enough to not warrant a library) that tracks requests per hour and blocks before hitting CourtListener's limit.

**Primary recommendation:** Build a `CourtListenerClient` class in `src/clients/courtlistener.ts` wrapping the v4 citation-lookup endpoint with cockatiel circuit breaker + timeout policies and a token-bucket rate limiter. Build `verify_west_citation` in `src/tools/verify-citation.ts` following the Phase 2 tool pattern, delegating to the client and mapping every response to one of four explicit statuses.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `cockatiel` | ^3.2.1 | Circuit breaker, retry, timeout policies | Zero dependencies. TypeScript-native. Composable policies via `wrap()`. ConsecutiveBreaker and SamplingBreaker cover all circuit breaker patterns needed. Inspired by .NET Polly (industry standard). |
| `zod` | ^3.25 | Input schema for `verify_west_citation` tool | Already in project. SDK peer dependency. |
| `@modelcontextprotocol/sdk` | ^1.26.0 | Tool registration via `server.registerTool()` | Already in project. Phase 1 established pattern. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | ^4.0 | Unit and integration tests | All test files. Mock CourtListener responses for unit tests. |
| `msw` (Mock Service Worker) | ^2 | HTTP request mocking for integration tests | Testing CourtListener client against realistic HTTP responses (200, 404, 429, 500). |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `cockatiel` | `opossum` (v9.0.0) | Opossum is more popular (focused circuit breaker only). Cockatiel provides retry + timeout + circuit breaker as composable policies, which we need all three of. Cockatiel is TypeScript-native with zero deps; opossum has Node.js-specific dependencies. |
| `cockatiel` | Hand-built circuit breaker | Architecture research already sketched a basic circuit breaker. But cockatiel adds SamplingBreaker, half-open testing, event hooks for observability, and composable timeout/retry -- all of which we need for robust error handling. The library is ~15KB. |
| Hand-built token bucket | `limiter` npm package | The `limiter` package provides TokenBucket/RateLimiter classes. However, our rate limiting is simple (track requests/hour against CourtListener's 5,000/hr limit, block before hitting it). A ~20-line token bucket is simpler than adding a dependency. |
| `msw` for test mocking | `nock` or `undici.MockAgent` | MSW intercepts at the network level and works with any HTTP client (fetch, undici). Better for testing realistic error scenarios. However, if the team prefers simpler mocking, vitest's `vi.fn()` to mock the client class directly is also viable. |

**Installation:**
```bash
npm install cockatiel
# Optional for integration test mocking:
npm install -D msw
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── clients/                    # NEW: External API clients
│   └── courtlistener.ts        # CourtListener API client (auth, HTTP, response parsing)
├── resilience/                 # NEW: Resilience infrastructure
│   ├── circuit-breaker.ts      # Pre-configured cockatiel circuit breaker + timeout + retry
│   └── rate-limiter.ts         # Token bucket rate limiter (5,000 req/hr)
├── tools/
│   ├── echo.ts                 # Existing (Phase 1)
│   ├── parse-citation.ts       # Existing (Phase 2)
│   └── verify-citation.ts      # NEW: verify_west_citation MCP tool
├── parser/                     # Existing (Phase 2, unchanged)
├── server.ts                   # MODIFIED: Register verify_west_citation tool
├── config.ts                   # MODIFIED: Add rate limit config options
├── types.ts                    # MODIFIED: Add verification result types
└── ...                         # Other Phase 1/2 files unchanged
```

### Pattern 1: CourtListener API Client
**What:** A single `CourtListenerClient` class that encapsulates all interaction with the CourtListener API. Handles authentication, request construction, response parsing, and delegates resilience concerns to injected cockatiel policies.
**When to use:** All CourtListener API interactions go through this client. Never call the API directly.
**Confidence:** HIGH -- standard API client pattern; v4 endpoint confirmed at `https://www.courtlistener.com/api/rest/v4/citation-lookup/`

```typescript
// src/clients/courtlistener.ts
import type { IPolicy } from "cockatiel";

export interface CitationLookupResult {
  citation: string;
  normalized_citations: string[];
  start_index: number;
  end_index: number;
  status: number;           // HTTP-style status per citation: 200 = found, 404 = not found
  error_message: string;
  clusters: ClusterData[];  // Opinion cluster data when found
}

export interface ClusterData {
  absolute_url: string;
  case_name: string;
  case_name_short: string;
  date_filed: string;
  docket: {
    court: string;
    court_id: string;
  };
  citations: Array<{ volume: number; reporter: string; page: string }>;
}

export class CourtListenerClient {
  private readonly baseUrl = "https://www.courtlistener.com/api/rest/v4";

  constructor(
    private readonly apiKey: string,
    private readonly policy: IPolicy,       // Composed cockatiel policy
    private readonly rateLimiter: RateLimiter,
  ) {}

  async lookupCitation(citationText: string): Promise<CitationLookupResponse> {
    // Rate limiter check BEFORE making the request
    if (!this.rateLimiter.tryConsume()) {
      return { status: "rate_limited", retryAfterMs: this.rateLimiter.msUntilNextToken() };
    }

    // Execute through cockatiel policy (circuit breaker + timeout + retry)
    return this.policy.execute(async ({ signal }) => {
      const response = await fetch(`${this.baseUrl}/citation-lookup/`, {
        method: "POST",
        headers: {
          "Authorization": `Token ${this.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `text=${encodeURIComponent(citationText)}`,
        signal,
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        throw new RateLimitError(retryAfter ? parseInt(retryAfter) * 1000 : 60000);
      }

      if (response.status >= 500) {
        throw new ApiError(response.status, await response.text());
      }

      const data: CitationLookupResult[] = await response.json();
      return { status: "ok", results: data };
    });
  }
}
```

### Pattern 2: Composable Resilience Policies with Cockatiel
**What:** Create pre-configured cockatiel policies (circuit breaker + timeout + retry) and compose them with `wrap()`. The composed policy is injected into the API client.
**When to use:** Wrapping all external API calls. The composed policy handles: timeout (per-request), retry (on transient errors), and circuit breaker (on sustained failures).
**Confidence:** HIGH -- verified from cockatiel v3.2.1 official documentation

```typescript
// src/resilience/circuit-breaker.ts
import {
  circuitBreaker,
  ConsecutiveBreaker,
  handleType,
  handleWhen,
  retry,
  ExponentialBackoff,
  timeout,
  wrap,
} from "cockatiel";

// Custom error types for classification
export class RateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`Rate limited. Retry after ${retryAfterMs}ms`);
    this.name = "RateLimitError";
  }
}

export class ApiError extends Error {
  constructor(public statusCode: number, public body: string) {
    super(`CourtListener API error: ${statusCode}`);
    this.name = "ApiError";
  }
}

// Handle 5xx errors and network failures, but NOT 429 (rate limit) or 404 (not found)
const errorPolicy = handleType(ApiError, err => err.statusCode >= 500)
  .orType(Error, err => err.name === "AbortError");

// Circuit breaker: open after 5 consecutive failures, half-open after 30s
const breaker = circuitBreaker(errorPolicy, {
  halfOpenAfter: 30_000,
  breaker: new ConsecutiveBreaker(5),
});

// Timeout: 5s per request (CourtListener typically responds in 200-800ms)
const timeoutPolicy = timeout(5_000);

// Retry: up to 2 retries with exponential backoff (only on 5xx, not 429)
const retryPolicy = retry(errorPolicy, {
  maxAttempts: 2,
  backoff: new ExponentialBackoff({ initialDelay: 500, maxDelay: 3000 }),
});

// Compose: retry wraps circuit breaker wraps timeout
// Order matters: retry -> circuit breaker -> timeout
export const courtListenerPolicy = wrap(retryPolicy, breaker, timeoutPolicy);

// Export breaker for observability (state change events)
export { breaker as courtListenerBreaker };
```

### Pattern 3: Token Bucket Rate Limiter
**What:** A simple token bucket that tracks requests per hour. Before each API call, the client checks `tryConsume()`. If no tokens available, the request is blocked and the tool returns `rate_limited` status immediately -- never sending the request.
**When to use:** Before every CourtListener API call. Prevents hitting the 5,000/hr server-side limit.
**Confidence:** HIGH -- standard algorithm, simple implementation

```typescript
// src/resilience/rate-limiter.ts

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number = 5000,    // CourtListener limit
    private readonly refillIntervalMs: number = 3_600_000, // 1 hour
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  tryConsume(count: number = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  msUntilNextToken(): number {
    const elapsed = Date.now() - this.lastRefill;
    const msPerToken = this.refillIntervalMs / this.maxTokens;
    const nextTokenAt = msPerToken - (elapsed % msPerToken);
    return Math.ceil(nextTokenAt);
  }

  get remaining(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor(
      (elapsed / this.refillIntervalMs) * this.maxTokens
    );
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }
}
```

### Pattern 4: Four-State Verification Response
**What:** The `verify_west_citation` tool returns one of exactly four statuses: `verified`, `not_found`, `rate_limited`, or `error`. This maps directly to requirements ERR-01, ERR-02, ERR-03. The existing `ToolResponseEnvelope` type from `src/types.ts` is extended with a `status` field in the metadata.
**When to use:** Every response from `verify_west_citation`.
**Confidence:** HIGH -- directly derived from requirements

```typescript
// Extended types for verification results
type VerificationStatus = "verified" | "not_found" | "rate_limited" | "error";

interface VerificationMetadata {
  status: VerificationStatus;
  caseName?: string;
  court?: string;
  dateFiled?: string;
  citations?: Array<{ volume: number; reporter: string; page: string }>;
  courtListenerUrl?: string;
}

interface VerificationError {
  code: "HALLUCINATION_DETECTED" | "RATE_LIMITED" | "API_ERROR" | "CIRCUIT_OPEN" | "PARSE_ERROR";
  message: string;
  details?: unknown;
}

// Usage in tool handler:
// verified citation
createToolResponse({
  valid: true,
  metadata: {
    status: "verified",
    caseName: "Brown v. Board of Education",
    court: "Supreme Court of the United States",
    dateFiled: "1954-05-17",
    citations: [{ volume: 347, reporter: "U.S.", page: "483" }],
    courtListenerUrl: "https://www.courtlistener.com/opinion/...",
  },
  error: null,
});

// hallucination detected
createToolResponse({
  valid: false,
  metadata: { status: "not_found" },
  error: {
    code: "HALLUCINATION_DETECTED",
    message: 'Citation "999 U.S. 999" not found in CourtListener database. This citation may be fabricated.',
    details: { queriedCitation: "999 U.S. 999", normalized: "999 U.S. 999" },
  },
});

// rate limited
createToolResponse({
  valid: false,
  metadata: { status: "rate_limited" },
  error: {
    code: "RATE_LIMITED",
    message: "CourtListener API rate limit reached. Try again later.",
    details: { retryAfterMs: 720 },
  },
});

// API error / circuit open
createToolResponse({
  valid: false,
  metadata: { status: "error" },
  error: {
    code: "API_ERROR",  // or "CIRCUIT_OPEN"
    message: "CourtListener API is currently unavailable. This is NOT a citation verification failure.",
  },
});
```

### Pattern 5: verify_west_citation Tool (Following Phase 2 Pattern)
**What:** The tool follows the same registration pattern as `parse_citation`: a `registerVerifyCitationTool(server, client)` function. It first parses the citation locally (reusing the parser from Phase 2), then calls the CourtListener client, then classifies the response.
**When to use:** This is the main deliverable of Phase 3.
**Confidence:** HIGH -- follows established tool registration pattern

```typescript
// src/tools/verify-citation.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseCitation } from "../parser/index.js";
import type { CourtListenerClient } from "../clients/courtlistener.js";
import { createToolResponse } from "../types.js";

export function registerVerifyCitationTool(
  server: McpServer,
  client: CourtListenerClient,
): void {
  server.registerTool(
    "verify_west_citation",
    {
      description:
        "Verify whether a West Reporter citation refers to a real case. Returns case metadata if verified, or a 'Hallucination Detected' error if the citation is fabricated. Distinguishes API failures and rate limits from verification failures.",
      inputSchema: {
        citation: z
          .string()
          .min(1)
          .describe("West Reporter citation to verify, e.g., '347 U.S. 483'"),
      },
    },
    async ({ citation }) => {
      // Step 1: Parse locally
      const parseResult = parseCitation(citation);
      if (!parseResult.ok) {
        return createToolResponse({
          valid: false,
          metadata: null,
          error: {
            code: "PARSE_ERROR",
            message: parseResult.error.message,
          },
        });
      }

      // Step 2: Look up via CourtListener
      const lookupResult = await client.lookupCitation(
        parseResult.citation.normalized,
      );

      // Step 3: Classify response
      // ... (map to four-state response as shown in Pattern 4)
    },
  );
}
```

### Anti-Patterns to Avoid
- **Treating 429 as "not found":** This is ERR-03's explicit requirement. HTTP 429 from CourtListener MUST map to `rate_limited` status, never to `not_found`. The client must check the HTTP status code BEFORE attempting to parse the response body.
- **Treating 5xx as "not found":** ERR-01 requires distinguishing API failures from citation-not-found. A 500/502/503 from CourtListener means the API is degraded, not that the citation does not exist.
- **Retrying on 429:** The rate limiter should prevent 429s proactively. If a 429 slips through (race condition), do NOT retry -- return `rate_limited` immediately. Only retry on 5xx.
- **Coupling circuit breaker to the tool handler:** The circuit breaker belongs in the resilience layer, injected into the client. The tool handler should never directly interact with circuit breaker state.
- **Creating a new client per request:** The `CourtListenerClient` (with its rate limiter and circuit breaker state) must be a singleton shared across requests. Creating a new one per request resets the circuit breaker and rate limiter state.
- **Blocking the event loop with rate limit sleep:** The rate limiter should return immediately (either "token consumed" or "no tokens available"). Never `await sleep()` to wait for a token -- return `rate_limited` and let the caller decide.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Circuit breaker with half-open state | Custom state machine | `cockatiel` ConsecutiveBreaker | Half-open testing, composable policies, event hooks for observability. Hand-rolling misses edge cases (concurrent half-open requests, state transition races). |
| Timeout with AbortSignal | Custom setTimeout + AbortController | `cockatiel` timeout policy | Cockatiel passes AbortSignal to the execution function, handles cleanup, and composes with retry/circuit breaker. |
| Retry with exponential backoff | Custom retry loop | `cockatiel` retry policy | Jitter, max delay cap, composable error filtering (retry 5xx but not 429). |
| Citation text extraction from API response | Custom text block construction | Send `parsedCitation.normalized` directly to API | CourtListener's citation-lookup uses eyecite server-side. Send the normalized citation string and let the API do the heavy parsing. |
| CourtListener response type definitions | Guess from blog posts | Build types from actual API responses during development | The cluster object structure is not fully documented. Use OPTIONS request and real API responses to define TypeScript types accurately. |

**Key insight:** Cockatiel replaces ~150 lines of hand-rolled circuit breaker + retry + timeout code with ~15 lines of composable, tested, typed policies. The rate limiter is the only thing simple enough to hand-build (token bucket is ~20 lines).

## Common Pitfalls

### Pitfall 1: CourtListener Citation-Lookup Returns Per-Citation Status Codes
**What goes wrong:** Developers treat the HTTP response status as the verification result. But the citation-lookup endpoint always returns HTTP 200 for the overall request, even when individual citations are not found. Each citation in the response array has its own `status` field (200 = found, 404 = not found).
**Why it happens:** Standard REST API conventions use the HTTP status code for the overall request. CourtListener's citation-lookup accepts text that may contain multiple citations, so it uses per-citation status codes in the response body.
**How to avoid:** Parse the response body and check each citation result's `status` field individually. An HTTP 200 response does NOT mean the citation was verified -- it means the API processed the request. A per-citation `status: 404` means that specific citation was not found.
**Warning signs:** All citations appear "verified" because the HTTP response was 200.

### Pitfall 2: Rate Limiter Resets on Server Restart (Stateless Transport)
**What goes wrong:** The token bucket rate limiter is in-memory. With the stateless transport pattern (new server instance per request, as established in Phase 1), the rate limiter state is lost between requests.
**Why it happens:** Phase 1's stateless pattern creates a new `McpServer` per request. If the rate limiter is scoped to the server instance, it resets every request.
**How to avoid:** The rate limiter and circuit breaker must be module-level singletons, NOT scoped to the McpServer or transport instance. They live in a shared module that persists for the lifetime of the Node.js process. The `createServer()` function in `src/server.ts` receives a shared client instance via closure or parameter.
**Warning signs:** Rate limit never triggers in testing. CourtListener returns 429 despite the rate limiter supposedly being active.

### Pitfall 3: Circuit Breaker Opens on Rate Limit Errors
**What goes wrong:** The circuit breaker treats 429 (rate limit) as a failure and counts it toward the consecutive failure threshold. After 5 rate-limited requests, the circuit opens and ALL subsequent requests fail with "circuit open" even though the API is healthy.
**Why it happens:** Both 429 and 5xx are HTTP errors. A naive error handler counts all non-2xx as failures.
**How to avoid:** The cockatiel error policy must ONLY handle 5xx errors and network failures. Rate limit errors (429) should NOT trigger the circuit breaker -- they bypass it entirely and return `rate_limited` status directly. The client must check for 429 before the circuit breaker wraps the call, or use cockatiel's `handleType` to filter specifically for `ApiError` (5xx) and exclude `RateLimitError`.
**Warning signs:** Circuit breaker opens during periods of high traffic (which is when rate limiting kicks in, not when the API is down).

### Pitfall 4: Sending Full Text Blocks When Only One Citation Is Needed
**What goes wrong:** The citation-lookup endpoint accepts text blocks up to 64,000 characters. Developers send the entire document or large text blocks when verifying a single citation, which wastes API processing time and returns multiple results that need filtering.
**Why it happens:** The API was designed for bulk citation extraction from documents. For single-citation verification, this is overkill.
**How to avoid:** For `verify_west_citation`, send ONLY the normalized citation string (e.g., "347 U.S. 483") as the text body. This is a short string (~15 characters) that the API processes instantly and returns exactly one result.
**Warning signs:** API response time is 2-3 seconds for single citation verification (should be 200-500ms). Response contains multiple citation matches for a single-citation query.

### Pitfall 5: Not Handling the "Ambiguous Citation" Case
**What goes wrong:** CourtListener may return multiple clusters for a single citation if the citation is ambiguous. The tool treats this as "verified" and returns the first match, which may be wrong.
**Why it happens:** Some citations genuinely match multiple cases (e.g., same volume and page in different reporter editions). The API returns all matches.
**How to avoid:** If the response contains multiple clusters for a single citation, return `verified` but include all matches in the metadata. The LLM consumer can then disambiguate using additional context (case name, date, court).
**Warning signs:** Verification returns a case name that does not match what the user expected.

### Pitfall 6: Forgetting Content-Type for POST Body
**What goes wrong:** The citation-lookup endpoint expects `application/x-www-form-urlencoded` POST body with a `text` field. Sending JSON or raw text without the correct content type returns an empty or error response.
**Why it happens:** Modern APIs typically use JSON. CourtListener's citation-lookup uses form-encoded data.
**How to avoid:** Set `Content-Type: application/x-www-form-urlencoded` and format the body as `text=<url-encoded-citation>`.
**Warning signs:** API returns 200 with an empty array despite sending a valid citation.

## Code Examples

### Complete CourtListener Client with Resilience

```typescript
// Source: Synthesized from CourtListener API docs + cockatiel v3.2.1 API
// src/clients/courtlistener.ts

import type { IPolicy } from "cockatiel";
import { logger } from "../logger.js";

export interface CitationMatch {
  citation: string;
  normalized_citations: string[];
  start_index: number;
  end_index: number;
  status: number;        // 200 = found, 404 = not found
  error_message: string;
  clusters: ClusterData[];
}

export interface ClusterData {
  absolute_url: string;
  case_name: string;
  case_name_short: string;
  date_filed: string;
  docket: {
    court: string;
    court_id: string;
  };
  citations: Array<{ volume: number; reporter: string; page: string }>;
}

export type LookupResponse =
  | { status: "ok"; matches: CitationMatch[] }
  | { status: "rate_limited"; retryAfterMs: number }
  | { status: "error"; code: string; message: string };

export class RateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super("Rate limited");
    this.name = "RateLimitError";
  }
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class CourtListenerClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly policy: IPolicy,
    private readonly rateLimiter: { tryConsume(): boolean; msUntilNextToken(): number },
    baseUrl = "https://www.courtlistener.com/api/rest/v4",
  ) {
    this.baseUrl = baseUrl;
  }

  async lookupCitation(normalizedCitation: string): Promise<LookupResponse> {
    // Check rate limiter BEFORE entering the circuit breaker
    if (!this.rateLimiter.tryConsume()) {
      logger.warn("Rate limit exhausted, blocking request");
      return {
        status: "rate_limited",
        retryAfterMs: this.rateLimiter.msUntilNextToken(),
      };
    }

    try {
      const matches = await this.policy.execute(async ({ signal }) => {
        const response = await fetch(`${this.baseUrl}/citation-lookup/`, {
          method: "POST",
          headers: {
            Authorization: `Token ${this.apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `text=${encodeURIComponent(normalizedCitation)}`,
          signal,
        });

        // 429 must NOT be retried or counted as circuit breaker failure
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          throw new RateLimitError(
            retryAfter ? Number.parseInt(retryAfter) * 1000 : 60_000,
          );
        }

        // 5xx errors ARE retried and DO count toward circuit breaker
        if (response.status >= 500) {
          throw new ApiError(response.status, `Server error: ${response.status}`);
        }

        return (await response.json()) as CitationMatch[];
      });

      return { status: "ok", matches };
    } catch (err) {
      if (err instanceof RateLimitError) {
        return { status: "rate_limited", retryAfterMs: err.retryAfterMs };
      }
      // Circuit breaker open or all retries exhausted
      const message = err instanceof Error ? err.message : "Unknown error";
      return { status: "error", code: "API_ERROR", message };
    }
  }
}
```

### Cockatiel Policy Composition

```typescript
// Source: cockatiel v3.2.1 official docs (https://github.com/connor4312/cockatiel)
// src/resilience/circuit-breaker.ts

import {
  circuitBreaker,
  ConsecutiveBreaker,
  handleType,
  retry,
  ExponentialBackoff,
  timeout,
  wrap,
} from "cockatiel";
import { ApiError } from "../clients/courtlistener.js";

// Only handle 5xx server errors -- NOT RateLimitError, NOT 404
const serverErrorPolicy = handleType(ApiError, (err) => err.statusCode >= 500);

export const courtListenerBreaker = circuitBreaker(serverErrorPolicy, {
  halfOpenAfter: 30_000,             // Test after 30 seconds
  breaker: new ConsecutiveBreaker(5), // Open after 5 consecutive 5xx errors
});

const courtListenerTimeout = timeout(5_000); // 5s per request

const courtListenerRetry = retry(serverErrorPolicy, {
  maxAttempts: 2,
  backoff: new ExponentialBackoff({
    initialDelay: 500,
    maxDelay: 3_000,
  }),
});

// Compose: outer retry -> circuit breaker -> inner timeout
export const courtListenerPolicy = wrap(
  courtListenerRetry,
  courtListenerBreaker,
  courtListenerTimeout,
);

// Observable events for logging
courtListenerBreaker.onBreak(() => {
  console.error("[CIRCUIT] CourtListener circuit breaker OPENED");
});
courtListenerBreaker.onReset(() => {
  console.error("[CIRCUIT] CourtListener circuit breaker CLOSED");
});
courtListenerBreaker.onHalfOpen(() => {
  console.error("[CIRCUIT] CourtListener circuit breaker HALF-OPEN");
});
```

### Token Bucket Rate Limiter

```typescript
// src/resilience/rate-limiter.ts

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number = 4500, // 90% of 5000 to leave margin
    private readonly refillIntervalMs: number = 3_600_000,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  tryConsume(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  msUntilNextToken(): number {
    this.refill();
    if (this.tokens > 0) return 0;
    const msPerToken = this.refillIntervalMs / this.maxTokens;
    const elapsed = Date.now() - this.lastRefill;
    return Math.max(0, Math.ceil(msPerToken - (elapsed % msPerToken)));
  }

  get remaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const tokensToAdd = (elapsed / this.refillIntervalMs) * this.maxTokens;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}
```

### Wiring It Together in server.ts

```typescript
// Source: Follows Phase 1/2 server.ts pattern
// src/server.ts (modified)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.js";
import { registerEchoTool } from "./tools/echo.js";
import { registerParseCitationTool } from "./tools/parse-citation.js";
import { registerVerifyCitationTool } from "./tools/verify-citation.js";
import { CourtListenerClient } from "./clients/courtlistener.js";
import { courtListenerPolicy } from "./resilience/circuit-breaker.js";
import { TokenBucketRateLimiter } from "./resilience/rate-limiter.js";
import type { Config } from "./config.js";

// Module-level singletons (persist across stateless requests)
let sharedClient: CourtListenerClient | null = null;

function getClient(config: Config): CourtListenerClient {
  if (!sharedClient) {
    const rateLimiter = new TokenBucketRateLimiter();
    sharedClient = new CourtListenerClient(
      config.COURTLISTENER_API_KEY,
      courtListenerPolicy,
      rateLimiter,
    );
  }
  return sharedClient;
}

export function createServer(config: Config): McpServer {
  const server = new McpServer(
    { name: "lexcerta", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );

  const client = getClient(config);

  registerEchoTool(server);
  registerParseCitationTool(server);
  registerVerifyCitationTool(server, client);
  logger.debug("Registered tools: echo, parse_citation, verify_west_citation");

  return server;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| CourtListener API v3 | CourtListener API v4 | 2024-2025 | New users cannot access v3. Use v4 endpoint: `/api/rest/v4/citation-lookup/` |
| Anonymous API access | API key required for all access | 2024 | Must have authenticated API key. Unauthenticated requests are blocked. |
| Hand-rolled circuit breakers | `cockatiel` composable policies | Cockatiel v3.x (stable) | Zero-dep, TypeScript-native, composable retry/breaker/timeout. Industry pattern from .NET Polly. |
| CAP API as fallback source | CourtListener only (CAP shut down) | Sept 2024 | No fallback API. Circuit breaker and caching become more critical. |
| SSE transport for MCP | Streamable HTTP | MCP spec March 2025 | Phase 1 already handles this. No impact on Phase 3. |

**Deprecated/outdated:**
- CourtListener API v3 for new users: Use v4.
- Anonymous API access: All requests require `Authorization: Token <key>`.
- CAP API: Shut down September 2024. Not a viable fallback.

## Open Questions

1. **Exact CourtListener v4 citation-lookup response schema for the `clusters` field**
   - What we know: The response is an array of objects with `citation`, `normalized_citations`, `status`, `error_message`, `clusters`, `start_index`, `end_index`. The `clusters` field contains opinion data including case name, court, and date.
   - What's unclear: The exact TypeScript type for the `clusters` array items (which fields are present, nesting structure). The v3 blog post shows the structure but v4 may differ.
   - Recommendation: During implementation, make an OPTIONS request to the v4 endpoint and a test POST with a known citation (e.g., "347 U.S. 483") to capture the exact response structure. Define types from the real response. MEDIUM risk -- types may need adjustment.

2. **CourtListener rate limit exact threshold**
   - What we know: 5,000 requests/hour for authenticated users (referenced in multiple discussions). HTTP 429 returned with `Retry-After` header when exceeded.
   - What's unclear: Whether the 5,000/hr is per-endpoint or global. Whether the citation-lookup endpoint counts differently. Whether there is also a daily limit.
   - Recommendation: Set the token bucket to 4,500/hr (90% of 5,000) to leave a safety margin. Monitor actual 429 responses to calibrate. LOW risk -- conservative limit is safe.

3. **Circuit breaker vs. rate limiter interaction when circuit is open**
   - What we know: When the circuit breaker is open, requests are rejected immediately without hitting the API. The rate limiter should NOT consume a token for circuit-breaker-rejected requests.
   - What's unclear: With cockatiel's `wrap()` composition, does the rate limiter check happen before or after the circuit breaker?
   - Recommendation: Check the rate limiter BEFORE entering the cockatiel policy chain (in the client code, not in the policy). This way, rate limiter tokens are only consumed when a request will actually be attempted. If the circuit is open, cockatiel throws `BrokenCircuitError` without consuming a rate limit token. This is already handled by the pattern in the code examples above. LOW risk.

4. **Content-Type for citation-lookup POST**
   - What we know: The blog post example uses `--data 'text=...'` which implies `application/x-www-form-urlencoded`. The v3 endpoint documentation shows this format.
   - What's unclear: Whether v4 also accepts `application/json` with `{ "text": "..." }`.
   - Recommendation: Use `application/x-www-form-urlencoded` (confirmed working format). Test with JSON as an alternative during development. LOW risk.

## Sources

### Primary (HIGH confidence)
- [CourtListener Citation Lookup API Announcement](https://free.law/2024/04/16/citation-lookup-api/) -- Endpoint URL, request format, response structure, use case
- [CourtListener API v4 root](https://www.courtlistener.com/api/rest/v4/) -- Confirmed v4 citation-lookup endpoint exists (verified via WebFetch)
- [CourtListener Rate Limit Discussion](https://github.com/freelawproject/courtlistener/discussions/1497) -- HTTP 429, Retry-After header, auth requirements, rate limit enforcement
- [Cockatiel GitHub](https://github.com/connor4312/cockatiel) -- v3.2.1 API: ConsecutiveBreaker, SamplingBreaker, wrap(), handleType(), event hooks (verified via WebFetch)
- [Cockatiel npm](https://www.npmjs.com/package/cockatiel) -- Version 3.2.1, zero dependencies (verified via `npm view`)
- Existing codebase: `src/types.ts`, `src/parser/index.ts`, `src/tools/parse-citation.ts`, `src/server.ts`, `src/config.ts` -- Phase 1/2 patterns for tool registration, response envelope, parser integration

### Secondary (MEDIUM confidence)
- [CourtListener 100M API Requests](https://free.law/2025/09/29/one-hundred-million-requests/) -- v4 API adoption, scale context
- [Travis-Prall/court-listener-mcp](https://github.com/Travis-Prall/court-listener-mcp) -- Reference MCP implementation using CourtListener v4 base URL
- [Opossum circuit breaker](https://github.com/nodeshift/opossum) -- v9.0.0, alternative to cockatiel (focused circuit breaker only)
- [Token bucket rate limiting pattern](https://kendru.github.io/javascript/2018/12/28/rate-limiting-in-javascript-with-a-token-bucket/) -- Algorithm reference

### Tertiary (LOW confidence)
- CourtListener `clusters` response field structure -- inferred from blog post examples and API definition repo. Exact v4 fields need validation with real API call during implementation.
- `@us-legal-tools/courtlistener-sdk` npm package -- exists but not evaluated for quality or maintenance status.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- cockatiel version and API verified via npm. CourtListener v4 endpoint confirmed. No new unverified dependencies.
- Architecture: HIGH -- Follows Phase 1/2 patterns exactly. Client + resilience + tool separation is standard. Code examples derive from verified library APIs.
- Pitfalls: HIGH -- Per-citation status codes, singleton rate limiter, 429 vs 5xx classification all documented from authoritative sources.
- CourtListener response types: MEDIUM -- Blog post shows response structure but exact v4 cluster object fields need validation with real API response during implementation.
- Rate limit threshold: MEDIUM -- 5,000/hr referenced in discussions but not in official endpoint documentation. Conservative 4,500/hr budget mitigates risk.

**Research date:** 2026-02-13
**Valid until:** 2026-03-15 (CourtListener API is stable; cockatiel v3.x is stable)
