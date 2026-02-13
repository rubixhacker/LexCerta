---
phase: 07-nextjs-migration
plan: 01
subsystem: infra
tags: [nextjs, react, app-router, mcp, vercel, bundler]

# Dependency graph
requires:
  - phase: 06-deploy
    provides: "Vercel serverless MCP endpoint at api/server.ts"
provides:
  - "Next.js App Router project structure"
  - "MCP route handler at app/api/mcp/[transport]/route.ts"
  - "Bundler module resolution for all src/ imports"
  - "Simplified vercel.json without rewrites"
affects: [07-02, 08-supabase, 09-dashboard, 10-auth, 11-billing]

# Tech tracking
tech-stack:
  added: [next@15.5.12, react@19, react-dom@19, "@types/react@19", "@types/react-dom@19"]
  patterns: [app-router-convention, path-alias-imports, bundler-module-resolution]

key-files:
  created:
    - app/layout.tsx
    - app/page.tsx
    - app/api/mcp/[transport]/route.ts
    - next.config.ts
  modified:
    - package.json
    - tsconfig.json
    - vercel.json
    - .gitignore
    - src/**/*.ts (removed .js extensions from imports)

key-decisions:
  - "Removed .js extensions from all relative imports in src/ for webpack bundler compatibility"
  - "Used @/ path alias for route handler imports to src/"
  - "Kept type: module in package.json (no build issues)"

patterns-established:
  - "App Router convention: app/api/[...]/route.ts for API endpoints"
  - "Path alias @/* maps to ./src/* for clean imports"
  - "Biome lint scope includes both src/ and app/"

# Metrics
duration: 3min
completed: 2026-02-13
---

# Phase 7 Plan 1: Next.js Migration Summary

**Next.js 15 App Router with MCP endpoint at /api/mcp/[transport], bundler module resolution, all 248 tests passing**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-13T20:28:57Z
- **Completed:** 2026-02-13T20:32:23Z
- **Tasks:** 3
- **Files modified:** 35

## Accomplishments
- Converted standalone Vercel serverless function to Next.js App Router application
- MCP endpoint moved from api/server.ts to app/api/mcp/[transport]/route.ts with correct basePath
- All 248 existing tests pass with zero modifications to test files
- Next.js build succeeds with static home page and dynamic MCP route

## Task Commits

Each task was committed atomically:

1. **Task 1: Install Next.js dependencies and update configuration files** - `aa4f178` (chore)
2. **Task 2: Create App Router structure and MCP route handler** - `7c98bba` (feat)
3. **Task 3: Remove old api/ directory, verify build and tests pass** - `f466e51` (feat)

## Files Created/Modified
- `app/layout.tsx` - Root layout (required by Next.js App Router)
- `app/page.tsx` - Placeholder home page with LexCerta branding
- `app/api/mcp/[transport]/route.ts` - MCP server route handler (exports GET, POST, DELETE)
- `next.config.ts` - Minimal Next.js configuration
- `package.json` - Next.js/React deps, updated scripts (dev/build/start use Next.js)
- `tsconfig.json` - Bundler module resolution, JSX preserve, path aliases, app/ in include
- `vercel.json` - Simplified to only function duration config (no rewrites, no buildCommand)
- `.gitignore` - Added .next and next-env.d.ts
- `src/**/*.ts` - Removed .js extensions from all relative imports (29 files)

## Decisions Made
- Removed .js extensions from all relative imports in src/ -- Next.js webpack requires this under bundler module resolution (the extensions caused "Module not found" errors)
- Used @/ path alias for route handler imports -- cleaner than relative paths from deeply nested app/api/mcp/[transport]/
- Kept "type": "module" in package.json -- no build issues observed (plan said to remove only if needed)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed .js extensions from all relative imports in src/**
- **Found during:** Task 3 (next build)
- **Issue:** Next.js webpack with bundler moduleResolution cannot resolve `.js` extensions on TypeScript files. Build failed with "Module not found" for every relative import using `.js` suffix.
- **Fix:** Batch-removed `.js` extensions from all relative imports across 29 files in src/
- **Files modified:** All .ts files in src/ with relative imports
- **Verification:** `npx next build` succeeds, all 248 tests still pass
- **Committed in:** f466e51 (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential fix for bundler compatibility. Plan anticipated this possibility. No scope creep.

## Issues Encountered
- Next.js workspace root warning about multiple lockfiles (parent directory has a package-lock.json). This is cosmetic and does not affect the build. Can be silenced with `outputFileTracingRoot` if needed.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Next.js App Router foundation complete
- Ready for plan 07-02 (environment variables, middleware, deployment verification)
- All existing MCP functionality preserved and accessible at /api/mcp/[transport]

---
*Phase: 07-nextjs-migration*
*Completed: 2026-02-13*
