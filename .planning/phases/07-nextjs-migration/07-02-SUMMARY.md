---
phase: 07-nextjs-migration
plan: 02
subsystem: infra
tags: [vercel, deployment, mcp, nextjs, streamable-http]

# Dependency graph
requires:
  - phase: 07-nextjs-migration
    provides: "Next.js App Router project with MCP route handler at app/api/mcp/[transport]/route.ts"
provides:
  - "Verified Vercel production deployment of Next.js MCP server"
  - "MCP Streamable HTTP transport at /api/mcp/mcp"
  - "MCP SSE transport at /api/mcp/sse"
  - "All three tools (parse_citation, verify_west_citation, verify_quote_integrity) confirmed working at new endpoint"
affects: [08-supabase, 09-api-keys, 10-metering, 11-billing, 12-dashboard]

# Tech tracking
tech-stack:
  added: []
  patterns: [vercel-nextjs-deployment, mjs-config-for-vercel-compat]

key-files:
  created: []
  modified:
    - package.json
    - next.config.mjs (renamed from next.config.ts)

key-decisions:
  - "Removed type:module from package.json -- caused Vercel build failures despite working locally"
  - "Converted next.config.ts to next.config.mjs for universal Vercel ESM compatibility"

patterns-established:
  - "Use .mjs config files for Vercel compatibility instead of .ts"
  - "Vercel production branch is main; push master:main to trigger deploys"

requirements-completed: [INFRA-01, INFRA-03]

# Metrics
duration: 10min
completed: 2026-02-20
---

# Phase 7 Plan 2: Vercel Deployment Verification Summary

**Next.js MCP server deployed to Vercel with all three tools (parse, verify, quote) confirmed working at /api/mcp/mcp via Streamable HTTP**

## Performance

- **Duration:** ~10 min (automated work; human verification pause excluded)
- **Started:** 2026-02-20T20:20:26Z
- **Completed:** 2026-02-20T23:42:08Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Fixed Vercel build failure caused by `"type": "module"` in package.json and `.ts` config format
- Successfully deployed Next.js App Router to Vercel production
- Verified all three MCP tools return correct results at the new /api/mcp/mcp endpoint
- Confirmed Streamable HTTP and SSE transports both functional
- Human-verified MCP client connectivity with identical results to v1.0

## Task Commits

Each task was committed atomically:

1. **Task 1: Deploy to Vercel and verify endpoint responds** - `709c0cb` (fix)
2. **Task 2: Verify MCP tools work via client** - Human verification (no code changes)

## Files Created/Modified
- `package.json` - Removed `"type": "module"` for Vercel build compatibility
- `next.config.mjs` - New ESM config (replaces next.config.ts)
- `next.config.ts` - Deleted (replaced by .mjs)

## Decisions Made
- Removed `"type": "module"` from package.json -- the field was causing Vercel's Next.js build to fail even though `next build` succeeded locally on Node 25. Vercel's build environment (Node 20) could not resolve ESM modules correctly with this setting.
- Converted `next.config.ts` to `next.config.mjs` -- TypeScript config files require Next.js 15.1+ with specific Node version support. The `.mjs` extension provides universal ESM config support across all Vercel build environments.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Vercel build failure by removing type:module and converting config format**
- **Found during:** Task 1 (Deploy to Vercel)
- **Issue:** Vercel deployment failed on commits from plan 07-01. The production deployment at `lexcerta.vercel.app` was still serving the old v1.0 code. Root cause: `"type": "module"` in package.json combined with `next.config.ts` caused Vercel's build pipeline to fail.
- **Fix:** Removed `"type": "module"` from package.json, converted `next.config.ts` to `next.config.mjs`
- **Files modified:** package.json, next.config.mjs (new), next.config.ts (deleted)
- **Verification:** Local `next build` succeeds, all 248 tests pass, Vercel deployment succeeds
- **Committed in:** 709c0cb

**2. [Rule 3 - Blocking] Vercel GitHub integration not auto-triggering deployments**
- **Found during:** Task 1 (Deploy to Vercel)
- **Issue:** After pushing the fix to both origin/master and origin/main, Vercel did not auto-deploy. The integration had stopped triggering after 4 consecutive build failures from plan 07-01.
- **Fix:** Required human intervention -- user manually triggered redeploy from Vercel dashboard
- **Resolution:** Deployment succeeded after manual trigger

---

**Total deviations:** 2 (1 auto-fixed bug, 1 required human action for Vercel integration)
**Impact on plan:** Both issues were deployment-environment specific. The build failure was anticipated by the plan as a possible issue. No scope creep.

## Issues Encountered
- Vercel deployment had been failing silently since plan 07-01 completion (Feb 13). The old v1.0 deployment was still being served. This was discovered by checking the GitHub deployment API status, which showed `state: failure` for all recent deployments.
- The Vercel GitHub integration stopped auto-deploying after consecutive failures. Required manual redeploy from the Vercel dashboard.

## User Setup Required
None - deployment is now working on Vercel with existing configuration.

## Next Phase Readiness
- Phase 7 (Next.js Migration) is fully complete
- All four success criteria met:
  1. Project builds and deploys as Next.js App Router on Vercel
  2. MCP clients get identical results at /api/mcp endpoint
  3. Streamable HTTP transport works (SSE backward compat available)
  4. Top-level /api directory removed; routes under app/api/
- Ready for Phase 8 (Supabase Backend & Auth)
- COURTLISTENER_API_KEY environment variable confirmed set in Vercel project settings

---
*Phase: 07-nextjs-migration*
*Completed: 2026-02-20*

## Self-Check: PASSED
- FOUND: 07-02-SUMMARY.md
- FOUND: commit 709c0cb
