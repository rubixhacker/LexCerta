---
phase: 03-citation-verification-error-handling
plan: 01
subsystem: api
tags: [cockatiel, circuit-breaker, rate-limiter, courtlistener, resilience, token-bucket]

# Dependency graph
requires:
  - phase: 01-mcp-server-foundation
    provides: logger module, project structure, vitest + biome tooling
provides:
  - TokenBucketRateLimiter class for request throttling
  - Cockatiel circuit breaker + retry + timeout composed policy
  - RateLimitError and ApiError error types for response classification
  - CourtListenerClient with three-state response (ok, rate_limited, error)
  - ExecutionPolicy interface for testable policy injection
affects: [03-02-PLAN, verify-citation tool, server.ts wiring]

# Tech tracking
tech-stack:
  added: [cockatiel ^3.2.1]
  patterns: [token-bucket rate limiting, composed resilience policies, discriminated union responses, policy injection via interface]

key-files:
  created:
    - src/resilience/rate-limiter.ts
    - src/resilience/circuit-breaker.ts
    - src/clients/courtlistener.ts
    - src/resilience/__tests__/rate-limiter.test.ts
    - src/clients/__tests__/courtlistener.test.ts
  modified:
    - package.json

key-decisions:
  - "ExecutionPolicy interface instead of cockatiel IPolicy for simpler test mocking"
  - "TimeoutStrategy.Aggressive for cockatiel timeout (cancels via AbortSignal)"
  - "4500 default tokens (90% of CourtListener 5000/hr limit) as safety margin"

patterns-established:
  - "Rate limiter checked before policy.execute() to avoid consuming tokens on circuit-breaker-rejected requests"
  - "Discriminated union LookupResponse with status field for type-safe response handling"
  - "Error types (RateLimitError, ApiError) co-located in circuit-breaker.ts for single import"

# Metrics
duration: 4min
completed: 2026-02-13
---

# Phase 3 Plan 1: CourtListener Client with Resilience Summary

**Token bucket rate limiter + cockatiel circuit breaker/retry/timeout + CourtListener HTTP client returning discriminated ok/rate_limited/error responses**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-13T15:30:35Z
- **Completed:** 2026-02-13T15:34:17Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Token bucket rate limiter with configurable capacity (4500 default) and proportional time-based refill
- Cockatiel composed policy: retry (2 attempts, exponential backoff) wrapping circuit breaker (5 consecutive 5xx to open, 30s half-open) wrapping timeout (5s aggressive)
- CourtListener API client that checks rate limiter before policy execution, correctly classifies 429 as rate_limited (not error), and maps 5xx to circuit breaker failures
- 16 total tests (9 rate limiter + 7 client) covering all response paths

## Task Commits

Each task was committed atomically:

1. **Task 1: Install cockatiel and create resilience modules** - `d7e9747` (feat)
2. **Task 2: CourtListener API client with injected resilience** - `a9cb346` (feat)

## Files Created/Modified
- `src/resilience/rate-limiter.ts` - TokenBucketRateLimiter class with tryConsume, msUntilNextToken, remaining
- `src/resilience/circuit-breaker.ts` - Cockatiel composed policy, RateLimitError, ApiError, breaker event logging
- `src/clients/courtlistener.ts` - CourtListenerClient with ExecutionPolicy injection and LookupResponse union
- `src/resilience/__tests__/rate-limiter.test.ts` - 9 tests: consume, exhaust, refill, cap, multi-consume
- `src/clients/__tests__/courtlistener.test.ts` - 7 tests: rate limit deny, 200 ok, 429, 500, headers, circuit open, 429 no header
- `package.json` - Added cockatiel dependency

## Decisions Made
- Used custom `ExecutionPolicy` interface instead of cockatiel's `IPolicy` directly -- IPolicy's complex generic signature made test mocking difficult; the custom interface is simpler and still type-compatible with cockatiel at runtime
- Added `TimeoutStrategy.Aggressive` to cockatiel timeout call -- the plan's `timeout(5_000)` signature requires two arguments in cockatiel v3.2.1; Aggressive strategy cancels via AbortSignal which is correct for fetch
- Error types (RateLimitError, ApiError) placed in circuit-breaker.ts rather than courtlistener.ts -- they are part of the resilience classification layer and needed by both modules

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Cockatiel timeout() requires TimeoutStrategy argument**
- **Found during:** Task 1 (circuit breaker module)
- **Issue:** `timeout(5_000)` fails TypeScript compilation; cockatiel v3.2.1 requires a second TimeoutStrategy parameter
- **Fix:** Changed to `timeout(5_000, TimeoutStrategy.Aggressive)` and added TimeoutStrategy import
- **Files modified:** src/resilience/circuit-breaker.ts
- **Verification:** `npx tsc --noEmit` passes
- **Committed in:** a9cb346

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minimal -- single API signature difference from research docs. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CourtListenerClient ready for injection into verify_west_citation MCP tool (03-02-PLAN)
- Rate limiter and circuit breaker are module-level exports, ready to be instantiated as singletons in server.ts
- All existing tests (77 total) continue to pass

---
*Phase: 03-citation-verification-error-handling*
*Completed: 2026-02-13*
