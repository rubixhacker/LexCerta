# Pitfalls Research

**Domain:** Legal citation verification MCP server (West Reporter system)
**Researched:** 2026-02-13
**Confidence:** MEDIUM-HIGH

## Critical Pitfalls

### Pitfall 1: CAP API Is Deprecated — Single-Source Dependency on CourtListener

**What goes wrong:**
Harvard's Caselaw Access Project (CAP) API has been wound down. The search function and API were deprecated as of late 2024, with old.case.law shut down in September 2024. Teams that planned for CAP as a primary or fallback data source discover it no longer exists at runtime.

**Why it happens:**
CAP was the canonical free legal dataset for years. Older tutorials, blog posts, and even recent LLM training data still reference it as a viable API. Developers assume it is still operational without checking current status.

**How to avoid:**
- Treat CourtListener as the sole API source from day one. CAP data was ingested into CourtListener, so coverage is maintained.
- Design the verification layer with an adapter/provider pattern so a new source can be swapped in if CourtListener becomes unavailable.
- Do NOT invest any time integrating CAP API endpoints.

**Warning signs:**
- Any documentation or code referencing `api.case.law` or `case.law/api` endpoints
- 404/410 responses from CAP URLs during development

**Phase to address:**
Phase 1 (Foundation). Architecture must assume CourtListener-only from the start. The provider abstraction should be designed but only CourtListener implemented.

**Confidence:** HIGH — confirmed via [Harvard Library Innovation Lab announcement](https://lil.law.harvard.edu/blog/2024/03/26/transitions-for-the-caselaw-access-project/)

---

### Pitfall 2: SSE Transport Is Deprecated in MCP Spec — Building on a Dead Protocol

**What goes wrong:**
The MCP specification deprecated HTTP+SSE transport in the 2025-03-26 spec revision, replacing it with Streamable HTTP. Projects built on SSE transport face client incompatibility as MCP clients migrate to the new transport.

**Why it happens:**
Early MCP tutorials (pre-March 2025) all use SSE. Many example repositories still demonstrate SSE. The official SDKs maintain backward compatibility, which masks the deprecation during development — it works in testing but clients stop supporting it.

**How to avoid:**
- Implement Streamable HTTP transport from the start, not SSE.
- If backward compatibility with older clients is needed, support both transports behind a single endpoint. The Streamable HTTP spec allows SSE fallback.
- Use the official MCP TypeScript SDK which supports Streamable HTTP natively.

**Warning signs:**
- Using `@modelcontextprotocol/sdk` with SSE-only transport configuration
- MCP Inspector working but real clients (Claude Desktop, VS Code) failing to connect
- Any reference to the two-endpoint SSE pattern (`/sse` for events, `/messages` for requests)

**Phase to address:**
Phase 1 (Foundation). Transport choice is foundational and painful to change later. Get Streamable HTTP working before building any tools.

**Confidence:** HIGH — confirmed via [MCP specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) and [multiple](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/) [analyses](https://brightdata.com/blog/ai/sse-vs-streamable-http)

---

### Pitfall 3: CourtListener Deep Pagination Block Breaks Batch Verification

**What goes wrong:**
CourtListener API explicitly blocks deep pagination. Requesting offset-based pages beyond a shallow threshold returns `NotFound: "Invalid page: Deep API pagination is not allowed."` This breaks any batch verification workflow that iterates through large result sets using page numbers.

**Why it happens:**
Developers assume standard REST pagination (page=1, page=2, ..., page=N) will work. CourtListener uses cursor-based pagination to protect database performance but does not make this obvious in initial API exploration.

**How to avoid:**
- Use cursor-based pagination exclusively. Follow the `next` URL in API responses rather than constructing page URLs manually.
- For citation verification, structure queries to return narrow result sets (filter by reporter, volume, page) rather than broad searches that require deep pagination.
- Cache verified citations to avoid re-paginating the same result sets.

**Warning signs:**
- API calls using `?page=N` where N > ~5
- 404 errors during batch verification runs
- Verification working for small batches but failing at scale

**Phase to address:**
Phase 1 (API integration). API client layer must use cursor pagination from the first implementation.

**Confidence:** HIGH — confirmed via [CourtListener API tests](https://github.com/freelawproject/courtlistener/blob/main/cl/api/tests.py) and [community discussions](https://github.com/freelawproject/courtlistener/issues/609)

---

### Pitfall 4: Ambiguous Reporter Abbreviations Produce False Positive Verifications

**What goes wrong:**
Legal citations contain reporter abbreviations that are ambiguous without date context. For example, "A." could be the Atlantic Reporter (1st series) or an abbreviation for other reporters. "F. Supp." vs "F. Supp. 2d" vs "F. Supp. 3d" require series awareness. Without proper disambiguation, the system verifies a citation against the wrong reporter, returning a false positive ("verified") for a citation that actually does not exist in the claimed reporter.

**Why it happens:**
West Reporter abbreviations evolved over 130+ years with multiple series (e.g., F., F.2d, F.3d, F.4th for the Federal Reporter). Regional reporters cover geographically illogical jurisdictions (Oklahoma and Kansas in the Pacific Reporter). Citation formats vary by jurisdiction-specific Bluebook rules, local court rules, and informal conventions. The eyecite library flags this explicitly with its `remove_ambiguous` parameter.

**How to avoid:**
- Use eyecite's citation extraction as a reference for the full taxonomy of reporter abbreviations and their date ranges. Eyecite has been tested against 55+ million citations.
- Always require date context for disambiguation. A citation to "100 F. 200" must be interpreted differently than "100 F.2d 200" — the series number is semantically critical.
- Implement a reporter-to-date-range mapping: each reporter series has a known date range (e.g., F.2d covers 1924-1993). If the citation's date falls outside the reporter's range, flag it as suspicious.
- Return confidence scores, not binary verified/not-verified. "Verified in F.2d but date suggests F.3d" is more useful than a false positive.

**Warning signs:**
- Verification passing for citations with mismatched reporter series and dates
- No handling of the `remove_ambiguous` flag equivalent in your parser
- Unit tests only covering clean Bluebook-format citations

**Phase to address:**
Phase 2 (Citation parsing and verification logic). This requires building a comprehensive reporter database before verification can be trusted.

**Confidence:** HIGH — confirmed via [eyecite documentation](https://github.com/freelawproject/eyecite) and West Reporter system structure

---

### Pitfall 5: Short-Form and Reference Citations Cannot Be Verified in Isolation

**What goes wrong:**
Legal documents heavily use short-form citations ("Id. at 552"), supra references ("Bush, supra, at 100"), and reference citations ("Theatre Enterprises at 552"). These are meaningful only in the context of a preceding full citation. A verification system that processes citations in isolation will either reject all short forms (annoying) or fail to resolve them (incomplete).

**Why it happens:**
Most verification MVP designs accept a single citation string and return a result. This works for full citations ("Bush v. Gore, 531 U.S. 98 (2000)") but not for the 40-60% of citations in a typical legal brief that are short forms, Id. references, or supra references.

**How to avoid:**
- Design the MCP tool interface to accept BOTH single citations AND document-context citation batches.
- For single-citation verification, clearly document that only full-form citations are supported and return an explicit "unresolvable: short-form citation requires document context" response.
- For document-context mode, implement a citation chain resolver that tracks the "current citation" state (what Id. refers to) as it processes the document sequentially.
- Defer document-context mode to a later phase but design the tool schema to accommodate it.

**Warning signs:**
- MCP tool only accepts a single string parameter with no context field
- Users reporting "citation not found" for valid Id./supra references
- No test cases for short-form citations

**Phase to address:**
Phase 1 (tool schema design) for the interface contract. Phase 3+ for document-context resolution implementation.

**Confidence:** HIGH — this is fundamental to legal citation practice per [Bluebook citation rules](https://lib.law.uw.edu/bluebook101/citationexamples)

---

### Pitfall 6: CourtListener Rate Limits Silently Degrade Verification Quality

**What goes wrong:**
CourtListener enforces 5,000 requests/day for free API keys. A single legal brief can contain 50-200 citations. A busy MCP server verifying documents for multiple users burns through the daily quota in hours, causing subsequent verifications to silently fail (HTTP 429) or return incomplete results.

**Why it happens:**
During development with low traffic, rate limits are never hit. The 5,000/day limit sounds generous until you account for: (a) multiple API calls per citation verification (search + detail fetch), (b) parallel users, (c) retry logic that doubles request volume on transient errors.

**How to avoid:**
- Implement aggressive caching. Legal citations are immutable — once "531 U.S. 98" is verified, cache it permanently. A citation-to-case mapping never changes.
- Use a request budget tracker that counts API calls and degrades gracefully (returns cached results or queues requests) before hitting the limit.
- Contact Free Law Project for a higher rate limit if deploying to production. They are open to supporting legitimate projects.
- Batch API calls where possible: verify by volume+reporter+page rather than making individual searches per citation.

**Warning signs:**
- HTTP 429 responses in production logs
- Verification latency increasing throughout the day
- Inconsistent verification results (working in morning, failing in afternoon)

**Phase to address:**
Phase 1 (API client) for rate limit tracking. Phase 2 (caching layer) for permanent citation caching.

**Confidence:** HIGH — confirmed via [CourtListener rate limit discussions](https://github.com/freelawproject/courtlistener/discussions/1497)

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Hardcode reporter abbreviations | Faster MVP | New reporter series (e.g., F.5th) requires code changes | Never — use a data file from day one |
| Skip caching, hit API every time | Simpler architecture | Rate limit exhaustion, slow responses, API dependency | Never — citations are immutable data |
| SSE transport only | More tutorials/examples available | Client incompatibility as MCP ecosystem migrates | Only if also implementing Streamable HTTP |
| Binary verified/unverified response | Simple tool schema | No way to express partial matches, ambiguity, or confidence | Only in Phase 1 MVP, must evolve to confidence scores |
| No authentication on MCP endpoint | Faster local development | Anyone with the URL can consume your API quota | Only in local development, never in deployed edge functions |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| CourtListener API | Using offset pagination (`?page=N`) | Use cursor-based pagination, follow `next` URLs |
| CourtListener API | Searching by full citation string | Search by structured fields: reporter, volume, page number separately |
| CourtListener API | Not sending auth token | Always include `Authorization: Token <key>` header; unauthenticated requests have stricter limits |
| MCP SDK | Logging to stdout | Route ALL logs to stderr; stdout is the protocol transport channel and any stray output corrupts messages |
| MCP SDK | Defining too many similar tools | Consolidate related operations; LLMs pick wrong tool when tool descriptions overlap |
| Edge Functions | Assuming persistent state between invocations | Edge functions are stateless; use external cache (KV store) for citation cache |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| No citation cache | Every verification hits CourtListener API | Implement KV-backed permanent cache for verified citations | At ~25 concurrent users or ~100 verifications/hour |
| Synchronous multi-citation verification | Timeout on documents with 50+ citations | Parallelize API calls with concurrency limits; stream partial results | At ~10 citations per request |
| Cold start + API latency stacking | First request after idle takes 3-5 seconds | Pre-warm edge functions; use connection pooling; return cached results while fetching fresh | Every cold start (~400ms) + API roundtrip (~200-500ms) |
| Unbounded response payloads | Token window consumption in MCP clients | Paginate results; summarize by default, detail on demand | When verifying >20 citations in single tool call |
| Regex-based citation parsing on large documents | CPU timeout in edge functions | Limit input size; use optimized tokenizers (pyahocorasick/hyperscan patterns from eyecite) | Documents >50 pages |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| No authentication on remote MCP endpoint | Anyone can consume your CourtListener API quota; potential for quota exhaustion attacks | Implement API key or OAuth 2.1 authentication on the MCP endpoint itself |
| CourtListener API key in client-side code | Key exposure, quota theft | Keep API key server-side only; edge function environment variables |
| No input sanitization on citation strings | Regex denial-of-service (ReDoS) via crafted citation strings | Limit input length; use time-bounded regex execution; validate input format before parsing |
| Overly broad MCP tool scopes | LLM clients get access to operations beyond verification (e.g., write operations) | Define read-only tool scopes; citation verification is a pure read operation |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Binary verified/unverified with no explanation | User has no idea WHY a citation failed verification | Return structured result: { verified, confidence, matched_case, discrepancies } |
| Failing on non-Bluebook citation formats | Many practitioners use informal or jurisdiction-specific formats | Accept common variants; normalize before verification; flag format issues separately from verification failures |
| No distinction between "not found" and "API error" | User assumes citation is invalid when actually the API was down | Separate error types: verified, unverified, ambiguous, api_error, rate_limited |
| Slow response with no progress indication | User thinks tool is broken during multi-citation verification | Stream partial results via MCP progress notifications; return verified citations as they complete |
| Returning raw API data instead of relevant fields | Token waste in MCP context window; confusing output | Return only: case name, citation, court, date, verification status, and link to full record |

## "Looks Done But Isn't" Checklist

- [ ] **Citation parsing:** Often missing parallel citation support — verify parser handles "531 U.S. 98, 121 S. Ct. 525, 148 L. Ed. 2d 388"
- [ ] **Reporter database:** Often missing recent series — verify F.4th (started 2021), N.E.3d, S.W.3d, etc. are included
- [ ] **Verification logic:** Often missing pin cite validation — "531 U.S. at 110" should verify page 110 exists within the opinion's page range
- [ ] **Error handling:** Often missing graceful degradation — verify behavior when CourtListener is down (return cached results, not errors)
- [ ] **MCP compliance:** Often missing tool descriptions — verify tool metadata includes proper JSON Schema for all parameters
- [ ] **Edge deployment:** Often missing CORS headers — verify browser-based MCP clients can connect
- [ ] **Cache invalidation:** Often missing entirely — but for legal citations this is fine since citations are immutable; verify NO cache invalidation logic exists (it would be a bug)
- [ ] **Transport:** Often missing Streamable HTTP — verify the server responds to POST requests at the MCP endpoint, not just SSE

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Built on SSE-only transport | MEDIUM | Add Streamable HTTP handler alongside SSE; both can coexist. ~1-2 days of work with official SDK. |
| No caching layer | MEDIUM | Add KV store integration; backfill cache from existing verification logs. ~2-3 days. |
| Integrated CAP API | LOW | Remove CAP code paths; CourtListener already has all CAP data. ~1 day. |
| Binary verification responses | MEDIUM | Extend tool schema with confidence/discrepancy fields; update all response builders. ~2 days. |
| Ambiguous citations returning false positives | HIGH | Requires building reporter-date-range database and reworking verification logic. ~1 week. |
| Rate limit exhaustion in production | LOW-MEDIUM | Immediate: implement caching. Short-term: contact Free Law Project for higher limits. ~1-2 days. |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| CAP API deprecated | Phase 1: Foundation | No CAP imports or references in codebase |
| SSE transport deprecated | Phase 1: Foundation | MCP Inspector connects via Streamable HTTP POST |
| Deep pagination block | Phase 1: API client | Integration tests verify cursor-based pagination across >100 results |
| Ambiguous reporter abbreviations | Phase 2: Citation logic | Test suite includes all reporter series with date range validation |
| Short-form citation resolution | Phase 1: Schema design (interface); Phase 3+: Implementation | Tool schema has optional `document_context` parameter |
| Rate limit exhaustion | Phase 1: API client; Phase 2: Caching | Rate limit counter in logs; cache hit ratio >80% after warm-up |
| No MCP authentication | Phase 1: Deployment | Edge function requires auth header; unauthenticated requests return 401 |
| stdout logging corruption | Phase 1: Foundation | CI check that no stdout logging exists; all logging to stderr |
| ReDoS on citation input | Phase 2: Input validation | Fuzz tests with adversarial citation strings; input length limits enforced |
| Token-bloating responses | Phase 2: Tool design | Response size tests verify output <2KB for single citations, <10KB for batches |

## Sources

- [Harvard LIL: Transitions for the Caselaw Access Project](https://lil.law.harvard.edu/blog/2024/03/26/transitions-for-the-caselaw-access-project/) — CAP API deprecation
- [CourtListener API rate limit discussion](https://github.com/freelawproject/courtlistener/discussions/1497) — Rate limits and throttling
- [CourtListener pagination issue](https://github.com/freelawproject/courtlistener/issues/609) — Deep pagination block
- [Free Law Project: eyecite](https://github.com/freelawproject/eyecite) — Citation parsing edge cases and ambiguity handling
- [MCP Specification: Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) — SSE deprecation, Streamable HTTP
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/) — Transport migration rationale
- [NearForm: MCP Tips, Tricks and Pitfalls](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/) — MCP implementation mistakes
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices) — Security pitfalls
- [Supabase Edge Function troubleshooting](https://supabase.com/docs/guides/troubleshooting/edge-function-shutdown-reasons-explained) — Edge function timeout/cold start
- [Free Law Project: 100 Million API Requests](https://free.law/2025/09/29/one-hundred-million-requests/) — CourtListener v4 API status
- [Bluebook Citation Examples](https://lib.law.uw.edu/bluebook101/citationexamples) — Citation format standards

---
*Pitfalls research for: Legal citation verification MCP server (LexCerta)*
*Researched: 2026-02-13*
