---
phase: 03-citation-verification-error-handling
plan: 02
subsystem: api
tags: [mcp-tool, citation-verification, hallucination-detection, courtlistener, singleton-client]

# Dependency graph
requires:
  - phase: 03-citation-verification-error-handling
    provides: CourtListenerClient, TokenBucketRateLimiter, circuit breaker policy, LookupResponse types
  - phase: 02-citation-parsing
    provides: parseCitation function for local citation normalization
  - phase: 01-mcp-server-foundation
    provides: MCP server, transport, ToolResponseEnvelope, Config type
provides:
  - verify_west_citation MCP tool with four-state classification (verified, not_found, rate_limited, error)
  - Module-level singleton CourtListenerClient persisting across stateless requests
  - VerificationStatus type for downstream consumers
  - registerVerifyCitationTool function for server wiring
affects: [04-batch-verification, 05-quote-verification, integration-tests]

# Tech tracking
tech-stack:
  added: []
  patterns: [singleton client pattern for stateless transport, parse-then-lookup pipeline, four-state verification classification]

key-files:
  created:
    - src/tools/verify-citation.ts
    - src/tools/__tests__/verify-citation.test.ts
  modified:
    - src/types.ts
    - src/server.ts
    - src/transport.ts
    - src/index.ts
    - src/__tests__/transport.test.ts

key-decisions:
  - "Module-level singleton client in server.ts (not per-McpServer) to preserve rate limiter and circuit breaker state across stateless requests"
  - "createServer() now requires Config parameter -- transport.ts accepts optional Config and falls back to loadConfig()"

patterns-established:
  - "Four-state verification: verified/not_found/rate_limited/error -- each maps to distinct error code"
  - "HALLUCINATION_DETECTED error code for not-found citations; API_ERROR explicitly states 'NOT a citation verification failure'"
  - "Parse short-circuit: PARSE_ERROR returned before any network call when input is unparseable"
  - "Mock server pattern: capture handler via registerTool mock for unit testing without real McpServer"

# Metrics
duration: 3min
completed: 2026-02-13
---

# Phase 3 Plan 2: verify_west_citation MCP Tool Summary

**verify_west_citation MCP tool with parse-then-lookup pipeline, four-state classification (verified/not_found/rate_limited/error), and singleton CourtListenerClient wired into server**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-13T15:36:37Z
- **Completed:** 2026-02-13T15:39:35Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- verify_west_citation tool correctly classifies all four verification states with distinct error codes
- HALLUCINATION_DETECTED error code unambiguously identifies fabricated citations, while API_ERROR explicitly states "NOT a citation verification failure"
- Parser errors short-circuit before any API call, saving rate limit tokens
- Module-level singleton CourtListenerClient persists across stateless transport requests, preserving circuit breaker and rate limiter state
- 6 new tests covering all classification paths; 83 total tests passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Add verification types and create verify_west_citation tool** - `561a011` (feat)
2. **Task 2: Wire verify_west_citation into MCP server with singleton client** - `f8aa5ad` (feat)

## Files Created/Modified
- `src/tools/verify-citation.ts` - verify_west_citation tool with parse -> lookup -> classify pipeline
- `src/tools/__tests__/verify-citation.test.ts` - 6 tests: parse error, rate limited, API error, hallucination, verified, empty matches
- `src/types.ts` - Added VerificationStatus type
- `src/server.ts` - Singleton client pattern, createServer(config), registerVerifyCitationTool wiring
- `src/transport.ts` - Accepts optional Config param, passes to createServer
- `src/index.ts` - Passes loaded config to createApp
- `src/__tests__/transport.test.ts` - Added resetClient cleanup and lint fix

## Decisions Made
- Module-level singleton pattern for CourtListenerClient in server.ts rather than per-request instantiation -- stateless transport creates new McpServer per request but rate limiter and circuit breaker must share state
- createServer() signature changed to require Config parameter -- cleaner dependency injection vs reading env vars inside server module
- createApp() accepts optional Config, defaulting to loadConfig() -- allows tests to pass config directly while production code uses env

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed biome formatting in verify-citation.ts**
- **Found during:** Task 2 (lint verification)
- **Issue:** Multi-line function signature and string wrapping did not match biome's formatter expectations
- **Fix:** Ran `biome check --write` to auto-format
- **Files modified:** src/tools/verify-citation.ts
- **Verification:** `npm run lint` passes
- **Committed in:** f8aa5ad

**2. [Rule 1 - Bug] Fixed pre-existing lint warning in transport.test.ts**
- **Found during:** Task 2 (lint verification)
- **Issue:** `res.body!.getReader()` non-null assertion flagged by biome lint/style/noNonNullAssertion
- **Fix:** Added biome-ignore comment with justification (body is guaranteed after successful SSE response)
- **Files modified:** src/__tests__/transport.test.ts
- **Verification:** `npm run lint` passes
- **Committed in:** f8aa5ad

---

**Total deviations:** 2 auto-fixed (2 bugs/lint)
**Impact on plan:** Minimal formatting fixes. No scope creep.

## Issues Encountered
None.

## User Setup Required
None for this plan. CourtListener API key requirement was established in 03-01 and is enforced by ConfigSchema in config.ts.

## Next Phase Readiness
- Phase 3 is now complete: CourtListener client (03-01) + verify_west_citation tool (03-02) deliver the core verification pipeline
- All 83 tests pass across 8 test files
- Ready for Phase 4 (batch verification) or Phase 5 (quote verification)
- The singleton client pattern ensures rate limiter state is preserved for batch operations

---
*Phase: 03-citation-verification-error-handling*
*Completed: 2026-02-13*
