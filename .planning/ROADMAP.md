# Roadmap: LexCerta

## Overview

LexCerta delivers an MCP-native legal citation verification server that eliminates hallucinated citations from AI-generated legal text. The roadmap moves from a working MCP server shell, through citation parsing and existence verification (the core anti-hallucination value), to quote integrity verification (the competitive differentiator), and finally to production deployment on Vercel. Each phase delivers a testable, coherent capability that builds on the previous one.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: MCP Server Foundation** - Working MCP server with Streamable HTTP transport, input validation, and structured responses ✓ 2026-02-13
- [x] **Phase 2: Citation Parsing** - Parse and normalize West Reporter citations into structured objects ✓ 2026-02-13
- [ ] **Phase 3: Citation Verification** - Verify citation existence via CourtListener with resilient error handling
- [ ] **Phase 4: Caching** - In-memory cache layer for verified citations to stay within API rate limits
- [ ] **Phase 5: Quote Verification** - Verify quoted passages appear in cited opinions via fuzzy matching
- [ ] **Phase 6: Production Deployment** - Deploy to Vercel as an Edge Function accessible to remote AI agents

## Phase Details

### Phase 1: MCP Server Foundation
**Goal**: A running MCP server that accepts tool calls over Streamable HTTP, validates inputs, and returns structured JSON responses
**Depends on**: Nothing (first phase)
**Requirements**: MCP-01, MCP-02, MCP-03, MCP-04, MCP-05, DEPLOY-02, DEPLOY-03
**Success Criteria** (what must be TRUE):
  1. An MCP client can connect to the server via Streamable HTTP and receive a valid capabilities response
  2. An MCP client can connect via SSE fallback and receive a valid capabilities response
  3. A tool call with invalid input returns a Zod validation error before any processing occurs
  4. All tool responses use the same JSON envelope format (valid, metadata, error fields)
  5. Server refuses to start if required environment variables (COURTLISTENER_API_KEY) are missing
**Plans**: 2 plans

Plans:
- [x] 01-01-PLAN.md — Project scaffolding and MCP server with Streamable HTTP transport
- [x] 01-02-PLAN.md — SSE fallback, input validation tests, and integration test suite

### Phase 2: Citation Parsing
**Goal**: Users can submit citation strings and receive parsed, normalized citation objects with clear errors for bad input
**Depends on**: Phase 1
**Requirements**: PARSE-01, PARSE-02, PARSE-03, PARSE-04
**Success Criteria** (what must be TRUE):
  1. Calling `parse_citation` with "123 S. Ct. 456" returns a structured object with volume=123, reporter="S. Ct.", page=456
  2. Calling `parse_citation` with "123 S Ct 456" (missing periods) returns the same normalized result as "123 S. Ct. 456"
  3. Calling `parse_citation` with gibberish like "not a citation" returns a clear error message explaining why parsing failed
  4. All standard West Reporter abbreviations (U.S., S. Ct., F.2d, F.3d, etc.) are recognized and normalized
**Plans**: 1 plan

Plans:
- [x] 02-01-PLAN.md — TDD citation parser with reporter normalization and MCP tool registration

### Phase 3: Citation Verification & Error Handling
**Goal**: Users can verify whether a West Reporter citation refers to a real case, with unambiguous responses distinguishing real cases, hallucinated citations, API failures, and rate limits
**Depends on**: Phase 2
**Requirements**: VERIFY-01, VERIFY-02, VERIFY-03, VERIFY-04, VERIFY-05, ERR-01, ERR-02, ERR-03
**Success Criteria** (what must be TRUE):
  1. Calling `verify_west_citation` with a real citation (e.g., "347 U.S. 483") returns valid=true with case name, court, date, and reporter metadata
  2. Calling `verify_west_citation` with a fabricated citation returns valid=false with a "Hallucination Detected" error and details about why
  3. When CourtListener returns HTTP 429, the response status is "rate_limited" (not a false "not found")
  4. When CourtListener is down (5xx errors), a circuit breaker prevents cascading failures and the response distinguishes API failure from citation-not-found
  5. The server respects CourtListener API rate limits by tracking request counts
**Plans**: TBD

Plans:
- [ ] 03-01: CourtListener API client with rate limiting and circuit breaker
- [ ] 03-02: verify_west_citation tool with verification pipeline and error classification

### Phase 4: Caching
**Goal**: Verified citation results are cached in memory so repeated lookups are instant and API rate limits are preserved
**Depends on**: Phase 3
**Requirements**: CACHE-01, CACHE-02, CACHE-03
**Success Criteria** (what must be TRUE):
  1. Verifying the same citation twice results in only one CourtListener API call (second is served from cache)
  2. Cache lookups complete in under 50ms
  3. Cached citation results never expire or are invalidated (citations are immutable legal records)
**Plans**: TBD

Plans:
- [ ] 04-01: In-memory LRU cache integration into verification pipeline

### Phase 5: Quote Verification
**Goal**: Users can verify that a quoted passage actually appears in the cited court opinion, with fuzzy matching to handle minor formatting differences
**Depends on**: Phase 3
**Requirements**: QUOTE-01, QUOTE-02, QUOTE-03, QUOTE-04, QUOTE-05
**Success Criteria** (what must be TRUE):
  1. Calling `verify_quote_integrity` with a real citation and a verbatim quote from that opinion returns a high match score (90%+)
  2. Calling `verify_quote_integrity` with a real citation and a fabricated quote returns a low match score with the actual text from the opinion for comparison
  3. Calling `verify_quote_integrity` with a nonexistent citation returns a citation-not-found error before attempting quote matching
  4. Minor formatting differences (extra spaces, punctuation variants) between the submitted quote and opinion text do not cause false negatives
**Plans**: TBD

Plans:
- [ ] 05-01: CourtListener Opinions API client for full-text retrieval
- [ ] 05-02: verify_quote_integrity tool with fuzzy matching pipeline

### Phase 6: Production Deployment
**Goal**: LexCerta is deployed to Vercel and accessible to remote MCP clients over the internet
**Depends on**: Phase 1, Phase 5
**Requirements**: DEPLOY-01
**Success Criteria** (what must be TRUE):
  1. An MCP client can connect to LexCerta at a Vercel URL and successfully verify a citation
  2. The deployed server passes all the same verification and quote integrity checks as the local server
**Plans**: TBD

Plans:
- [ ] 06-01: Vercel Edge Function deployment with mcp-handler

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. MCP Server Foundation | 2/2 | ✓ Complete | 2026-02-13 |
| 2. Citation Parsing | 1/1 | ✓ Complete | 2026-02-13 |
| 3. Citation Verification & Error Handling | 0/2 | Not started | - |
| 4. Caching | 0/1 | Not started | - |
| 5. Quote Verification | 0/2 | Not started | - |
| 6. Production Deployment | 0/1 | Not started | - |
