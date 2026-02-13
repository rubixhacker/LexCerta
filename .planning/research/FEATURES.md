# Feature Research

**Domain:** Legal citation verification MCP server (anti-hallucination)
**Researched:** 2026-02-13
**Confidence:** MEDIUM-HIGH

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| West Reporter citation parsing | Core product promise. Every competitor (CiteCheck AI, Clearbrief, WestCheck) does this. Without parsing, nothing else works. | MEDIUM | Eyecite handles this — supports full, short form, supra, id., ibid. references. ~10MB/s throughput. Must handle malformed input gracefully. |
| Citation existence verification | The fundamental anti-hallucination check. If a citation does not map to a real opinion, the tool must say so definitively. CiteCheck AI, CourtListener API, and every competitor does this. | MEDIUM | CourtListener citation lookup API returns 200/404 status per citation. Database of ~10M citations. Free tier: 5,000 requests/day. |
| Hard error on fake citations | AI agents must receive unambiguous "this citation does not exist" responses. Soft failures (warnings, maybes) let hallucinations pass through. This is the entire value proposition. | LOW | Return structured error with explicit "hallucination detected" messaging. No graceful degradation — false negatives are unacceptable. |
| Citation normalization | Agents produce inconsistent formatting ("123 S. Ct 456" vs "123 S. Ct. 456", "US" vs "U.S."). CourtListener API already returns normalized forms. Every citation tool normalizes. | LOW | CourtListener returns `normalized_citations` field. Map common reporter abbreviation variants to canonical West format. |
| Case metadata return | When a citation is valid, return case name, court, date, reporter volume. Every verification tool returns this context. Agents need it for drafting. | LOW | CourtListener clusters endpoint provides this. Map to clean MCP response schema. |
| Structured MCP tool responses | MCP-native consumers expect typed tool responses with clear success/failure semantics. This is the interface contract. | LOW | Use MCP SDK response patterns. Include `valid` boolean, metadata object, error object. |
| Batch/document-level verification | Legal documents contain dozens to hundreds of citations. Verifying one at a time is unusable. CourtListener API accepts up to 64K characters of text. CiteCheck AI processes whole documents. Travis-Prall MCP has `batch_lookup_citations`. | MEDIUM | CourtListener's text-block API is the natural fit — send full text, get all citations back with status. Must handle rate limits (5K/day free tier). |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Quote integrity verification (full-text matching) | No existing MCP server or free tool does this. CiteCheck AI only checks citation existence, not whether quoted text actually appears in the opinion. Clearbrief does this but requires LexisNexis subscription and Word. This is LexCerta's strongest differentiator. | HIGH | Requires CAP full-text retrieval (500 cases/day limit) + fuzzy string matching. Must handle OCR artifacts in CAP data (machine-generated, not human-reviewed). Fuzzy matching threshold needs careful tuning. |
| MCP-native interface (not Word plugin, not web UI) | Every competitor is a Word plugin (Clearbrief, BriefCatch, WestCheck) or web upload (CiteCheck AI). No competitor is MCP-native. AI legal agents (Claude Desktop, custom agents) cannot use Word plugins. LexCerta is the only tool that meets agents where they are. | LOW | This is an architectural choice, not a feature to build. The MCP SDK handles the protocol. The differentiator is being the only option in this form factor. |
| Tiered confidence scoring | Return not just valid/invalid but a confidence level: parsed (Tier 1), existence confirmed (Tier 2), full-text verified (Tier 3). Agents can make risk-calibrated decisions. No competitor exposes verification depth this way. | LOW | Map the three-tier verification pipeline to explicit confidence levels in the response. E.g., `confidence: "parsed_only"`, `confidence: "existence_verified"`, `confidence: "quote_verified"`. |
| Citation start/end position indexing | CourtListener API returns character positions for each citation in submitted text. Enables agents to annotate, hyperlink, or highlight specific citations in generated documents. Travis-Prall MCP does not expose this. | LOW | Pass through `start_index` and `end_index` from CourtListener response. Enables downstream agents to do markup/annotation. |
| Caching layer for landmark cases | Frequently cited cases (Miranda, Roe, Brown v. Board) are requested repeatedly. Caching eliminates API latency and rate limit pressure. No free competitor caches. | MEDIUM | Redis/KV store keyed on normalized citation string. TTL of days/weeks (case law does not change). Dramatically reduces CourtListener/CAP API usage against rate limits. |
| Parallel citation resolution | Given one reporter citation, return parallel citations (e.g., both state reporter and regional reporter forms). Useful for agents drafting for specific jurisdictions that require parallel citations per Bluebook Rule 10.3.1. | MEDIUM | Requires mapping between reporter systems. CourtListener clusters may link parallel citations. Not all jurisdictions require this. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Good Law / Bad Law status (KeyCite/Shepard's equivalent) | Lawyers want to know if a case has been overruled, reversed, or criticized. This is the gold standard of citation checking. | Requires Westlaw or LexisNexis paid API access. Thomson Reuters and LexisNexis actively restrict programmatic access. Building this with free tools produces dangerously incomplete results — telling a lawyer a case is "good law" when you only checked free databases is malpractice-enabling. Partial coverage is worse than no coverage. | Explicitly mark this as out of scope in responses. Return `"good_law_status": "not_checked"` with a note that KeyCite/Shepard's verification is required. Never imply a verified citation is "good law." |
| Statute and regulation verification | Legal documents cite statutes (U.S.C.), regulations (C.F.R.), and secondary sources alongside case law. Users will ask for this. | Entirely different data sources, parsing rules, and verification pipelines. Statutes are amended, renumbered, and repealed constantly. The West Reporter system does not cover statutes. Mixing case law and statute verification in one tool creates false confidence. | Keep scope to West Reporter case citations only. Document the boundary clearly. Statute verification is a separate MCP server. Travis-Prall's MCP already has eCFR tools — do not duplicate. |
| AI-powered citation suggestion/generation | If a citation is fake, why not suggest the real case the agent probably meant? Seems helpful. | Turns a verification tool into a generative tool. Suggestions could themselves be wrong, creating a recursive hallucination problem. The tool's authority comes from never generating — only verifying. | Return the error with enough metadata (court, date range, topic keywords from the fake citation) that the calling agent can re-search on its own. |
| Web UI / dashboard | Humans want to see results visually. A dashboard seems obvious. | Splits focus between MCP server and web app. Different deployment, different auth, different testing. The target user is an AI agent, not a human. Humans already have Clearbrief, CiteCheck AI, WestCheck. | Provide clean JSON responses that agents can format for their own UIs. If human visibility is needed, build a simple MCP Inspector integration, not a custom dashboard. |
| Bluebook formatting enforcement | Full Bluebook compliance checking (italics, parenthetical placement, signal ordering, etc.). | The Bluebook has hundreds of rules spanning typography, ordering, signals, parentheticals, and jurisdiction-specific exceptions. This is a separate product (BriefCatch charges for this). Over-engineering formatting when the core value is verification. | Normalize to standard West format (correct abbreviations, spacing, periods). Leave full Bluebook compliance to dedicated tools like BriefCatch or LegalEase Citations ($22/month). |
| Real-time document monitoring | Watch a document as it is being drafted and flag citations in real-time. | Requires persistent connection, document access, change detection. Completely different architecture from request/response MCP tools. Word plugin territory. | The MCP tool model is request/response. Agents call verify when they have citations to check. Real-time monitoring is the agent's responsibility, not the server's. |

## Feature Dependencies

```
[Citation Parsing (Eyecite)]
    |
    +--requires--> [Citation Normalization]
    |
    +--requires--> [Citation Existence Check (CourtListener)]
                       |
                       +--requires--> [Case Metadata Return]
                       |
                       +--requires--> [Citation Position Indexing]
                       |
                       +--enhances--> [Quote Integrity Verification (CAP)]
                       |
                       +--enhances--> [Parallel Citation Resolution]
                       |
                       +--enhances--> [Caching Layer]

[Batch Verification] --requires--> [Citation Parsing] + [Existence Check]

[Tiered Confidence Scoring] --requires--> [All three verification tiers operational]

[Quote Integrity] --requires--> [Existence Check] (must confirm case exists before fetching full text)
```

### Dependency Notes

- **Citation Parsing requires Normalization:** Parsed citations must be normalized before querying CourtListener (which expects canonical forms).
- **Quote Integrity requires Existence Check:** No point fetching full text from CAP if the citation itself is fake. Existence must pass first.
- **Batch Verification requires single-citation pipeline:** Batch is a loop/parallel execution of the single-citation flow. Build single first.
- **Caching enhances Existence Check and Quote Integrity:** Cache sits in front of both CourtListener and CAP calls. Does not block them — additive optimization.
- **Tiered Confidence requires all tiers:** Cannot report confidence levels until each tier is independently functional.

## MVP Definition

### Launch With (v1)

Minimum viable product — what is needed to validate the concept.

- [ ] `verify_west_citation` tool — parse citation string, normalize, check existence via CourtListener, return valid/invalid with metadata. This is the core anti-hallucination check.
- [ ] `verify_quote_integrity` tool — given citation + quote string, fetch full text from CAP, fuzzy match, return match score. This is the primary differentiator.
- [ ] Citation normalization — correct common West format errors in input before verification. Embedded in the verification pipeline, not a separate tool.
- [ ] Hard error responses — unambiguous "hallucination detected" for fake citations. No soft failures.
- [ ] SSE transport — remote agent connectivity. Without this, only local stdio agents can use the server.

### Add After Validation (v1.x)

Features to add once core is working.

- [ ] Batch/document-level verification — when agents start sending full documents rather than individual citations. Trigger: user feedback that one-at-a-time is too slow.
- [ ] Caching layer — when API rate limits become a bottleneck. Trigger: hitting CourtListener's 5,000/day free tier limit or CAP's 500/day limit.
- [ ] Citation position indexing — when agents want to annotate/hyperlink citations in generated text. Trigger: integration with document generation agents.
- [ ] Tiered confidence scoring — when agents want nuanced risk assessment rather than binary valid/invalid. Trigger: agent developers requesting graduated responses.

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] Parallel citation resolution — requires significant reporter system mapping work. Defer until jurisdiction-specific formatting is a validated need.
- [ ] Statute/regulation verification — entirely separate pipeline. Only build if case citation verification proves the MCP-native model works.
- [ ] Good Law status — only feasible with paid API partnerships. Defer until revenue model exists.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Citation existence verification | HIGH | MEDIUM | P1 |
| Hard error on fake citations | HIGH | LOW | P1 |
| Citation normalization | HIGH | LOW | P1 |
| Case metadata return | HIGH | LOW | P1 |
| Quote integrity verification | HIGH | HIGH | P1 |
| SSE transport | HIGH | MEDIUM | P1 |
| Structured MCP responses | HIGH | LOW | P1 |
| Batch verification | HIGH | MEDIUM | P2 |
| Caching layer | MEDIUM | MEDIUM | P2 |
| Tiered confidence scoring | MEDIUM | LOW | P2 |
| Citation position indexing | MEDIUM | LOW | P2 |
| Parallel citation resolution | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | CiteCheck AI | Clearbrief | Travis-Prall CourtListener MCP | WestCheck (Westlaw) | LexCerta (Our Approach) |
|---------|-------------|------------|-------------------------------|--------------------|-----------------------|
| Citation parsing | GPT + OCR extraction | Proprietary | Eyecite-based | Proprietary | Eyecite (open source, 55M+ citations tested) |
| Existence check | CourtListener API | LexisNexis / Fastcase | CourtListener API | Westlaw database | CourtListener API (free, 10M citation database) |
| Quote verification | No | Yes (requires LexisNexis sub) | No | Yes (Quick Check) | Yes (CAP full-text, free, 6M+ opinions) |
| Good Law status | No | No | No | Yes (KeyCite) | No (explicitly out of scope) |
| Statute verification | No | Yes | Yes (eCFR tools) | Yes | No (explicitly out of scope) |
| Interface | Web upload | Word plugin | MCP server | Word plugin | MCP server |
| Batch support | Yes (document upload) | Yes (whole document) | Yes (`batch_lookup_citations`) | Yes (whole document) | v1.x (single citation first, batch after) |
| Normalization | Implicit | Yes | Yes (`verify_citation_format`) | Yes | Yes (West format canonical) |
| Pricing | Free (5 reports) / $25-100/mo | Subscription | Free (open source) | Westlaw subscription | Free / open source |
| Target user | Lawyers (manual upload) | Lawyers (Word users) | AI agents (MCP) | Lawyers (Word users) | AI agents (MCP) |

### Competitive Positioning

LexCerta's competitive moat is the combination of:
1. **MCP-native** — the only citation verification tool built for AI agents, not human Word users
2. **Quote integrity on free data** — Clearbrief requires LexisNexis; LexCerta uses CAP (free, 6M+ opinions)
3. **Honest about scope** — explicitly does not claim Good Law status, preventing false confidence

The closest competitor is Travis-Prall's CourtListener MCP, which already exposes `lookup_citation`, `batch_lookup_citations`, and `verify_citation_format`. LexCerta differentiates by adding quote integrity verification (CAP integration) and the tiered verification pipeline with explicit confidence levels. Travis-Prall's MCP is a general-purpose CourtListener/eCFR wrapper; LexCerta is purpose-built for the anti-hallucination use case.

## Sources

- [CourtListener Citation Lookup API announcement](https://free.law/2024/04/16/citation-lookup-api/) — API capabilities, response fields, rate limits (MEDIUM confidence)
- [Eyecite GitHub](https://github.com/freelawproject/eyecite) — Parser features, citation types, performance (HIGH confidence)
- [CiteCheck AI launch coverage](https://www.lawnext.com/2025/06/lawdroid-launches-citecheck-ai-a-fail-safe-against-ai-citation-hallucinations.html) — Competitor features, pricing, limitations (MEDIUM confidence)
- [Clearbrief Cite Check Report](https://www.lawnext.com/2025/12/clearbrief-launches-cite-check-report-to-give-law-firm-partners-an-audit-trail-against-ai-hallucinations.html) — Competitor feature set (MEDIUM confidence)
- [Travis-Prall CourtListener MCP](https://github.com/Travis-Prall/court-listener-mcp) — Closest MCP competitor, 20+ tools (MEDIUM confidence)
- [Stanford/Yale AI hallucination study](https://arxiv.org/abs/2405.20362) — 17-33% hallucination rate in commercial legal AI tools (HIGH confidence)
- [Caselaw Access Project](https://case.law/) — 6M+ opinions, 500/day full-text limit, OCR quality caveat (MEDIUM confidence)
- [CourtListener Semantic Search API](https://free.law/2025/11/05/semantic-search-api/) — New search capabilities (MEDIUM confidence)
- [LawNext citation checking directory](https://directory.lawnext.com/categories/citation-checking/) — Market landscape (LOW confidence)
- [Bluebook parallel citation rules](https://library.ju.edu/bluebook-citation/parallel-citations) — Rule 10.3.1 requirements (HIGH confidence)

---
*Feature research for: Legal citation verification MCP server*
*Researched: 2026-02-13*
