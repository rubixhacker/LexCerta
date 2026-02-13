# Project Research Summary

**Project:** LexCerta - Legal Citation Verification MCP Server
**Domain:** Legal AI anti-hallucination tooling (West Reporter citation verification)
**Researched:** 2026-02-13
**Confidence:** HIGH

## Executive Summary

LexCerta is an MCP-native legal citation verification server designed to prevent AI hallucinations in legal document generation. The research reveals three critical architectural changes from the original PRD: (1) Harvard's CAP API has been shut down, requiring CourtListener as the sole data source; (2) MCP's SSE transport was deprecated in March 2025 in favor of Streamable HTTP; and (3) Eyecite citation parser is Python-only with no TypeScript port, requiring use of CourtListener's server-side citation-lookup API instead of local parsing.

The recommended approach collapses the original 3-tier architecture (parse, verify existence, verify quote) into a simpler 2-call pattern: CourtListener's citation-lookup API handles both parsing and existence verification in one request, then CourtListener's Opinions API retrieves full text for quote verification. This architectural simplification actually strengthens the product by eliminating the need to maintain a complex citation parser while leveraging Free Law Project's 55+ million citation dataset and Eyecite implementation server-side.

The key risk is CourtListener API rate limits (5,000/day free tier, 5,000/hour authenticated). Mitigation requires aggressive caching of verified citations (legal citations are immutable once published) and potentially partnering with Free Law Project for production quota increases. The product's competitive moat is being the only MCP-native citation verification tool with free full-text quote integrity checking—competitors like Clearbrief require LexisNexis subscriptions, and Travis-Prall's CourtListener MCP lacks quote verification.

## Key Findings

### Recommended Stack

The stack centers on TypeScript with the official MCP SDK, CourtListener API as the sole data source, and Streamable HTTP transport. The original PRD's three-tier architecture must be redesigned because two of the three originally-specified tools no longer exist or are inaccessible.

**Core technologies:**
- `@modelcontextprotocol/sdk` v1.26.0+: Official TypeScript MCP server framework with native Streamable HTTP transport support
- Node.js 20 LTS / 22 LTS: LTS stability required for legal-grade tooling
- `mcp-handler` (not `@vercel/mcp-adapter`): Vercel deployment adapter for Streamable HTTP transport on serverless/edge
- `zod` v3.25+: Schema validation; avoid v4.x due to documented SDK compatibility issues
- CourtListener API v4: Single data source for both citation parsing/verification (citation-lookup endpoint) and full-text retrieval (opinions endpoint). Absorbed Harvard CAP's 6.4M case corpus in 2024.

**Critical finding on stack:**
- CAP API (`api.case.law`) was shut down September 2024—all data migrated to CourtListener
- SSE transport deprecated in MCP spec March 2025—Streamable HTTP is the current standard
- Eyecite is Python-only (no npm package)—use CourtListener's citation-lookup API which runs Eyecite server-side

**API integrations:**
- CourtListener citation-lookup (`POST /api/rest/v3/citation-lookup/`): Single call replaces both Eyecite parsing and existence verification. Accepts up to 64K chars, returns parsed citations with matched opinion clusters.
- CourtListener Opinions API (`GET /api/rest/v4/opinions/{id}/`): Retrieves full opinion text for quote verification. Now contains CAP corpus data.

**Supporting libraries:**
- `p-queue`: Rate limiting for CourtListener API (5,000/day free tier, 5,000/hour authenticated)
- `lru-cache`: In-memory citation cache to stay within rate limits and meet <1.5s latency target
- `fastest-levenshtein`: Fuzzy string matching for quote verification
- Vitest 4.x: Standard for TypeScript testing in 2025-2026

### Expected Features

Research confirms citation verification is a table-stakes feature space with high baseline expectations. Users assume existence verification, hard errors on fake citations, and batch document-level processing. The differentiator is quote integrity verification using free data sources (CAP/CourtListener) while competitors require paid LexisNexis subscriptions (Clearbrief) or omit quote checking entirely (CiteCheck AI, Travis-Prall MCP).

**Must have (table stakes):**
- West Reporter citation parsing (full form, short form, supra, id.)
- Citation existence verification with hard errors (unambiguous "hallucination detected")
- Citation normalization (handle format variants: "U.S." vs "US", etc.)
- Case metadata return (name, court, date, reporter volume)
- Structured MCP tool responses with clear success/failure semantics
- Batch/document-level verification (legal documents contain dozens to hundreds of citations)

**Should have (competitive differentiators):**
- Quote integrity verification (full-text matching)—LexCerta's strongest differentiator; no free/MCP competitor offers this
- MCP-native interface—only citation tool built for AI agents rather than Word users
- Tiered confidence scoring (parsed → existence verified → quote verified)
- Citation position indexing (character offsets for annotation/markup)
- Caching layer for landmark cases (Miranda, Roe, etc.)

**Defer (v2+ or explicitly out of scope):**
- Good Law / Bad Law status (KeyCite/Shepard's equivalent)—requires paid Westlaw/LexisNexis APIs; partial free coverage is malpractice-enabling
- Statute and regulation verification—entirely different pipeline, different data sources
- AI-powered citation suggestion/generation—turns verification tool into generative tool, recursive hallucination risk
- Bluebook formatting enforcement—separate product category (BriefCatch, LegalEase Citations)
- Real-time document monitoring—requires persistent connection, not request/response MCP model

### Architecture Approach

The recommended architecture is a tiered verification pipeline with chain-of-responsibility pattern: cache → CourtListener API → fallback. Each tier either resolves the request or passes it forward. The architecture collapses the PRD's original 3-tier design (Eyecite parsing + CourtListener existence + CAP full-text) into 2 API calls because CourtListener now handles both parsing and existence verification server-side.

**Major components:**
1. **MCP Server + Tool Handlers** — Streamable HTTP transport, Zod-validated tool schemas, routes calls to verification pipeline
2. **Citation Parser (minimal)** — Normalization only; actual parsing delegated to CourtListener citation-lookup API which runs Eyecite server-side
3. **Verification Pipeline** — Orchestrates tiered lookup: cache → CourtListener → fallback; circuit breakers protect against API failures
4. **Cache Layer** — Two-tier: in-memory LRU cache (hot/TTL) + optional Redis/Supabase (persistent). Citations are immutable, cache permanently.
5. **CourtListener Client** — Wraps citation-lookup (parsing + existence) and opinions APIs (full-text retrieval); handles auth, rate limits, retries

**Key patterns:**
- **Chain of Responsibility:** Cache → CourtListener → fallback, stop at first success
- **Circuit Breaker:** After N failures, skip failing API tier to preserve rate limits and meet latency targets
- **Structured Response Envelope:** Consistent `{ status, confidence, source, metadata }` format for all tools

**Build order (dependency chain):**
1. Config + Types (no dependencies)
2. Citation Parser (minimal, normalization only)
3. Cache Layer (interface + in-memory)
4. CourtListener API Client
5. Circuit Breaker (utility)
6. Verification Pipeline (orchestration)
7. MCP Server + Tool Handlers (integration)

### Critical Pitfalls

The research uncovered six critical pitfalls that would silently break the product if not addressed during architecture and early implementation phases.

1. **CAP API Is Deprecated** — Harvard shut down api.case.law in September 2024. Teams assuming CAP is available discover 404s at runtime. **Avoid:** Design for CourtListener-only from day one. Data was migrated to CourtListener. No CAP integration work needed.

2. **SSE Transport Is Deprecated** — MCP spec deprecated HTTP+SSE in March 2025, replaced with Streamable HTTP. Building on SSE creates client incompatibility. **Avoid:** Implement Streamable HTTP from the start using official SDK's `StreamableHTTPServerTransport`.

3. **CourtListener Deep Pagination Block** — API explicitly blocks offset-based pagination beyond shallow depth. Batch verification breaks at scale. **Avoid:** Use cursor-based pagination exclusively. Follow `next` URLs in API responses, never construct `?page=N` URLs manually.

4. **Ambiguous Reporter Abbreviations** — Citations like "100 F. 200" vs "100 F.2d 200" require series disambiguation. False positive verifications occur when wrong reporter series is matched. **Avoid:** Use CourtListener's citation-lookup which handles disambiguation server-side. If building local parser, require date context for series resolution.

5. **Short-Form Citations Require Document Context** — Legal documents use Id., supra, and short-form references that cannot be verified in isolation (40-60% of citations in typical briefs). **Avoid:** Design tool schema to accept document context from day one; implement resolution in later phase but reserve parameter space now.

6. **CourtListener Rate Limits Silently Degrade Quality** — 5,000 requests/day free tier exhausts quickly. Subsequent verifications fail silently (HTTP 429). **Avoid:** Implement aggressive caching (citations are immutable). Cache hit ratio must exceed 80% after warm-up. Contact Free Law Project for production quota increase.

## Implications for Roadmap

Based on combined research, the recommended phase structure prioritizes foundation (transport, API integration, caching), then core verification (existence + quote), then enhancement (batch, confidence scoring, optimization). This order reflects dependency chains and risk mitigation.

### Phase 1: Foundation & Transport
**Rationale:** MCP transport choice and API integration patterns are foundational. Changing transport later is painful; API client patterns affect all downstream code. CourtListener API is the single point of integration—must be solid before building verification logic.

**Delivers:**
- Streamable HTTP MCP server with tool registration
- CourtListener API client with auth, rate limiting, circuit breaker
- Cache layer (in-memory LRU, interface for Redis/Supabase later)
- Basic citation normalization (reporter abbreviation mapping)

**Addresses:**
- SSE deprecation pitfall (use Streamable HTTP from start)
- CAP deprecation pitfall (CourtListener-only design)
- Rate limit pitfall (cache layer + circuit breaker)
- Deep pagination pitfall (cursor-based client from start)

**Avoids features:** No parsing logic (delegate to CourtListener), no quote verification yet (existence first), no batch processing (single citation flow first).

**Research flag:** Standard MCP patterns, no additional research needed. CourtListener API documented.

---

### Phase 2: Core Verification (Existence)
**Rationale:** The anti-hallucination value proposition requires existence verification working reliably. This phase implements the primary use case: verify a single citation exists or is hallucinated. Quote verification (differentiator) depends on existence verification succeeding first.

**Delivers:**
- `verify_citation` tool: accepts citation string, returns valid/invalid with case metadata
- Integration with CourtListener citation-lookup API (parsing + existence in one call)
- Structured MCP response envelope with confidence levels
- Hard error responses for fake citations ("hallucination detected")

**Uses:**
- CourtListener citation-lookup endpoint (`POST /api/rest/v3/citation-lookup/`)
- Cache layer (check cache before API, write successful verifications)
- Circuit breaker (protect against CourtListener outages)

**Implements:**
- Verification Pipeline (Tier 1: cache check, Tier 2: CourtListener lookup)
- Tool Handler with Zod schema validation

**Avoids pitfall:** Ambiguous reporter abbreviations (CourtListener handles disambiguation server-side).

**Research flag:** Standard patterns, no additional research needed.

---

### Phase 3: Quote Integrity Verification
**Rationale:** This is LexCerta's primary differentiator. No free/MCP competitor offers quote verification. Clearbrief requires LexisNexis subscription. This phase delivers the unique value proposition but depends on existence verification (Phase 2) working reliably—cannot fetch full text if citation does not exist.

**Delivers:**
- `verify_quote_integrity` tool: accepts citation + quoted text, returns match score and context
- Integration with CourtListener Opinions API for full-text retrieval
- Fuzzy string matching with normalized whitespace comparison
- Structured response: `{ exists: bool, quote_match: { found: bool, similarity: float, context: string } }`

**Uses:**
- CourtListener Opinions API v4 (`GET /api/rest/v4/opinions/{id}/`)
- `fastest-levenshtein` for fuzzy matching
- Verification Pipeline (extend with Tier 3: full-text retrieval)

**Implements:**
- Quote Matcher component
- Extended verification pipeline with quote verification tier

**Addresses:** Competitive differentiation (free quote verification using CourtListener's CAP-sourced data).

**Research flag:** Fuzzy matching threshold tuning may need experimentation. Consider `/gsd:research-phase` for optimal similarity thresholds and OCR artifact handling.

---

### Phase 4: Batch & Document-Level Verification
**Rationale:** Legal documents contain dozens to hundreds of citations. Single-citation verification is table stakes but unusable at scale. This phase implements the document-level workflow users expect. Depends on single-citation pipeline (Phases 2-3) working reliably—batch is parallelized single-citation verification with deduplication.

**Delivers:**
- `batch_verify_citations` tool: accepts document text, returns array of verification results
- Parallel verification with concurrency limits (respect rate limits)
- Deduplication (verify each unique citation once)
- Streaming partial results via MCP progress notifications

**Uses:**
- CourtListener citation-lookup (accepts up to 64K chars in single request)
- Verification pipeline (parallelize across deduplicated citations)
- `p-queue` for concurrency-limited API requests

**Implements:**
- Batch orchestration layer
- Deduplication logic
- Progress streaming

**Avoids pitfall:** Synchronous waterfall anti-pattern (parallelize with rate limit awareness).

**Research flag:** Standard pattern (fan-out with concurrency control). No additional research needed.

---

### Phase 5: Enhancement & Optimization
**Rationale:** Phases 1-4 deliver complete MVP. This phase adds polish: tiered confidence scoring (expose verification depth), citation position indexing (enable downstream annotation), persistent cache (scale beyond in-memory), and optimization (pre-warm common citations).

**Delivers:**
- Tiered confidence scoring (`parsed_only`, `existence_verified`, `quote_verified`)
- Citation position indexing (pass through `start_index`, `end_index` from CourtListener)
- Redis/Supabase persistent cache integration
- Pre-warming cache with landmark cases (Miranda, Roe, Brown, etc.)

**Uses:**
- Existing verification pipeline (add confidence level tracking)
- CourtListener citation-lookup response fields (`start_index`, `end_index`)
- Redis or Supabase for persistent cache layer

**Implements:**
- Confidence tracking across verification tiers
- Persistent cache adapter (Redis or Supabase implementation of cache interface)

**Research flag:** Standard patterns, no additional research needed.

---

### Phase 6 (Future): Advanced Features
**Rationale:** Defer until product-market fit established. These are competitive enhancements, not MVP requirements.

**Potential features:**
- Parallel citation resolution (given one reporter, return all parallel citations per Bluebook 10.3.1)
- Document context for short-form citations (Id., supra, reference citation resolution)
- Semantic search integration (CourtListener launched semantic API November 2025)

**Research flag:** Phase 6 features each need targeted research. Parallel citation requires reporter system mapping research. Short-form resolution requires Bluebook citation chain research. Semantic search integration requires CourtListener semantic API experimentation.

---

### Phase Ordering Rationale

**Dependency-driven:**
- Phase 1 must precede all others (foundation: transport, API client, cache)
- Phase 2 must precede Phase 3 (quote verification requires existence verification succeeding first)
- Phase 4 depends on Phases 2-3 (batch is parallelized single-citation flow)
- Phase 5 enhances existing pipeline (can only add confidence scoring after tiers exist)

**Risk-driven:**
- Address transport deprecation immediately (Phase 1)—switching later is painful
- Address API integration pitfalls early (Phase 1)—rate limits, pagination, circuit breaker
- Defer complex features (Phase 6) until core value validated

**Architectural grouping:**
- Phase 1: Infrastructure layer (transport, clients, cache)
- Phases 2-3: Verification layer (existence, quote)
- Phase 4: Orchestration layer (batch, parallel)
- Phase 5: Enhancement layer (optimization, polish)

### Research Flags

**Phases needing targeted research during planning:**
- **Phase 3 (Quote Verification):** Fuzzy matching threshold tuning, OCR artifact handling strategies. CourtListener's opinion text is machine-generated from CAP, not human-reviewed. Needs experimentation to determine optimal similarity thresholds and whitespace normalization strategies. Consider `/gsd:research-phase` for quote matching strategies.

**Phases with standard patterns (skip research-phase):**
- **Phase 1 (Foundation):** MCP SDK patterns are well-documented. CourtListener API is documented by Free Law Project with examples.
- **Phase 2 (Existence Verification):** Standard REST API integration pattern. CourtListener citation-lookup endpoint is straightforward.
- **Phase 4 (Batch Processing):** Standard fan-out with concurrency control pattern (`Promise.allSettled` + `p-queue`).
- **Phase 5 (Enhancement):** Incremental additions to existing patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | MCP SDK is official and stable (v1.26.0). CourtListener API is production-grade (100M+ requests served). CAP deprecation and SSE deprecation confirmed by primary sources (Harvard LIL blog, MCP spec). Eyecite Python-only confirmed by PyPI. All critical findings have HIGH confidence. |
| Features | MEDIUM-HIGH | Feature landscape confirmed by competitor analysis (CiteCheck AI, Clearbrief, Travis-Prall MCP, WestCheck). Table stakes features match industry expectations. Quote integrity as differentiator is validated (Clearbrief requires LexisNexis; no free competitor offers this). Lower confidence on exact Bluebook compliance requirements (deferred to v2+). |
| Architecture | HIGH | MCP patterns are well-documented. Tiered pipeline with chain-of-responsibility is standard pattern for multi-source data verification. Circuit breaker pattern is established for API reliability. Build order follows clear dependency chain. |
| Pitfalls | HIGH | CAP deprecation: confirmed by Harvard LIL official announcement. SSE deprecation: confirmed by MCP specification changelog. CourtListener pagination: confirmed by GitHub source code and issue tracker. Rate limits: confirmed by Free Law Project documentation and community discussions. Reporter abbreviation ambiguity: fundamental to West Reporter system, confirmed by Eyecite documentation. |

**Overall confidence:** HIGH

The research uncovered three critical architectural changes from the original PRD, all confirmed by primary sources. The revised architecture is actually simpler than originally planned (CourtListener citation-lookup collapses Tiers 1+2). The main uncertainty is quote verification fuzzy matching thresholds, which can be tuned during Phase 3 implementation.

### Gaps to Address

**Quote matching threshold tuning:** Research confirms CourtListener opinion text is machine-generated from CAP and may contain OCR artifacts. The optimal similarity threshold for fuzzy matching (e.g., 0.85? 0.90? 0.95?) requires experimentation during Phase 3. Plan to implement configurable threshold and A/B test against known-good citations.

**CourtListener production quota:** Free tier (5,000/day) and authenticated tier (5,000/hour) limits are documented, but production partnership terms are not public. During Phase 1 implementation, contact Free Law Project to understand quota increase options for production deployment.

**Short-form citation resolution scope:** Research confirms short-form citations (Id., supra, reference) require document context and are 40-60% of citations in typical briefs. The exact implementation complexity is unclear—whether to build citation chain resolver or defer to v2+. Recommend Phase 1 tool schema reserves `document_context` parameter even if not implemented until later phase.

**Vercel vs Supabase deployment trade-offs:** Research presents both options but does not definitively choose. Vercel + mcp-handler is simpler for v1 (stateless serverless). Supabase Edge Functions require authentication integration (coming soon per docs). Recommend Vercel for Phase 1 deployment, evaluate Supabase for persistent cache (Phase 5) or distributed deployment (post-MVP).

## Sources

### Primary (HIGH confidence)
- [Harvard LIL: Transitions for the Caselaw Access Project](https://lil.law.harvard.edu/blog/2024/03/26/transitions-for-the-caselaw-access-project/) — CAP API deprecation confirmed
- [MCP Specification: Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) — SSE deprecation, Streamable HTTP standard
- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk) — Official SDK, Streamable HTTP support, Zod compatibility
- [@modelcontextprotocol/sdk npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — v1.26.0 verified
- [CourtListener Citation Lookup API](https://free.law/2024/04/16/citation-lookup-api/) — API capabilities, text limits, response fields
- [Eyecite on PyPI](https://pypi.org/project/eyecite/) — Python-only confirmed, no JS port
- [CourtListener API rate limit discussion](https://github.com/freelawproject/courtlistener/discussions/1497) — 5,000/day free tier, 5,000/hour authenticated
- [CourtListener pagination issue](https://github.com/freelawproject/courtlistener/issues/609) — Deep pagination block confirmed
- [Free Law Project: eyecite GitHub](https://github.com/freelawproject/eyecite) — 55M+ citations tested, citation types, ambiguity handling
- [freelawproject/citation-regexes](https://github.com/freelawproject/citation-regexes) — JavaScript regex patterns for citation parsing

### Secondary (MEDIUM confidence)
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/) — Rationale for Streamable HTTP
- [Vercel MCP Deployment Docs](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel) — mcp-handler usage
- [CourtListener surpasses 100M requests](https://free.law/2025/09/29/one-hundred-million-requests/) — API v4 production status
- [CiteCheck AI launch coverage](https://www.lawnext.com/2025/06/lawdroid-launches-citecheck-ai-a-fail-safe-against-ai-citation-hallucinations.html) — Competitor features
- [Clearbrief Cite Check Report](https://www.lawnext.com/2025/12/clearbrief-launches-cite-check-report-to-give-law-firm-partners-an-audit-trail-against-ai-hallucinations.html) — Competitor features
- [Travis-Prall CourtListener MCP](https://github.com/Travis-Prall/court-listener-mcp) — Closest MCP competitor
- [Supabase MCP Edge Functions docs](https://supabase.com/docs/guides/getting-started/byo-mcp) — Deployment option
- [NearForm: MCP Tips, Tricks and Pitfalls](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/) — Implementation mistakes

### Tertiary (LOW confidence)
- [CourtListener Semantic Search launch](https://free.law/2025/11/05/semantic-search-api/) — Future capability, not yet battle-tested
- [Vitest 4.0 release](https://www.infoq.com/news/2025/12/vitest-4-browser-mode/) — Version verified
- [FastMCP npm](https://www.npmjs.com/package/fastmcp) — Alternative SDK option

---
*Research completed: 2026-02-13*
*Ready for roadmap: yes*
