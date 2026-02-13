# Phase 5: Quote Verification - Research

**Researched:** 2026-02-13
**Domain:** Fuzzy string matching, CourtListener opinion text retrieval, MCP tool design
**Confidence:** MEDIUM

## Summary

Quote verification requires two capabilities the system does not yet have: (1) fetching the full text of a court opinion from CourtListener, and (2) performing fuzzy substring matching between a user-submitted quote and that full text. The existing codebase already verifies that a citation exists (Phase 3) and caches lookup results (Phase 4), so the new `verify_quote_integrity` tool can reuse the citation-verification pipeline to confirm the citation exists before fetching opinion text.

The CourtListener API v4 exposes opinion full text via `GET /api/rest/v4/opinions/{id}/`, returning fields including `plain_text`, `html`, `html_with_citations`, `xml_harvard`, and others. The path from citation to text is: citation-lookup returns clusters, each cluster has an `absolute_url` (e.g., `/opinion/12345/`), and each cluster contains sub-opinions accessible via the opinions endpoint. The `plain_text` field is the most suitable for quote matching since it strips HTML/formatting.

For fuzzy matching, `fuzzball` (JavaScript port of Python's fuzzywuzzy/TheFuzz) is the right tool. Its `partial_ratio` function finds the highest-scoring substring of the longer string vs. the shorter string, which is exactly the "does this quote appear in this opinion" operation. It returns a 0-100 score directly usable as the match percentage required by QUOTE-02.

**Primary recommendation:** Add a `fetchOpinionText` method to `CourtListenerClient`, use `fuzzball.partial_ratio` for fuzzy matching, and build a new `verify_quote_integrity` MCP tool that first calls `verify_west_citation` logic to confirm the citation exists, then fetches opinion text, then runs fuzzy matching.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fuzzball | ^2.0 | Fuzzy string matching (partial_ratio, token_sort_ratio) | Most complete JS port of fuzzywuzzy; provides partial_ratio for substring matching which is exactly the "find quote in opinion" operation; returns 0-100 scores |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (already installed) lru-cache | ^11.2.6 | Cache opinion full text to avoid re-fetching | When the same opinion is checked for multiple quotes |
| (already installed) zod | ^3.25 | Input validation for the new tool | Tool parameter schemas |
| (already installed) cockatiel | ^3.2.1 | Circuit breaker/retry for opinion fetch calls | Reuse existing `courtListenerPolicy` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| fuzzball | fastest-levenshtein | Only computes raw edit distance, no partial_ratio or 0-100 scoring; would require manual substring sliding window |
| fuzzball | Fuse.js | Designed for search/indexing, not pairwise string comparison; overkill and wrong abstraction |
| fuzzball | string-similarity (Dice coefficient) | No substring/partial matching; compares whole strings only |
| fuzzball | Hand-rolled Levenshtein + sliding window | Reinventing what fuzzball already provides; error-prone normalization edge cases |

**Installation:**
```bash
npm install fuzzball
```

Note: fuzzball ships its own types. If types are missing, `@types/fuzzball` may be needed but should not be necessary for v2.x.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── clients/
│   └── courtlistener.ts       # ADD: fetchOpinionText() method
├── tools/
│   ├── verify-citation.ts     # EXISTING: citation verification
│   └── verify-quote.ts        # NEW: quote verification tool
├── matching/
│   └── fuzzy-match.ts         # NEW: fuzzy matching logic (pure function, testable)
├── cache/
│   └── citation-cache.ts      # EXISTING: may extend for opinion text caching
│   └── opinion-text-cache.ts  # NEW: separate cache for full opinion text (larger payloads)
└── server.ts                  # ADD: register verify_quote_integrity tool
```

### Pattern 1: Two-Phase Verification (Citation First, Then Quote)
**What:** The quote verification tool first confirms the citation exists using the existing citation-lookup pipeline, then fetches full opinion text, then performs fuzzy matching.
**When to use:** Always -- QUOTE-04 requires confirming citation exists before fetching text.
**Why:** Avoids expensive opinion text fetch for fabricated citations. Reuses cached citation lookups from Phase 4.

```typescript
// Pseudocode for the tool handler
async function verifyQuoteIntegrity({ citation, text }: { citation: string; text: string }) {
  // Step 1: Verify citation exists (reuse Phase 3 logic)
  const citationResult = await verifyCitationExists(citation);
  if (!citationResult.found) {
    return { error: "CITATION_NOT_FOUND", ... };
  }

  // Step 2: Fetch opinion full text
  const opinionText = await fetchOpinionText(citationResult.clusterId);
  if (!opinionText) {
    return { error: "TEXT_UNAVAILABLE", ... };
  }

  // Step 3: Fuzzy match
  const matchResult = fuzzyMatch(text, opinionText);
  return {
    matchScore: matchResult.score,
    bestMatch: matchResult.bestMatchText,
    ...
  };
}
```

### Pattern 2: Separate Fuzzy Matching Module (Pure Functions)
**What:** Keep fuzzy matching logic in its own module with pure functions, separate from the MCP tool handler.
**When to use:** Always -- enables unit testing without mocking MCP infrastructure.

```typescript
// src/matching/fuzzy-match.ts
import fuzzball from "fuzzball";

export interface MatchResult {
  score: number;        // 0-100
  bestMatch: string;    // The actual text from the opinion that best matches
  matchType: "exact" | "fuzzy" | "no_match";
}

export function matchQuoteInOpinion(quote: string, opinionText: string): MatchResult {
  // Normalize whitespace
  const normalizedQuote = normalizeText(quote);
  const normalizedOpinion = normalizeText(opinionText);

  const score = fuzzball.partial_ratio(normalizedQuote, normalizedOpinion);
  // ... extract best matching substring, classify result
}

function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, " ")       // collapse whitespace
    .replace(/[""]/g, '"')       // normalize smart quotes
    .replace(/['']/g, "'")       // normalize smart apostrophes
    .replace(/\u00A0/g, " ")     // non-breaking spaces
    .trim();
}
```

### Pattern 3: Separate Opinion Text Cache
**What:** Use a separate LRU cache for opinion full text, distinct from citation-lookup cache.
**When to use:** Always -- opinion text is much larger (potentially 100KB+ per entry) and has different access patterns.
**Why:** The citation cache stores small metadata (~1KB). Mixing in large text blobs would evict many citation entries. A separate cache with a smaller max entries count prevents memory bloat.

### Pattern 4: CourtListener API Chain (Citation -> Cluster -> Opinions -> Text)
**What:** The path from a user's citation to opinion text requires multiple API calls.
**When to use:** Understanding the data flow.

```
1. citation-lookup POST (already exists in Phase 3)
   Returns: matches[].clusters[].absolute_url (e.g., "/opinion/12345/brown-v-board/")

2. GET /api/rest/v4/clusters/{cluster_id}/
   Returns: sub_opinions[] (array of opinion URLs/IDs)
   NOTE: A cluster may contain multiple opinions (majority, dissent, concurrence)

3. GET /api/rest/v4/opinions/{opinion_id}/
   Returns: { plain_text, html, html_with_citations, xml_harvard, type, ... }
   The `plain_text` field is the primary target for quote matching
   The `type` field indicates: "lead opinion", "dissent", "concurrence", etc.
```

**Important:** We need to search across ALL sub-opinions in the cluster, not just the lead opinion, because a user might quote from a dissent or concurrence.

### Anti-Patterns to Avoid
- **Matching against HTML:** Never fuzzy-match against `html` or `html_with_citations` fields -- HTML tags would corrupt matching. Always use `plain_text` or strip HTML first.
- **Single opinion assumption:** A cluster can have multiple opinions (majority, dissent, concurrence). Search all of them.
- **Blocking on large text fetch:** Opinion text can be large. The opinion text fetch should go through the existing circuit breaker and rate limiter.
- **Mixing cache pools:** Don't store opinion text in the citation cache. They have different sizes and eviction characteristics.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Fuzzy substring matching | Custom Levenshtein + sliding window | `fuzzball.partial_ratio()` | Handles normalization, efficient substring comparison, returns 0-100 score; battle-tested Python port |
| Text normalization (smart quotes, etc.) | Per-case character replacement | Centralized `normalizeText()` utility | Legal text has many Unicode variants; centralizing prevents inconsistent normalization |
| HTML stripping (if plain_text is empty) | Regex-based HTML stripping | `plain_text` field first; if empty, consider a simple HTML-to-text utility | HTML stripping with regex is notoriously unreliable |

**Key insight:** The core complexity is in the API chain (citation -> cluster -> opinions -> text), not in the fuzzy matching itself. fuzzball's `partial_ratio` does exactly what we need out of the box. The planning effort should focus on the multi-step API integration and error handling, not on matching algorithms.

## Common Pitfalls

### Pitfall 1: Empty plain_text Field
**What goes wrong:** Some opinions in CourtListener have empty `plain_text` but have content in `html`, `html_lawbox`, `xml_harvard`, or `html_columbia`.
**Why it happens:** CourtListener aggregates from multiple sources. Some sources provide only HTML or XML.
**How to avoid:** Implement a text extraction fallback chain: `plain_text` -> strip HTML from `html` -> strip HTML from `html_with_citations` -> parse `xml_harvard`. Document this in the response when fallback is used.
**Warning signs:** Empty string returned from `plain_text` for a known-existing opinion.

### Pitfall 2: Cluster with Multiple Opinions
**What goes wrong:** User quotes from a dissenting opinion but code only checks the lead opinion. Quote returns "not found" falsely.
**Why it happens:** Each cluster can contain multiple opinions (majority, dissent, concurrence, etc.). The `type` field on each opinion indicates which it is.
**How to avoid:** Fetch ALL opinions in the cluster and run fuzzy matching against each. Return the best match with metadata about which opinion it came from.
**Warning signs:** Low match scores for quotes that are clearly from the case.

### Pitfall 3: Rate Limiting on Multi-Step API Calls
**What goes wrong:** Quote verification requires 2-3 API calls (citation lookup + cluster fetch + opinion fetch). This burns through rate limits faster than citation-only verification.
**Why it happens:** Each API call to CourtListener counts against the 5,000/day rate limit.
**How to avoid:** Cache aggressively -- opinion text is immutable (same as citations). Cache the full text keyed by opinion ID. Consider fetching all sub-opinions in a single cluster request if the API supports it.
**Warning signs:** Rate limit errors during quote verification but not during citation verification.

### Pitfall 4: Fuzzy Matching Threshold Ambiguity
**What goes wrong:** Score of 75% -- is this a match or not? Users get confused or the tool gives incorrect pass/fail signals.
**Why it happens:** Prior decision notes "fuzzy matching thresholds need experimentation." There is no universally correct threshold.
**How to avoid:** Return the raw score (0-100) AND the best-matching text from the opinion. Let the consumer (LLM) interpret the score with context. Suggest classification tiers in the response: HIGH (90+), MEDIUM (70-89), LOW (<70). Do NOT hard-code a binary pass/fail -- return the score and let the caller decide.
**Warning signs:** Debates about threshold values during implementation.

### Pitfall 5: Text Normalization Differences
**What goes wrong:** A verbatim quote from a PDF gets a score of 80% instead of 95%+ because of formatting differences.
**Why it happens:** Legal PDFs use smart quotes, em-dashes, non-breaking spaces, ligatures, and other Unicode characters that differ from plain-text representations.
**How to avoid:** Normalize both the quote and opinion text before matching: collapse whitespace, normalize quotation marks, normalize dashes (em-dash, en-dash -> hyphen), strip section symbols, etc.
**Warning signs:** Scores below 90% for quotes copy-pasted directly from opinion PDFs.

### Pitfall 6: Very Short Quotes Produce False Positives
**What goes wrong:** A 3-word quote matches at 100% because those words appear somewhere in a 50-page opinion.
**Why it happens:** `partial_ratio` finds the best substring match. Short substrings are likely to match somewhere in a large document.
**How to avoid:** Consider minimum quote length validation (e.g., 20 characters). For very short quotes, warn the caller that the match may be unreliable. Optionally use `token_sort_ratio` as a secondary check.
**Warning signs:** 100% scores on very short, common legal phrases.

## Code Examples

### Fetching Opinion Text from CourtListener

```typescript
// Source: CourtListener API v4 documentation + research
// Added to src/clients/courtlistener.ts

export interface OpinionText {
  opinionId: number;
  type: string;  // "010combined", "015unananimous", "020lead", "030concurrence", "040dissent", etc.
  plainText: string;
  clusterId: number;
}

export type OpinionTextResponse =
  | { status: "ok"; opinions: OpinionText[] }
  | { status: "rate_limited"; retryAfterMs: number }
  | { status: "error"; code: string; message: string }
  | { status: "not_found" };

// Fetch all opinions for a cluster
async fetchClusterOpinions(clusterId: number): Promise<OpinionTextResponse> {
  if (!this.rateLimiter.tryConsume()) {
    return { status: "rate_limited", retryAfterMs: this.rateLimiter.msUntilNextToken() };
  }

  try {
    const result = await this.policy.execute(async ({ signal }) => {
      // Step 1: Get cluster to find sub_opinions
      const clusterRes = await fetch(
        `${this.baseUrl}/clusters/${clusterId}/`,
        {
          headers: { Authorization: `Token ${this.apiKey}` },
          signal,
        }
      );

      if (clusterRes.status === 429) {
        const retryAfter = clusterRes.headers.get("Retry-After");
        throw new RateLimitError(retryAfter ? parseInt(retryAfter) * 1000 : 60_000);
      }
      if (clusterRes.status === 404) return null;
      if (clusterRes.status >= 500) throw new ApiError(clusterRes.status, "Server error");

      const cluster = await clusterRes.json();
      // cluster.sub_opinions is an array of opinion URLs

      // Step 2: Fetch each opinion's text
      const opinions: OpinionText[] = [];
      for (const opinionUrl of cluster.sub_opinions) {
        // Each sub_opinion is a full URL like "https://www.courtlistener.com/api/rest/v4/opinions/12345/"
        const opRes = await fetch(opinionUrl, {
          headers: { Authorization: `Token ${this.apiKey}` },
          signal,
        });
        if (opRes.ok) {
          const op = await opRes.json();
          const plainText = op.plain_text || stripHtml(op.html) || "";
          if (plainText) {
            opinions.push({
              opinionId: op.id,
              type: op.type,
              plainText,
              clusterId,
            });
          }
        }
      }
      return opinions;
    });

    if (result === null) return { status: "not_found" };
    return { status: "ok", opinions: result };
  } catch (err) {
    if (err instanceof RateLimitError) {
      return { status: "rate_limited", retryAfterMs: err.retryAfterMs };
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: "error", code: "API_ERROR", message };
  }
}
```

### Fuzzy Matching a Quote Against Opinion Text

```typescript
// Source: fuzzball documentation (https://github.com/nol13/fuzzball.js)
// src/matching/fuzzy-match.ts

import fuzzball from "fuzzball";

export interface MatchResult {
  score: number;            // 0-100
  matchedOpinionType: string;
  bestMatchExcerpt: string; // The best-matching substring from the opinion
  classification: "high" | "medium" | "low";
}

export function normalizeText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")  // smart single quotes
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')   // smart double quotes
    .replace(/[\u2013\u2014]/g, "-")                // em/en dashes
    .replace(/\u00A0/g, " ")                        // non-breaking space
    .replace(/\s+/g, " ")                           // collapse whitespace
    .trim();
}

export function matchQuoteInOpinion(
  quote: string,
  opinionText: string
): { score: number; classification: "high" | "medium" | "low" } {
  const normQuote = normalizeText(quote);
  const normOpinion = normalizeText(opinionText);

  const score = fuzzball.partial_ratio(normQuote, normOpinion);

  const classification =
    score >= 90 ? "high" :
    score >= 70 ? "medium" :
    "low";

  return { score, classification };
}
```

### Extracting Best-Match Excerpt

```typescript
// To provide QUOTE-03 (return actual text from opinion for comparison),
// use partial_ratio's internal alignment or a sliding window approach:

export function extractBestExcerpt(
  quote: string,
  opinionText: string,
  contextChars = 50
): string {
  const normQuote = normalizeText(quote);
  const normOpinion = normalizeText(opinionText);

  // Use fuzzball.extract to find the best matching window
  // Or implement a simple sliding window:
  const quoteLen = normQuote.length;
  let bestScore = 0;
  let bestStart = 0;

  for (let i = 0; i <= normOpinion.length - quoteLen; i++) {
    const window = normOpinion.substring(i, i + quoteLen);
    const score = fuzzball.ratio(normQuote, window);
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  // Return the best matching region with context
  const start = Math.max(0, bestStart - contextChars);
  const end = Math.min(normOpinion.length, bestStart + quoteLen + contextChars);
  return normOpinion.substring(start, end);
}
```

**Performance note:** The sliding window approach above is O(n*m) where n is opinion length and m is quote length. For typical opinions (10-100K chars) and quotes (50-500 chars), this is fast enough. If performance becomes an issue, consider using fuzzball's internal extractBests function or limiting the search window.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| CourtListener v3 API | CourtListener v4 API | 2023 | v3 no longer available to new users; must use v4 |
| CAP (Caselaw Access Project) for text | CourtListener only | Sept 2024 (CAP shut down) | CourtListener is now the sole free API for court opinion text |
| fuzzywuzzy (Python) | fuzzball.js (JavaScript port) | Ongoing | Same algorithms, JS-native implementation |
| Exact string matching for quotes | Fuzzy matching (Levenshtein-based) | Standard practice | Handles OCR artifacts, formatting differences, minor transcription errors |

**Deprecated/outdated:**
- CAP API: Shut down September 2024. Do not reference or plan fallback to CAP.
- CourtListener v3: New users cannot access v3. All endpoints must use v4 (`/api/rest/v4/`).

## Open Questions

1. **CourtListener cluster-to-opinion API call count**
   - What we know: Need citation-lookup (1 call) + cluster fetch (1 call) + N opinion fetches. Clusters can have 1-5+ opinions.
   - What's unclear: Does the cluster endpoint embed opinion text directly, or does it only return opinion IDs/URLs requiring separate fetches? Can we request specific fields to minimize payload?
   - Recommendation: During implementation, test the cluster endpoint response to see if `sub_opinions` includes text or just references. Use `?fields=` parameter if available to minimize payload. **Validate during implementation.**
   - Confidence: LOW -- API documentation is sparse; needs live testing.

2. **fuzzball partial_ratio performance on large texts**
   - What we know: partial_ratio uses a sliding window internally. Opinions can be very long (100K+ characters).
   - What's unclear: Is partial_ratio efficient enough for 500-char quotes against 100K-char opinions? Or do we need to pre-segment the opinion?
   - Recommendation: Benchmark during implementation. If slow, consider breaking opinion text into paragraphs and matching against each paragraph separately.
   - Confidence: MEDIUM -- fuzzball is widely used, but large-text performance is undocumented.

3. **Opinion text availability coverage**
   - What we know: `plain_text` is the preferred field. Some opinions only have HTML or XML.
   - What's unclear: What percentage of opinions have `plain_text`? How reliable is HTML-to-text conversion for matching?
   - Recommendation: Implement fallback chain (plain_text -> strip HTML -> parse XML). Log which fallback was used. Accept that some opinions may have no extractable text and return an appropriate error.
   - Confidence: MEDIUM -- fallback chain is standard practice but coverage percentages are unknown.

4. **Extracting the best-matching excerpt for QUOTE-03**
   - What we know: QUOTE-03 requires returning "the actual text from the opinion for comparison." fuzzball.partial_ratio returns a score but not the matched substring position.
   - What's unclear: Best approach to extract the matching region from the opinion text.
   - Recommendation: Implement a sliding window that scans the opinion text with a window of quote-length, computing fuzzball.ratio for each window, and returning the highest-scoring window with surrounding context. This is O(n*m) but acceptable for typical sizes.
   - Confidence: MEDIUM -- the approach is sound but needs performance validation.

## Sources

### Primary (HIGH confidence)
- CourtListener citation-lookup API: https://free.law/2024/04/16/citation-lookup-api/ - Confirmed API structure, cluster return format
- CourtListener API v4 opinions fields: Confirmed via multiple sources that opinions endpoint returns `plain_text`, `html`, `html_with_citations`, `xml_harvard`, `type`, `cluster_id`
- CourtListener API v4 endpoints: https://www.courtlistener.com/api/rest/v4/ - Confirmed endpoints: opinions, clusters, dockets, search
- fuzzball.js documentation: https://github.com/nol13/fuzzball.js - Confirmed partial_ratio, token_sort_ratio, 0-100 scoring, preprocessing options

### Secondary (MEDIUM confidence)
- CourtListener cluster-to-opinion relationship: https://github.com/freelawproject/courtlistener/discussions/4950 - Confirmed `sub_opinions` relationship exists, `xml_harvard` contains full text
- CourtListener opinion text fields: https://github.com/freelawproject/courtlistener/discussions/3959 - Confirmed direct access via `/api/rest/v4/opinions/{id}/`
- fuzzball API details: https://snyk.io/advisor/npm-package/fuzzball/example - Confirmed partial_ratio finds best substring match

### Tertiary (LOW confidence)
- CourtListener cluster `sub_opinions` structure: Inferred from test code and discussions. Exact response shape needs live API validation.
- fuzzball performance on large texts: No benchmarks found. Needs implementation-time validation.

## Metadata

**Confidence breakdown:**
- Standard stack: MEDIUM - fuzzball is well-established for fuzzy matching but needs performance validation on large legal texts
- Architecture: MEDIUM - API chain (citation -> cluster -> opinions -> text) is confirmed but exact response shapes need live validation
- Pitfalls: HIGH - Common issues with empty plain_text, multi-opinion clusters, and normalization are well-documented in CourtListener community

**Research date:** 2026-02-13
**Valid until:** 2026-03-15 (30 days -- CourtListener API is stable; fuzzball is stable)
