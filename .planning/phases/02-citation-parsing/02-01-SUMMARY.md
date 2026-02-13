---
phase: 02-citation-parsing
plan: 01
subsystem: parser
tags: [regex, citation-parsing, bluebook, west-reporters, mcp-tool, tdd]

# Dependency graph
requires:
  - phase: 01-mcp-server-foundation
    provides: MCP server, tool registration pattern, createToolResponse envelope, Streamable HTTP transport
provides:
  - parseCitation() function with ~30 West Reporter normalization
  - normalizeReporter() lookup table
  - ParsedCitation, CitationParseError, ParseResult types
  - parse_citation MCP tool callable over Streamable HTTP
affects: [03-courtlistener-integration, citation-verification]

# Tech tracking
tech-stack:
  added: []
  patterns: [iterative-page-candidate regex strategy, pure parser module separated from MCP tool]

key-files:
  created:
    - src/parser/types.ts
    - src/parser/reporters.ts
    - src/parser/index.ts
    - src/tools/parse-citation.ts
    - src/__tests__/parser.test.ts
    - src/__tests__/parse-citation.test.ts
  modified:
    - src/server.ts

key-decisions:
  - "Iterative page-candidate regex strategy instead of single greedy/lazy regex to handle series suffixes (2d, 3d, 4th) and pin cites correctly"
  - "Pure parser module (src/parser/) with zero MCP SDK dependency, bridged by src/tools/parse-citation.ts"

patterns-established:
  - "Parser module pattern: pure functions in src/parser/, MCP tool wrapper in src/tools/"
  - "Reporter normalization: lowercase + strip periods + collapse whitespace -> lookup in static table"

# Metrics
duration: 4min
completed: 2026-02-13
---

# Phase 2 Plan 1: Citation Parser Summary

**Regex-based citation parser with ~30 West Reporter normalizations, TDD red-green cycle, and parse_citation MCP tool**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-13T15:01:37Z
- **Completed:** 2026-02-13T15:05:54Z
- **Tasks:** 3 (+ 1 deviation fix)
- **Files modified:** 9

## Accomplishments
- parseCitation() parses "volume reporter page" citations and normalizes ~30 West Reporter abbreviations to canonical Bluebook forms
- Variant handling: case-insensitive, period-stripping, spacing normalization (e.g., "123 S Ct 456" -> "S. Ct.")
- Pin cite and parenthetical tolerance ("347 U.S. 483, 490" and "347 U.S. 483 (1954)" both parse correctly)
- parse_citation MCP tool registered and callable over Streamable HTTP with ToolResponseEnvelope
- 61 total tests pass (41 parser unit + 3 tool integration + 17 Phase 1 tests), zero regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: RED -- Write failing tests for citation parser** - `cfe7cb9` (test)
2. **Task 2: GREEN -- Implement citation parser to pass all tests** - `87dea3e` (feat)
3. **Task 3: Wire parse_citation MCP tool and integration test** - `6b1416b` (feat)
4. **Deviation: Fix pre-existing TypeScript error** - `a0d8813` (fix)

## Files Created/Modified
- `src/parser/types.ts` - ParsedCitation, CitationParseError, ParseResult type definitions
- `src/parser/reporters.ts` - REPORTER_MAP lookup table and normalizeReporter() function
- `src/parser/index.ts` - parseCitation() main function with iterative page-candidate strategy
- `src/tools/parse-citation.ts` - MCP tool registration following echo.ts pattern
- `src/__tests__/parser.test.ts` - 41 unit tests covering all success criteria
- `src/__tests__/parse-citation.test.ts` - 3 integration tests via Streamable HTTP
- `src/server.ts` - Updated to register parse_citation tool

## Decisions Made
- Used iterative page-candidate regex strategy instead of single greedy/lazy regex. The greedy `.+` approach captures the LAST number as the page, which fails with pin cites like "347 U.S. 483, 490" (captures 490 instead of 483). The iterative approach tries each standalone number left-to-right and accepts the first where the reporter text normalizes successfully.
- Reporter lookup table uses lowercase, period-stripped, whitespace-collapsed keys. The canonical Bluebook form is stored as the value and returned verbatim (never constructed from rules).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Global regex lastIndex state caused intermittent test failures**
- **Found during:** Task 2 (GREEN implementation)
- **Issue:** Module-level `const PAGE_CANDIDATES = /\b(\d+)\b/g` retains lastIndex between calls to matchCitation(), causing 16 of 41 tests to fail on second+ invocations
- **Fix:** Create the regex locally inside matchCitation() to reset lastIndex on each call
- **Files modified:** src/parser/index.ts
- **Verification:** All 41 tests pass consistently
- **Committed in:** 87dea3e (Task 2 commit)

**2. [Rule 1 - Bug] Fixed pre-existing TypeScript error in transport test**
- **Found during:** Task 3 verification step
- **Issue:** `res.body?.getReader()` returns possibly undefined, causing `tsc --noEmit` to fail
- **Fix:** Changed to `res.body!.getReader()` (non-null assertion appropriate in test context where body is expected)
- **Files modified:** src/__tests__/transport.test.ts
- **Verification:** `npx tsc --noEmit` passes cleanly
- **Committed in:** a0d8813 (separate fix commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered
- The plan's recommended regex approach (`/^(\d+)\s+(.+)\s+(\d+)/` with greedy middle) fails on pin cites because the greedy match captures the last number in the string (490 in "347 U.S. 483, 490") instead of the first page number (483). Solved with iterative page-candidate strategy that tries each standalone number left-to-right.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- parseCitation() is ready for use by Phase 3 CourtListener integration
- ParsedCitation type provides volume/reporter/page fields needed for CourtListener citation-lookup API queries
- Reporter normalization ensures consistent lookup keys regardless of input formatting

---
*Phase: 02-citation-parsing*
*Completed: 2026-02-13*
