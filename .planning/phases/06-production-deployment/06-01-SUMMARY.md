---
phase: 06-production-deployment
plan: 01
subsystem: infra
tags: [vercel, mcp-handler, serverless, deployment]

# Dependency graph
requires:
  - phase: 01-mcp-server-foundation
    provides: "McpServer with tool registration and transport layer"
  - phase: 05-quote-verification
    provides: "Complete tool suite (echo, parse_citation, verify_citation, verify_quote)"
provides:
  - "Vercel Functions entry point via mcp-handler for remote MCP access"
  - "registerTools() shared between local dev and Vercel entry points"
  - "vercel.json routing and function configuration"
affects: []

# Tech tracking
tech-stack:
  added: [mcp-handler]
  patterns: [shared-tool-registration, dual-entry-point]

key-files:
  created:
    - api/server.ts
    - vercel.json
  modified:
    - src/server.ts
    - package.json

key-decisions:
  - "Used --legacy-peer-deps for mcp-handler install due to strict peer dep on SDK 1.25.2 vs project's 1.26.0"
  - "loadConfig() called at module top-level in api/server.ts for fail-fast on missing env vars"
  - "Node.js runtime (not Edge) for compatibility with cockatiel, lru-cache, fuzzball"

patterns-established:
  - "Dual entry point: src/index.ts for local dev, api/server.ts for Vercel"
  - "registerTools() as shared registration function between entry points"

# Metrics
duration: 2min
completed: 2026-02-13
---

# Phase 6 Plan 1: Production Deployment Summary

**Vercel Functions entry point via mcp-handler with shared registerTools() for remote MCP access**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-13T17:36:22Z
- **Completed:** 2026-02-13T17:38:06Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Extracted registerTools(server, config) from createServer() for shared use between local and Vercel entry points
- Created api/server.ts as Vercel Functions handler using mcp-handler with all LexCerta tools registered
- Added vercel.json with path rewrites to /api/server and 60s maxDuration configuration
- All 124 existing tests pass unchanged after refactoring

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract registerTools() and create Vercel entry point** - `cf41382` (feat)
2. **Task 2: Verify deployment readiness** - verification-only (no code changes)

## Files Created/Modified
- `api/server.ts` - Vercel Functions entry point using mcp-handler, exports GET/POST/DELETE
- `vercel.json` - Vercel routing config with rewrites and maxDuration
- `src/server.ts` - Refactored to export registerTools() alongside createServer()
- `package.json` - Added mcp-handler@^1.0.7 dependency
- `package-lock.json` - Updated lockfile
- `src/clients/courtlistener.ts` - Pre-existing formatting cleanup (biome)
- `src/tools/verify-citation.ts` - Pre-existing formatting cleanup (biome)

## Decisions Made
- Used `--legacy-peer-deps` for mcp-handler install: mcp-handler@1.0.7 has strict peer dep on SDK 1.25.2 but project uses 1.26.0; minor version difference is compatible
- loadConfig() called at module top-level in api/server.ts: ensures Vercel Function fails fast with descriptive Zod error if COURTLISTENER_API_KEY is unset
- Node.js runtime (default, not Edge): required for cockatiel, lru-cache, fuzzball CJS compatibility

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] mcp-handler peer dependency conflict**
- **Found during:** Task 1 (npm install mcp-handler)
- **Issue:** mcp-handler@1.0.7 requires peer @modelcontextprotocol/sdk@1.25.2 but project has 1.26.0
- **Fix:** Installed with --legacy-peer-deps flag; SDK 1.26 is backward-compatible with 1.25.2 APIs
- **Files modified:** package.json, package-lock.json
- **Verification:** All 124 tests pass, tsc compiles clean
- **Committed in:** cf41382

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Peer dep resolution necessary for install. No scope creep.

## Issues Encountered
- Pre-existing formatting changes in courtlistener.ts and verify-citation.ts were found unstaged; included in Task 1 commit since they are biome format fixes with no behavioral impact.

## User Setup Required

Vercel deployment requires manual configuration:
- Connect GitHub repo to Vercel project (Dashboard -> New Project -> Import Git Repository)
- Set COURTLISTENER_API_KEY environment variable in Vercel Dashboard -> Project Settings -> Environment Variables

## Next Phase Readiness
- api/server.ts + vercel.json ready for `vercel deploy` or git-push deployment
- All tools registered and tested; deployment is the final step
- This is the final phase -- LexCerta is feature-complete

## Self-Check: PASSED

- FOUND: api/server.ts
- FOUND: vercel.json
- FOUND: src/server.ts
- FOUND: .planning/phases/06-production-deployment/06-01-SUMMARY.md
- FOUND: commit cf41382
- FOUND: registerTools export in src/server.ts
- FOUND: createServer export in src/server.ts
- FOUND: mcp-handler in package.json

---
*Phase: 06-production-deployment*
*Completed: 2026-02-13*
