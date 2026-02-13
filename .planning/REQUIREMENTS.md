# Requirements: LexCerta

**Defined:** 2026-02-13
**Core Value:** Every legal citation returned by the system is verified against authoritative sources — no hallucinated cases pass through.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### MCP Server Foundation

- [ ] **MCP-01**: MCP server starts and accepts tool calls via Streamable HTTP transport
- [ ] **MCP-02**: MCP server supports SSE fallback for backward compatibility with older clients
- [ ] **MCP-03**: Server validates all tool inputs using Zod schemas before processing
- [ ] **MCP-04**: Server returns structured JSON responses with consistent envelope format (valid, metadata, error)
- [ ] **MCP-05**: All logging routes to stderr (stdout reserved for MCP protocol transport)

### Citation Parsing

- [ ] **PARSE-01**: User can submit a citation string and receive a parsed, normalized citation object
- [ ] **PARSE-02**: Parser normalizes common West Reporter format variants (e.g., "123 S. Ct 456" → "123 S. Ct. 456", "US" → "U.S.")
- [ ] **PARSE-03**: Parser handles full-form West Reporter citations (volume + reporter + page)
- [ ] **PARSE-04**: Parser rejects unparseable input with a clear error message

### Citation Verification

- [ ] **VERIFY-01**: User can verify a West Reporter citation exists via `verify_west_citation` MCP tool
- [ ] **VERIFY-02**: Verified citations return case name, court, date, and reporter metadata
- [ ] **VERIFY-03**: Unverifiable citations return a hard "Hallucination Detected" error with details
- [ ] **VERIFY-04**: Verification uses CourtListener citation-lookup API as primary source
- [ ] **VERIFY-05**: Verification respects CourtListener API rate limits with request tracking

### Quote Verification

- [ ] **QUOTE-01**: User can verify a quoted passage appears in a cited opinion via `verify_quote_integrity` MCP tool
- [ ] **QUOTE-02**: Quote verification returns a match score (0-100%)
- [ ] **QUOTE-03**: Quote verification returns the actual text from the opinion for comparison
- [ ] **QUOTE-04**: Quote verification first confirms the citation exists before fetching full text
- [ ] **QUOTE-05**: Quote verification uses fuzzy string matching to handle minor formatting differences

### Caching

- [ ] **CACHE-01**: Verified citation results are cached to avoid redundant API calls
- [ ] **CACHE-02**: Cache lookups complete in under 50ms
- [ ] **CACHE-03**: Citations are immutable data — cached results never expire (no invalidation needed)

### Configuration & Deployment

- [ ] **DEPLOY-01**: Server deploys to Vercel as a Serverless Function via `mcp-handler`
- [ ] **DEPLOY-02**: API keys (COURTLISTENER_API_KEY) are managed via environment variables
- [ ] **DEPLOY-03**: Server configuration is validated at startup via Zod schema

### Error Handling

- [ ] **ERR-01**: API failures (429, 5xx) are distinguished from "citation not found" in responses
- [ ] **ERR-02**: Circuit breaker prevents cascading failures when CourtListener API is degraded
- [ ] **ERR-03**: Rate limit exhaustion returns an explicit "rate_limited" status, not a false "not found"

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Batch Verification

- **BATCH-01**: User can submit a block of text and get all citations verified in one call
- **BATCH-02**: Batch verification deduplicates citations before making API calls
- **BATCH-03**: Batch verification returns citation start/end positions in the source text

### Advanced Features

- **ADV-01**: Verification returns tiered confidence scores (parsed_only, existence_verified, quote_verified)
- **ADV-02**: Short-form citations (Id., supra) resolved using document context
- **ADV-03**: Parallel citation resolution (e.g., both state and regional reporter forms)
- **ADV-04**: Pre-populated cache with top 1,000 most-cited cases for instant verification

### Persistent Storage

- **STORE-01**: Verification results stored in Supabase for persistent cache across deployments
- **STORE-02**: Reporter-to-date-range mapping stored as structured data for disambiguation

## Out of Scope

| Feature | Reason |
|---------|--------|
| Good Law / KeyCite status checking | Requires paid Westlaw API access; partial coverage is worse than no coverage |
| Statute and regulation verification | Different data sources, parsing rules, and pipelines; separate MCP server |
| AI-powered citation suggestion | Turns verification tool into generative tool; recursive hallucination risk |
| Web UI / dashboard | Target user is AI agents, not humans; humans have Clearbrief/CiteCheck AI |
| Full Bluebook formatting enforcement | Hundreds of rules; separate product territory (BriefCatch) |
| Real-time document monitoring | Different architecture (persistent connection); agent's responsibility |
| CAP API integration | API shut down September 2024; CourtListener has all CAP data |
| SSE-only transport | Deprecated in MCP spec March 2025; use Streamable HTTP |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| MCP-01 | Phase 1 | Pending |
| MCP-02 | Phase 1 | Pending |
| MCP-03 | Phase 1 | Pending |
| MCP-04 | Phase 1 | Pending |
| MCP-05 | Phase 1 | Pending |
| PARSE-01 | Phase 2 | Pending |
| PARSE-02 | Phase 2 | Pending |
| PARSE-03 | Phase 2 | Pending |
| PARSE-04 | Phase 2 | Pending |
| VERIFY-01 | Phase 3 | Pending |
| VERIFY-02 | Phase 3 | Pending |
| VERIFY-03 | Phase 3 | Pending |
| VERIFY-04 | Phase 3 | Pending |
| VERIFY-05 | Phase 3 | Pending |
| QUOTE-01 | Phase 5 | Pending |
| QUOTE-02 | Phase 5 | Pending |
| QUOTE-03 | Phase 5 | Pending |
| QUOTE-04 | Phase 5 | Pending |
| QUOTE-05 | Phase 5 | Pending |
| CACHE-01 | Phase 4 | Pending |
| CACHE-02 | Phase 4 | Pending |
| CACHE-03 | Phase 4 | Pending |
| DEPLOY-01 | Phase 6 | Pending |
| DEPLOY-02 | Phase 1 | Pending |
| DEPLOY-03 | Phase 1 | Pending |
| ERR-01 | Phase 3 | Pending |
| ERR-02 | Phase 3 | Pending |
| ERR-03 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 28 total
- Mapped to phases: 28
- Unmapped: 0

---
*Requirements defined: 2026-02-13*
*Last updated: 2026-02-13 after roadmap creation*
