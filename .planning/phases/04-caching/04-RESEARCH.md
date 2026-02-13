# Phase 4: Caching - Research

**Researched:** 2026-02-13
**Domain:** In-memory LRU caching for immutable citation verification results
**Confidence:** HIGH

## Summary

Phase 4 adds an in-memory cache layer between the `verify_west_citation` tool handler and the `CourtListenerClient`, so that repeated lookups for the same citation are served instantly without consuming API rate limit tokens. The domain is unusually simple: legal citations are immutable records, so cached results never expire or need invalidation. The cache key is the `normalized` citation string already produced by the parser (e.g., `"347 U.S. 483"`), and the cached value is the full `LookupResponse` from the client.

The standard library for this in the Node.js/TypeScript ecosystem is `lru-cache` by Isaac Schlueter (npm). It is written in TypeScript, has zero dependencies, and is the most widely used LRU cache in the JavaScript ecosystem. Version 11.x provides a simple `new LRUCache({ max })` constructor that pre-allocates memory for optimal performance. Since citation results never expire, we set `max` (entry count limit) but no `ttl`. The LRU eviction policy means the least-recently-verified citations are dropped first when memory is constrained -- which is the correct behavior since frequently-checked citations stay cached.

The integration point is clean: the cache sits in the tool handler (`verify-citation.ts`), checked AFTER parsing succeeds but BEFORE calling `client.lookupCitation()`. Only `status: "ok"` responses are cached (never rate_limited or error responses, since those are transient). This means the cache is a pure optimization layer that does not change the tool's observable behavior for any non-cached path.

**Primary recommendation:** Use `lru-cache` v11.x with `max: 1000` entries (no TTL). Add a `CitationCache` wrapper class in `src/cache/citation-cache.ts` that encapsulates the LRU cache with typed get/set and a `stats()` method for observability. Wire it into the `verify_west_citation` tool handler between parse and API call. Cache only successful lookups (`status: "ok"`).

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `lru-cache` | ^11.2.6 | In-memory LRU cache with max entry limit | Zero dependencies. TypeScript-native. Most performant LRU implementation in JS ecosystem. Pre-allocates memory with `max` for O(1) get/set. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | ^4 | Unit tests for cache behavior | Already in project. Test cache hit/miss, eviction, stats. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `lru-cache` | Plain `Map` | A `Map` has O(1) get/set and never evicts. Simpler, but unbounded memory -- if the server processes thousands of unique citations over its lifetime, the Map grows without limit. LRU provides a memory safety bound. |
| `lru-cache` | Hand-built LRU (doubly-linked list + Map) | ~50-70 lines of code. Avoids a dependency but reimplements what `lru-cache` does with far more testing and optimization. Not worth it for a well-maintained zero-dep library. |
| `lru-cache` | `quick-lru` | Smaller API surface, also zero-dep. But `lru-cache` is more widely used, better optimized for repeated gets, and TypeScript-native. |
| `lru-cache` | `node-cache` | Has TTL built in. But we explicitly do NOT want TTL (citations are immutable). Adds unnecessary complexity. |

**Installation:**
```bash
npm install lru-cache
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── cache/                      # NEW: Cache layer
│   └── citation-cache.ts       # LRU cache wrapper with typed API
├── cache/__tests__/            # NEW: Cache tests
│   └── citation-cache.test.ts  # Unit tests for cache behavior
├── clients/
│   └── courtlistener.ts        # UNCHANGED
├── tools/
│   └── verify-citation.ts      # MODIFIED: Check cache before API call
├── server.ts                   # MODIFIED: Create cache, pass to tool
└── ...                         # Other files unchanged
```

### Pattern 1: Cache Wrapper Class
**What:** A thin `CitationCache` class that wraps `lru-cache` with domain-specific types. The cache key is the normalized citation string (`string`), and the value is the `LookupResponse` with `status: "ok"`. Provides `get()`, `set()`, and `stats()` methods.
**When to use:** Always. Even though `lru-cache` is simple, the wrapper provides type safety, encapsulates the "only cache ok responses" rule, and exposes stats for observability.
**Confidence:** HIGH

```typescript
// src/cache/citation-cache.ts
import { LRUCache } from "lru-cache";
import type { CitationMatch } from "../clients/courtlistener.js";

/** Cached successful lookup result (only status: "ok" responses are cached). */
export interface CachedLookup {
  matches: CitationMatch[];
}

export interface CacheStats {
  size: number;       // Current number of entries
  maxSize: number;    // Maximum entries allowed
  hits: number;       // Total cache hits
  misses: number;     // Total cache misses
}

export class CitationCache {
  private readonly cache: LRUCache<string, CachedLookup>;
  private hitCount = 0;
  private missCount = 0;

  constructor(maxEntries = 1000) {
    this.cache = new LRUCache<string, CachedLookup>({ max: maxEntries });
  }

  /** Look up a cached result by normalized citation string. */
  get(normalizedCitation: string): CachedLookup | undefined {
    const result = this.cache.get(normalizedCitation);
    if (result) {
      this.hitCount++;
    } else {
      this.missCount++;
    }
    return result;
  }

  /** Cache a successful lookup result. */
  set(normalizedCitation: string, result: CachedLookup): void {
    this.cache.set(normalizedCitation, result);
  }

  /** Return cache statistics for observability. */
  stats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      hits: this.hitCount,
      misses: this.missCount,
    };
  }
}
```

### Pattern 2: Cache Integration in Tool Handler
**What:** The `verify_west_citation` tool handler checks the cache after parsing succeeds but before calling the CourtListener client. On a cache hit, it immediately constructs the response from cached data. On a cache miss and a successful API response, it stores the result in the cache before returning.
**When to use:** This is the primary integration pattern for Phase 4.
**Confidence:** HIGH

```typescript
// src/tools/verify-citation.ts (modified)
// Key changes shown, not full file

export function registerVerifyCitationTool(
  server: McpServer,
  client: CourtListenerClient,
  cache: CitationCache,        // NEW parameter
): void {
  server.registerTool(
    "verify_west_citation",
    { /* schema unchanged */ },
    async ({ citation }) => {
      // Step 1: Parse locally (unchanged)
      const parseResult = parseCitation(citation);
      if (!parseResult.ok) { /* ... unchanged ... */ }

      const normalized = parseResult.citation.normalized;

      // Step 2: Check cache BEFORE API call
      const cached = cache.get(normalized);
      if (cached) {
        // Build response from cached data (same logic as fresh lookup)
        return buildVerifiedResponse(cached.matches, citation, normalized);
      }

      // Step 3: Lookup via CourtListener (unchanged)
      const lookupResult = await client.lookupCitation(normalized);

      // Step 4: Cache successful lookups only
      if (lookupResult.status === "ok") {
        cache.set(normalized, { matches: lookupResult.matches });
      }

      // Step 5: Classify response (unchanged)
      // ...
    },
  );
}
```

### Pattern 3: Module-Level Singleton Cache
**What:** The cache must be a module-level singleton (same pattern as the `CourtListenerClient` in `server.ts`), so it persists across stateless MCP requests. It is created once in `server.ts` and injected into the tool registration.
**When to use:** Always -- the same Pitfall 2 from Phase 3 research applies: if the cache is scoped to the `McpServer` instance rather than the module, it resets on every request.
**Confidence:** HIGH

```typescript
// src/server.ts (modified)
import { CitationCache } from "./cache/citation-cache.js";

let sharedClient: CourtListenerClient | null = null;
let sharedCache: CitationCache | null = null;  // NEW

function getClient(config: Config): CourtListenerClient { /* unchanged */ }

function getCache(): CitationCache {
  if (!sharedCache) {
    sharedCache = new CitationCache();  // default max: 1000
  }
  return sharedCache;
}

export function createServer(config: Config): McpServer {
  const server = new McpServer(/* ... */);
  const client = getClient(config);
  const cache = getCache();  // NEW

  registerEchoTool(server);
  registerParseCitationTool(server);
  registerVerifyCitationTool(server, client, cache);  // MODIFIED: pass cache
  // ...
}

/** Reset singletons (for testing). */
export function resetClient(): void {
  sharedClient = null;
  sharedCache = null;  // NEW
}
```

### Pattern 4: Only Cache "ok" Responses
**What:** Only cache `LookupResponse` objects with `status: "ok"`. Never cache `rate_limited` or `error` responses, because those are transient conditions that should be re-tried on the next request.
**When to use:** This is a critical rule. A cached `rate_limited` response would cause the tool to return "rate limited" indefinitely even after the rate limit window passes.
**Confidence:** HIGH

```typescript
// Decision logic:
// status: "ok"           -> CACHE (immutable citation data)
// status: "rate_limited" -> DO NOT CACHE (transient)
// status: "error"        -> DO NOT CACHE (transient API failure)
```

**Important nuance:** Among `status: "ok"` responses, both verified citations (match with `status: 200` and clusters) and confirmed not-found citations (match with `status: 404`) should be cached. A citation that does not exist in CourtListener today will not appear tomorrow -- the database grows by adding new decisions, not by retroactively creating West Reporter citations that never existed. Caching not-found results avoids redundant "is this hallucinated?" checks.

### Anti-Patterns to Avoid
- **Caching at the HTTP level:** Do NOT add caching inside `CourtListenerClient`. The cache belongs in the tool handler because: (a) the cache key is the normalized citation, not the raw HTTP request; (b) the tool handler decides what to cache (only "ok" responses); (c) future tools (like `verify_quote_integrity` in Phase 5) will call the same client but need different caching logic.
- **TTL-based expiration:** Citations are immutable legal records. Adding TTL creates unnecessary cache misses and API calls. The LRU eviction policy handles memory pressure; time-based expiry adds no value.
- **Caching raw strings or parsed objects:** Cache the `CitationMatch[]` array (the API response data), not the formatted tool response. This allows the response formatting logic to evolve without invalidating the cache.
- **Separate cache per tool instance:** The cache must be shared across all stateless request handlers (module-level singleton pattern), not scoped to a single `McpServer` instance.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LRU eviction with memory bounds | Custom doubly-linked list + Map | `lru-cache` v11.x | Pre-allocated memory, O(1) operations, battle-tested. Hand-rolling an LRU is a classic "looks simple, has edge cases" trap (concurrent access, eviction ordering, memory accounting). |
| Cache key normalization | Custom citation-to-key function | Reuse `parsedCitation.normalized` from parser | The parser already normalizes "347 U. S. 483" and "347 US 483" to the same canonical string "347 U.S. 483". No additional key normalization needed. |

**Key insight:** The parser from Phase 2 already solves the hardest caching problem (key normalization). Different surface forms of the same citation produce the same `normalized` string, so the cache naturally deduplicates without any extra work.

## Common Pitfalls

### Pitfall 1: Not Caching "not_found" Results
**What goes wrong:** Only caching verified citations, not "not found" results. An AI that repeatedly hallucinates the same citation triggers a new API call every time, wasting rate limit tokens on a citation that will never exist.
**Why it happens:** Intuition says "only cache positive results." But in this domain, a "not found" result from CourtListener is just as immutable as a "found" result -- the API's citation database does not retroactively create citations.
**How to avoid:** Cache all `status: "ok"` responses from the client, regardless of whether the per-citation status is 200 (found) or 404 (not found). The cache stores the API response, and the tool handler classifies it on each access.
**Warning signs:** Rate limiter depletes quickly when an AI document contains the same hallucinated citation repeated many times.

### Pitfall 2: Cache Singleton Resets on Each Request
**What goes wrong:** The cache is created inside `createServer()` and scoped to the `McpServer` instance. With the stateless transport pattern (new server per request), the cache is empty for every request.
**Why it happens:** Same root cause as Phase 3's Pitfall 2 (rate limiter resetting). The stateless transport creates a new `McpServer` per request.
**How to avoid:** The cache must be a module-level singleton in `server.ts`, following the exact same pattern used for `sharedClient`. Create it once, inject it into tool registration.
**Warning signs:** Cache stats always show 0 hits, even when the same citation is verified repeatedly.

### Pitfall 3: Using Unnormalized Citation as Cache Key
**What goes wrong:** Using the raw user input (e.g., `"347 U. S. 483"`) as the cache key instead of the normalized form (`"347 U.S. 483"`). The same citation with different spacing or punctuation creates separate cache entries, defeating deduplication.
**Why it happens:** The raw input is the first thing available in the handler. Easy to use by mistake.
**How to avoid:** Always use `parseResult.citation.normalized` as the cache key. This is already available after the parse step succeeds.
**Warning signs:** Cache hit rate is lower than expected. Multiple cache entries exist for what is logically the same citation.

### Pitfall 4: Forgetting to Pass Cache in Tests
**What goes wrong:** After adding the `cache` parameter to `registerVerifyCitationTool`, existing tests in `verify-citation.test.ts` break because they don't pass a cache argument.
**Why it happens:** The function signature changes from 2 parameters to 3.
**How to avoid:** Update the `captureHandler()` test helper to create and pass a `CitationCache` instance. This is a straightforward mechanical change.
**Warning signs:** TypeScript compilation errors in test file after modifying the tool registration function.

### Pitfall 5: Cache Size Too Large for Serverless
**What goes wrong:** Setting `max` to a very large number (e.g., 100,000) consumes significant memory in a serverless environment where function memory is limited.
**Why it happens:** Over-optimizing for cache hit rate without considering deployment constraints.
**How to avoid:** Use `max: 1000` as a sensible default. Each cache entry is a small JSON object (~500 bytes for a typical citation match), so 1000 entries is roughly 500KB -- well within any reasonable memory budget. This can be made configurable via `Config` if needed later.
**Warning signs:** Memory usage spikes in production. Serverless function OOM errors.

## Code Examples

### Complete CitationCache Implementation
```typescript
// src/cache/citation-cache.ts
import { LRUCache } from "lru-cache";
import type { CitationMatch } from "../clients/courtlistener.js";

export interface CachedLookup {
  matches: CitationMatch[];
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
}

export class CitationCache {
  private readonly cache: LRUCache<string, CachedLookup>;
  private hitCount = 0;
  private missCount = 0;

  constructor(maxEntries = 1000) {
    this.cache = new LRUCache<string, CachedLookup>({ max: maxEntries });
  }

  get(normalizedCitation: string): CachedLookup | undefined {
    const result = this.cache.get(normalizedCitation);
    if (result !== undefined) {
      this.hitCount++;
    } else {
      this.missCount++;
    }
    return result;
  }

  set(normalizedCitation: string, result: CachedLookup): void {
    this.cache.set(normalizedCitation, result);
  }

  stats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      hits: this.hitCount,
      misses: this.missCount,
    };
  }

  /** Clear the cache (for testing). */
  clear(): void {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }
}
```

### Cache Integration in verify-citation.ts
```typescript
// Modified handler showing cache check and store
async ({ citation }) => {
  // Step 1: Parse locally
  const parseResult = parseCitation(citation);
  if (!parseResult.ok) {
    return createToolResponse({ /* PARSE_ERROR -- unchanged */ });
  }

  const normalized = parseResult.citation.normalized;

  // Step 2: Check cache
  const cached = cache.get(normalized);
  if (cached) {
    // Reuse existing classification logic with cached matches
    return classifyMatches(cached.matches, citation, normalized);
  }

  // Step 3: API call (unchanged)
  const lookupResult = await client.lookupCitation(normalized);

  // Step 4: Cache on success
  if (lookupResult.status === "ok") {
    cache.set(normalized, { matches: lookupResult.matches });
  }

  // Step 5: Classify (unchanged)
  if (lookupResult.status === "rate_limited") { /* ... */ }
  if (lookupResult.status === "error") { /* ... */ }
  return classifyMatches(lookupResult.matches, citation, normalized);
}
```

### Test: Cache Hit Skips API Call
```typescript
// src/tools/__tests__/verify-citation.test.ts (new test)
it("serves second lookup from cache without API call", async () => {
  const { handler, lookupCitation } = captureHandler();
  lookupCitation.mockResolvedValue({
    status: "ok",
    matches: [/* verified match data */],
  });

  // First call: hits API
  await handler({ citation: "347 U.S. 483" });
  expect(lookupCitation).toHaveBeenCalledTimes(1);

  // Second call: served from cache
  await handler({ citation: "347 U.S. 483" });
  expect(lookupCitation).toHaveBeenCalledTimes(1); // Still 1 -- no second API call
});
```

### Test: Cache Lookup Under 50ms
```typescript
it("cache lookup completes in under 50ms", async () => {
  const { handler, lookupCitation } = captureHandler();
  lookupCitation.mockResolvedValue({
    status: "ok",
    matches: [/* verified match data */],
  });

  // Prime the cache
  await handler({ citation: "347 U.S. 483" });

  // Time the cached lookup
  const start = performance.now();
  await handler({ citation: "347 U.S. 483" });
  const elapsed = performance.now() - start;

  expect(elapsed).toBeLessThan(50);
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `lru-cache` v6-7 (class-based, CommonJS) | `lru-cache` v10-11 (TypeScript-native, ESM) | v10 (2023) | Named export `LRUCache`, ESM-first, pre-allocated backing store with `max` |
| TTL-based caching for API results | LRU-only for immutable data | Domain-specific | No TTL needed when data never changes. Simpler configuration, no stale data bugs. |
| `node-cache` / `memory-cache` | `lru-cache` | Ecosystem consolidation | `lru-cache` is the dominant choice for pure in-memory LRU in Node.js/TypeScript |

**Deprecated/outdated:**
- `lru-cache` v6 CommonJS API: v10+ uses `LRUCache` named export with TypeScript generics
- `lru-cache` `stale` option: replaced by `allowStale` in v7+

## Open Questions

1. **Should the cache size be configurable via environment variable?**
   - What we know: A default of `max: 1000` is reasonable (~500KB memory). Phase 6 deploys to Vercel Edge Functions which have memory constraints.
   - What's unclear: Whether the user wants cache size configurability now or later.
   - Recommendation: Use a hardcoded default of 1000 for now. If needed, add `CACHE_MAX_ENTRIES` to `Config` later. LOW risk -- easy to add.

2. **Should cache hits be logged?**
   - What we know: The project uses `pino` logger (via `src/logger.ts`). Cache stats (hits/misses) are available via `stats()`.
   - What's unclear: Whether debug-level logging per cache hit adds value or noise.
   - Recommendation: Log at `debug` level on cache hit (one line: `"Cache hit for citation"`). Do not log misses (they proceed to the API path which already has logging). Add cache stats to a future observability endpoint if needed.

## Sources

### Primary (HIGH confidence)
- [lru-cache GitHub](https://github.com/isaacs/node-lru-cache) -- v11.x API: `LRUCache` constructor with `max` option, `get()`/`set()` methods, TypeScript-native, zero dependencies
- [lru-cache npm](https://www.npmjs.com/package/lru-cache) -- v11.2.6 current version, weekly downloads confirm ecosystem dominance
- Existing codebase: `src/tools/verify-citation.ts`, `src/clients/courtlistener.ts`, `src/server.ts`, `src/types.ts` -- Phase 3 implementation provides exact integration points, function signatures, and response types

### Secondary (MEDIUM confidence)
- [npm-compare: lru-cache vs alternatives](https://npm-compare.com/lru-cache,memory-cache,node-cache,quick-lru) -- Ecosystem comparison confirming lru-cache as dominant choice

### Tertiary (LOW confidence)
- None. This domain is well-understood with high-confidence sources.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- `lru-cache` v11.x verified via npm, zero dependencies, TypeScript-native. No novel technology.
- Architecture: HIGH -- Cache-aside pattern is textbook. Integration point is clear (between parse and API call in tool handler). Follows existing singleton pattern from Phase 3.
- Pitfalls: HIGH -- All pitfalls derive from known codebase patterns (singleton requirement, normalized key, transient vs immutable responses).

**Research date:** 2026-02-13
**Valid until:** 2026-06-13 (domain is stable; lru-cache v11.x is stable; caching patterns are evergreen)
