# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Every legal citation returned by the system is verified against authoritative sources -- no hallucinated cases pass through.
**Current focus:** Phase 5 - Quote Verification (IN PROGRESS)

## Current Position

Phase: 5 of 6 (Quote Verification)
Plan: 1 of 2 in current phase
Status: Plan 05-01 Complete
Last activity: 2026-02-13 -- Completed 05-01-PLAN.md

Progress: [███████░░░] 70%

## Performance Metrics

**Velocity:**
- Total plans completed: 7
- Average duration: 3.6min
- Total execution time: 0.42 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-mcp-server-foundation | 2/2 | 7min | 3.5min |
| 02-citation-parsing | 1/1 | 4min | 4min |
| 03-citation-verification-error-handling | 2/2 | 7min | 3.5min |
| 04-caching | 1/1 | 3min | 3min |
| 05-quote-verification | 1/2 | 4min | 4min |

**Recent Trend:**
- Last 5 plans: 02-01 (4min), 03-01 (4min), 03-02 (3min), 04-01 (3min), 05-01 (4min)
- Trend: stable

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: CourtListener is sole data source (CAP API shut down Sept 2024)
- [Roadmap]: Streamable HTTP primary transport, SSE as fallback only (SSE deprecated March 2025)
- [Roadmap]: Citation parsing is local normalization only; CourtListener citation-lookup handles server-side Eyecite parsing
- [01-01]: Stateless transport (sessionIdGenerator: undefined) for serverless-ready design
- [01-01]: Express bundled from SDK dependency, not installed separately
- [01-01]: Zod v3.25 (not v4) for simpler imports and SDK compatibility
- [01-02]: SDK returns SSE format for Streamable HTTP POST responses; Accept header must include both application/json and text/event-stream
- [01-02]: Stateless mode allows tool calls without prior initialize request
- [01-02]: SDK rejects batch requests containing initialize + other messages
- [02-01]: Iterative page-candidate regex strategy instead of single greedy/lazy regex for correct series suffix and pin cite handling
- [02-01]: Pure parser module (src/parser/) with zero MCP SDK dependency, bridged by src/tools/parse-citation.ts
- [03-01]: ExecutionPolicy interface instead of cockatiel IPolicy for simpler test mocking
- [03-01]: TimeoutStrategy.Aggressive for cockatiel timeout (cancels via AbortSignal)
- [03-01]: 4500 default tokens (90% of CourtListener 5000/hr limit) as safety margin
- [03-02]: Module-level singleton client in server.ts (not per-McpServer) to preserve rate limiter and circuit breaker state across stateless requests
- [03-02]: createServer() now requires Config parameter -- transport.ts accepts optional Config and falls back to loadConfig()
- [04-01]: No TTL on cache entries -- citations are immutable legal records that never change
- [04-01]: Only cache ok responses -- rate_limited and error are transient and must be retried
- [04-01]: classifyMatches helper extracted to share match classification between fresh and cached paths
- [05-01]: Named imports for fuzzball (CJS module with no default export in ESM context)
- [05-01]: Sliding window with refinement pass for excerpt extraction instead of full O(n*m) scan
- [05-01]: Paragraph chunking for texts >50K chars to keep fuzzy matching performant

### Pending Todos

None yet.

### Blockers/Concerns

- CourtListener rate limits (5,000/day free, 5,000/hour auth) may constrain testing; contact Free Law Project for production quota
- Quote verification fuzzy matching thresholds need experimentation in Phase 5

## Session Continuity

Last session: 2026-02-13
Stopped at: Completed 05-01-PLAN.md
Resume file: None
