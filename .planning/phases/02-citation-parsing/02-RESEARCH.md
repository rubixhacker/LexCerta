# Phase 2: Citation Parsing - Research

**Researched:** 2026-02-13
**Domain:** Legal citation parsing, West Reporter normalization, regex-based extraction
**Confidence:** HIGH

## Summary

Phase 2 adds a `parse_citation` MCP tool that accepts a citation string (e.g., "123 S. Ct. 456") and returns a structured object with volume, reporter, and page fields. The parser performs local normalization only -- CourtListener's citation-lookup API handles the heavy lifting of server-side Eyecite parsing in later phases. This phase builds a focused regex-based parser for the `volume + reporter + page` West Reporter format, with a reporter lookup table mapping common abbreviation variants to their canonical Bluebook forms.

The parser does NOT need to handle short-form citations (Id., supra, ibid.), text-block extraction, or non-West-Reporter citation types. It receives a single citation string as input, parses it, normalizes the reporter abbreviation, and returns a structured result or a clear error. This is a pure function with zero external dependencies -- fully unit-testable in isolation.

The existing codebase (Phase 1) establishes clear patterns: tools live in `src/tools/`, each tool is registered via a `register*Tool(server)` function, responses use the `createToolResponse` envelope from `src/types.ts`, and input validation is handled by Zod schemas passed to `server.registerTool()`. Phase 2 follows these patterns exactly, adding a `src/tools/parse-citation.ts` tool and a `src/parser/` module for the parsing logic.

**Primary recommendation:** Build a regex-based parser with a static reporter lookup table covering ~25 standard West Reporter abbreviations and their common variants. Use the Free Law Project's reporters-db as the authoritative reference for canonical forms and known variations. Keep the parser as a pure module (`src/parser/`) separate from the MCP tool registration (`src/tools/parse-citation.ts`).

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `zod` | ^3.25 | Input schema for `parse_citation` tool, output schema for parsed citation | Already in project. SDK peer dependency. Defines tool input validation. |
| `@modelcontextprotocol/sdk` | ^1.26.0 | Tool registration via `server.registerTool()` | Already in project. Phase 1 established pattern. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | ^4.0 | Unit tests for parser and normalization | All test files. Parser is pure functions -- ideal for unit testing. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-built regex parser | Eyecite (Python, via child process) | Eyecite handles 55M+ citation patterns including short-form. Overkill for Phase 2 which only needs volume+reporter+page. Python dependency adds complexity. CourtListener API uses Eyecite server-side in Phase 3. |
| Hand-built regex parser | `reporters-db` npm port | No official npm package exists. The JSON data from freelawproject/reporters-db is the reference, but importing the full 1,167-reporter database is unnecessary for Phase 2's ~25 West Reporter scope. |
| Static reporter lookup table | Dynamic loading from reporters-db JSON | Static table is simpler, testable, and sufficient for v1 scope (West Reporter citations only). Dynamic loading adds complexity without benefit until we need 1,000+ reporters. |

**Installation:**
```bash
# No new dependencies needed. Phase 1 already has everything required.
# zod, @modelcontextprotocol/sdk, vitest are all present.
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── parser/                  # NEW: Citation parsing module
│   ├── index.ts             # Main parse_citation function (public API)
│   ├── reporters.ts         # Reporter lookup table + normalization map
│   └── types.ts             # ParsedCitation type, CitationParseError type
├── tools/
│   ├── echo.ts              # Existing (Phase 1)
│   └── parse-citation.ts    # NEW: MCP tool registration for parse_citation
├── server.ts                # MODIFIED: Register parse_citation tool
├── types.ts                 # Existing: ToolResponseEnvelope (shared)
└── ...                      # Other Phase 1 files unchanged
```

### Pattern 1: Pure Parser Module (No MCP Dependency)
**What:** The parser module (`src/parser/`) is a pure TypeScript module with no dependency on the MCP SDK, Express, or any external service. It exports a single `parseCitation(input: string)` function that returns a `ParsedCitation` or throws/returns an error.
**When to use:** Always. This separation is called out explicitly in the architecture research as an anti-pattern to avoid (coupling parsing with verification).
**Confidence:** HIGH -- matches existing project architecture research and Phase 1 tool pattern

```typescript
// src/parser/types.ts
export interface ParsedCitation {
  volume: number;
  reporter: string;       // Canonical Bluebook form, e.g., "S. Ct."
  page: number;
  raw: string;            // Original input string
  normalized: string;     // Reconstructed normalized citation, e.g., "123 S. Ct. 456"
}

export interface CitationParseError {
  code: "PARSE_ERROR";
  message: string;
  input: string;
}

export type ParseResult =
  | { ok: true; citation: ParsedCitation }
  | { ok: false; error: CitationParseError };
```

```typescript
// src/parser/index.ts
export function parseCitation(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: { code: "PARSE_ERROR", message: "Empty input", input } };
  }

  // Try to match volume + reporter + page pattern
  const match = matchCitation(trimmed);
  if (!match) {
    return {
      ok: false,
      error: {
        code: "PARSE_ERROR",
        message: `Could not parse "${trimmed}" as a legal citation. Expected format: <volume> <reporter> <page> (e.g., "347 U.S. 483")`,
        input: trimmed,
      },
    };
  }

  return { ok: true, citation: match };
}
```

### Pattern 2: Reporter Lookup Table with Variation Mapping
**What:** A static `Map<string, string>` that maps every known variant of a reporter abbreviation to its canonical Bluebook form. The key is a normalized form of the variant (lowercased, periods/spaces stripped) and the value is the canonical abbreviation.
**When to use:** During the normalization step after regex extraction. The regex captures the reporter string, which is then looked up in this table.
**Confidence:** HIGH -- this is the standard approach used by eyecite and the reporters-db project

```typescript
// src/parser/reporters.ts

// Canonical reporter abbreviations (Bluebook standard)
// Key: lookup key (lowercase, no periods, no extra spaces)
// Value: canonical form
const REPORTER_VARIANTS: Record<string, string> = {
  // U.S. Reports (Supreme Court)
  "us": "U.S.",
  "u s": "U.S.",

  // Supreme Court Reporter
  "s ct": "S. Ct.",
  "sct": "S. Ct.",

  // Lawyers' Edition
  "l ed": "L. Ed.",
  "led": "L. Ed.",
  "l ed 2d": "L. Ed. 2d",
  "led 2d": "L. Ed. 2d",
  "led2d": "L. Ed. 2d",

  // Federal Reporter
  "f": "F.",
  "f 2d": "F.2d",
  "f2d": "F.2d",
  "f 3d": "F.3d",
  "f3d": "F.3d",
  "f 4th": "F.4th",
  "f4th": "F.4th",

  // Federal Supplement
  "f supp": "F. Supp.",
  "fsupp": "F. Supp.",
  "f supp 2d": "F. Supp. 2d",
  "fsupp2d": "F. Supp. 2d",
  "f supp 3d": "F. Supp. 3d",
  "fsupp3d": "F. Supp. 3d",

  // Regional reporters (Atlantic)
  "a": "A.",
  "a 2d": "A.2d",
  "a2d": "A.2d",
  "a 3d": "A.3d",
  "a3d": "A.3d",

  // (and so on for N.E., N.W., P., S.E., S.W., So.)
};

export function normalizeReporter(raw: string): string | null {
  const key = raw.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  return REPORTER_VARIANTS[key] ?? null;
}
```

### Pattern 3: MCP Tool Following Phase 1 Pattern
**What:** The `parse_citation` tool follows the exact same registration pattern as the `echo` tool: a `registerParseCitationTool(server)` function that calls `server.registerTool()` with a Zod schema, delegates to the parser module, and wraps the result in `createToolResponse()`.
**When to use:** Always. Consistency with Phase 1 is critical.
**Confidence:** HIGH -- directly follows existing `src/tools/echo.ts` pattern

```typescript
// src/tools/parse-citation.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseCitation } from "../parser/index.js";
import { createToolResponse } from "../types.js";

export function registerParseCitationTool(server: McpServer): void {
  server.registerTool(
    "parse_citation",
    {
      description: "Parse a legal citation string into a structured object with volume, reporter, and page. Normalizes common West Reporter format variants.",
      inputSchema: {
        citation: z.string().min(1).describe("Legal citation string to parse, e.g., '347 U.S. 483'"),
      },
    },
    async ({ citation }) => {
      const result = parseCitation(citation);
      if (result.ok) {
        return createToolResponse({
          valid: true,
          metadata: {
            volume: result.citation.volume,
            reporter: result.citation.reporter,
            page: result.citation.page,
            normalized: result.citation.normalized,
          },
          error: null,
        });
      }
      return createToolResponse({
        valid: false,
        metadata: null,
        error: {
          code: result.error.code,
          message: result.error.message,
        },
      });
    },
  );
}
```

### Anti-Patterns to Avoid
- **Coupling parser to MCP SDK:** The parser module must NOT import anything from `@modelcontextprotocol/sdk`. It is a pure function module. The MCP tool in `src/tools/` bridges between the SDK and the parser.
- **Over-engineering the regex:** Phase 2 parses single citation strings, not blocks of text. Do not build a text scanner or tokenizer. A single regex pattern that matches `<number> <reporter_string> <number>` is sufficient.
- **Hardcoding reporter strings in regex:** The regex should capture the reporter portion generically (non-digit characters between two numbers), then look it up in the reporter table. This avoids giant alternation groups in the regex and makes adding reporters trivial.
- **Returning raw regex match without normalization:** The tool MUST normalize. "123 S Ct 456" must return `reporter: "S. Ct."`, not `reporter: "S Ct"`. The normalization step is the core value of this phase.
- **Silently ignoring unrecognized reporters:** If the regex matches a volume+text+page pattern but the reporter string is not in the lookup table, return a clear error stating the reporter was not recognized, not a silent failure.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Full citation extraction from text blocks | Text scanner/tokenizer | CourtListener citation-lookup API (Phase 3) | CourtListener uses Eyecite with 55M+ citation patterns. Local extraction will miss edge cases. Phase 2 only parses individual citation strings. |
| Complete reporter database | Scrape Bluebook tables | Reference `freelawproject/reporters-db` | Free Law Project has 1,167 reporters and 2,102 variations. Use as authoritative source for building the lookup table. |
| Citation format validation | Custom validation rules | Zod schema + parser return type | Zod handles input string validation. Parser's `ParseResult` discriminated union handles parse success/failure cleanly. |

**Key insight:** Phase 2 is deliberately narrow. It normalizes a single citation string that the user already knows is a citation. The heavy-duty extraction and verification happens in Phase 3 via CourtListener. Keep the parser simple and focused.

## Common Pitfalls

### Pitfall 1: Bluebook Spacing Rules Are Subtle
**What goes wrong:** Reporter abbreviations have specific spacing rules that are easy to get wrong. "F.3d" has no space (single capital + ordinal). "F. Supp." has a space (abbreviation with multiple letters). "S. Ct." has a space (single capital + multi-letter abbreviation). Getting these wrong means normalized output does not match canonical forms.
**Why it happens:** The rules feel arbitrary: "U.S." (no space between single capitals), "S. Ct." (space between single capital and multi-letter), "F.2d" (no space between single capital and ordinal), "F. Supp. 2d" (spaces between multi-letter abbreviation and ordinal).
**How to avoid:** Define canonical forms in the reporter lookup table exactly as they appear in the Bluebook. The normalizer returns the canonical form verbatim -- it never constructs spacing from rules.
**Warning signs:** Test "123 F. Supp. 2d 456" and "123 F.3d 456" -- if spacing is wrong in either output, the rule implementation is broken.

### Pitfall 2: Period-Insensitive Matching Creates False Positives
**What goes wrong:** Stripping all periods for lookup makes "A" (Atlantic Reporter) match against bare letter "A" in non-citation contexts. Similarly, "F" could match random text.
**Why it happens:** Over-aggressive normalization.
**How to avoid:** The regex must enforce the `<number> <text> <number>` structure FIRST, then normalize only the captured reporter portion. The volume and page numbers anchor the match and prevent false positives. Since Phase 2 receives a single citation string (not a text block), this is less risky, but the parser should still require the three-part structure.
**Warning signs:** `parseCitation("A")` returning a match instead of an error.

### Pitfall 3: Series Suffixes ("2d", "3d", "4th") Splitting From Reporter
**What goes wrong:** A naive regex splits "F.3d" into reporter="F." and treats "3d" as part of the page number, or splits "F. Supp. 2d" incorrectly.
**Why it happens:** The series suffix is part of the reporter abbreviation, not a separate field. But it looks like it could be a number (especially "2d" which starts with a digit).
**How to avoid:** The regex must capture the reporter + series as a single group. The pattern should greedily match the non-numeric middle portion, including trailing series indicators (2d, 3d, 4th). Then the lookup table handles the normalization of the combined string.
**Warning signs:** "123 F.3d 456" parsing with page=3 instead of page=456.

### Pitfall 4: Forgetting to Handle Pin Cites
**What goes wrong:** Real legal citations often include pin cites: "347 U.S. 483, 490" (page 483, specific reference to page 490). The parser chokes on the comma or includes "483, 490" as the page.
**Why it happens:** Phase 2 requirements say "volume + reporter + page" but real-world input includes pin cites.
**How to avoid:** Parse only volume, reporter, and starting page. Ignore everything after the starting page number (commas, additional page references, parenthetical court/year info). The regex should match `\d+` for the page and stop there.
**Warning signs:** "347 U.S. 483, 490" failing to parse or returning page=483490.

### Pitfall 5: Case-Sensitivity in Reporter Matching
**What goes wrong:** "123 s. ct. 456" (all lowercase) fails to parse because the lookup table only has uppercase forms.
**Why it happens:** Legal citations are usually capitalized, but LLM-generated text or informal input may not be.
**How to avoid:** Normalize the captured reporter text to lowercase before lookup. The lookup table keys are all lowercase.
**Warning signs:** "123 s ct 456" returns an error instead of matching "S. Ct."

## Code Examples

### Regex Pattern for Volume + Reporter + Page

```typescript
// Source: Derived from freelawproject/citation-regexes patterns, simplified for single-citation parsing
// The pattern captures three groups:
// 1. Volume (one or more digits)
// 2. Reporter (non-digit text in the middle, may include periods, spaces, ordinals)
// 3. Page (one or more digits)
//
// The reporter group is intentionally broad -- validation happens in the lookup step.

const CITATION_REGEX = /^(\d+)\s+(.+?)\s+(\d+)/;

function matchCitation(input: string): ParsedCitation | null {
  const match = input.match(CITATION_REGEX);
  if (!match) return null;

  const volume = parseInt(match[1], 10);
  const rawReporter = match[2].trim();
  const page = parseInt(match[3], 10);

  const reporter = normalizeReporter(rawReporter);
  if (!reporter) return null;

  return {
    volume,
    reporter,
    page,
    raw: input,
    normalized: `${volume} ${reporter} ${page}`,
  };
}
```

### Complete Reporter Lookup Table (West Reporter Scope)

```typescript
// Source: Canonical forms from Bluebook; variations from freelawproject/reporters-db
// This covers the reporters required by the success criteria plus the most common
// West Reporter System reporters that LLMs are likely to cite.

const REPORTER_MAP: Record<string, string> = {
  // === U.S. Supreme Court ===
  "us": "U.S.",
  "u s": "U.S.",

  "s ct": "S. Ct.",
  "sct": "S. Ct.",

  "l ed": "L. Ed.",
  "led": "L. Ed.",
  "l ed 2d": "L. Ed. 2d",
  "led 2d": "L. Ed. 2d",
  "led2d": "L. Ed. 2d",
  "l ed2d": "L. Ed. 2d",

  // === Federal Courts of Appeals ===
  "f": "F.",
  "f 2d": "F.2d",
  "f2d": "F.2d",
  "f 3d": "F.3d",
  "f3d": "F.3d",
  "f 4th": "F.4th",
  "f4th": "F.4th",

  // === Federal District Courts ===
  "f supp": "F. Supp.",
  "fsupp": "F. Supp.",
  "f supp 2d": "F. Supp. 2d",
  "fsupp 2d": "F. Supp. 2d",
  "fsupp2d": "F. Supp. 2d",
  "f supp 3d": "F. Supp. 3d",
  "fsupp 3d": "F. Supp. 3d",
  "fsupp3d": "F. Supp. 3d",

  // === Regional Reporters ===
  // Atlantic
  "a": "A.",
  "a 2d": "A.2d",
  "a2d": "A.2d",
  "a 3d": "A.3d",
  "a3d": "A.3d",

  // North Eastern
  "n e": "N.E.",
  "ne": "N.E.",
  "n e 2d": "N.E.2d",
  "ne 2d": "N.E.2d",
  "ne2d": "N.E.2d",
  "n e 3d": "N.E.3d",
  "ne 3d": "N.E.3d",
  "ne3d": "N.E.3d",

  // North Western
  "n w": "N.W.",
  "nw": "N.W.",
  "n w 2d": "N.W.2d",
  "nw 2d": "N.W.2d",
  "nw2d": "N.W.2d",

  // Pacific
  "p": "P.",
  "p 2d": "P.2d",
  "p2d": "P.2d",
  "p 3d": "P.3d",
  "p3d": "P.3d",

  // South Eastern
  "s e": "S.E.",
  "se": "S.E.",
  "s e 2d": "S.E.2d",
  "se 2d": "S.E.2d",
  "se2d": "S.E.2d",

  // South Western
  "s w": "S.W.",
  "sw": "S.W.",
  "s w 2d": "S.W.2d",
  "sw 2d": "S.W.2d",
  "sw2d": "S.W.2d",
  "s w 3d": "S.W.3d",
  "sw 3d": "S.W.3d",
  "sw3d": "S.W.3d",

  // Southern
  "so": "So.",
  "so 2d": "So. 2d",
  "so2d": "So. 2d",
  "so 3d": "So. 3d",
  "so3d": "So. 3d",
};
```

### Test Cases (Derived from Success Criteria)

```typescript
// Source: Phase 2 success criteria mapped to test assertions

describe("parse_citation", () => {
  // Success Criterion 1: Standard citation parsing
  it("parses '123 S. Ct. 456' into structured object", () => {
    const result = parseCitation("123 S. Ct. 456");
    expect(result).toEqual({
      ok: true,
      citation: {
        volume: 123,
        reporter: "S. Ct.",
        page: 456,
        raw: "123 S. Ct. 456",
        normalized: "123 S. Ct. 456",
      },
    });
  });

  // Success Criterion 2: Missing periods normalized
  it("normalizes '123 S Ct 456' to same result as '123 S. Ct. 456'", () => {
    const withPeriods = parseCitation("123 S. Ct. 456");
    const withoutPeriods = parseCitation("123 S Ct 456");
    expect(withoutPeriods).toEqual(withPeriods);
  });

  // Success Criterion 3: Gibberish rejection
  it("returns clear error for 'not a citation'", () => {
    const result = parseCitation("not a citation");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PARSE_ERROR");
      expect(result.error.message).toContain("Could not parse");
    }
  });

  // Success Criterion 4: All standard West Reporter abbreviations
  const standardReporters = [
    ["347 U.S. 483", "U.S."],
    ["123 S. Ct. 456", "S. Ct."],
    ["100 L. Ed. 2d 200", "L. Ed. 2d"],
    ["500 F.2d 100", "F.2d"],
    ["300 F.3d 200", "F.3d"],
    ["50 F.4th 100", "F.4th"],
    ["200 F. Supp. 100", "F. Supp."],
    ["150 F. Supp. 2d 300", "F. Supp. 2d"],
  ];
  it.each(standardReporters)("recognizes %s as reporter %s", (input, expectedReporter) => {
    const result = parseCitation(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.citation.reporter).toBe(expectedReporter);
    }
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Eyecite as local Python dependency | CourtListener API handles Eyecite server-side; local parser for normalization only | Project decision (2026-02-13) | Eliminates Python dependency; keeps TS project pure. Parser scope is much narrower. |
| Building regex from scratch | Reference freelawproject/citation-regexes and reporters-db | Ongoing (reporters-db v3.2.32, 1,167 reporters) | Authoritative source for reporter variations. Don't reinvent. |
| CAP API for citation data | CourtListener is sole data source | CAP shut down Sept 2024 | All CAP data migrated to CourtListener. Single API to target. |
| Complex alternation regex per reporter | Generic capture + lookup table normalization | Pattern evolution in eyecite | Lookup table is easier to maintain and extend than giant regex alternations. |

**Deprecated/outdated:**
- CAP API: Shut down September 2024. All data migrated to CourtListener.
- Eyecite as local dependency for Phase 2: Overkill. CourtListener uses Eyecite server-side.
- Building custom reporter abbreviation tables from scratch: Use reporters-db as reference.

## Open Questions

1. **Pin cite handling scope**
   - What we know: Real citations often include pin cites ("347 U.S. 483, 490") and parenthetical year/court info ("347 U.S. 483 (1954)"). Phase 2 requirements specify only volume+reporter+page.
   - What's unclear: Should the parser strip pin cites and parentheticals gracefully, or reject them? The success criteria only test the basic three-part format.
   - Recommendation: Parse and return the starting page number. Ignore everything after the page number (commas, parentheticals). This makes the parser more forgiving without adding complexity. LOW risk.

2. **Regional reporter coverage completeness**
   - What we know: The success criteria say "all standard West Reporter abbreviations." The reporter lookup table above covers ~25 reporters. The reporters-db has 1,167.
   - What's unclear: How many reporters constitute "standard West Reporter" scope? The federal reporters (U.S., S. Ct., L. Ed., F., F. Supp.) and 7 regional reporters (A., N.E., N.W., P., S.E., S.W., So.) cover the vast majority of LLM-generated citations.
   - Recommendation: Start with the ~25 reporters listed in the code example above. These cover all federal reporters and all regional reporters. State-specific reporters (Cal. Rptr., N.Y.S., etc.) can be added later. MEDIUM risk -- an LLM might cite a state reporter.

3. **Regex greedy vs. lazy matching for reporter capture**
   - What we know: The reporter portion sits between two numbers. A lazy match (`(.+?)`) captures the minimum text. A greedy match captures too much.
   - What's unclear: Edge cases where lazy matching fails, e.g., "100 F. Supp. 2d 300" where "2d" contains a digit that could be confused with the page number.
   - Recommendation: Use a lazy match but ensure the page capture anchors on the LAST number group. May need to refine the regex to handle series suffixes like "2d", "3d", "4th" that start with digits. Test thoroughly with F. Supp. 2d and L. Ed. 2d cases. MEDIUM risk.

## Sources

### Primary (HIGH confidence)
- [freelawproject/reporters-db](https://github.com/freelawproject/reporters-db) -- Authoritative database of 1,167 reporters and 2,102 variations. Used as reference for canonical forms and known variants.
- [freelawproject/citation-regexes](https://github.com/freelawproject/citation-regexes) -- JavaScript regex patterns for US legal citations. Reference implementation for volume+reporter+page matching.
- [CourtListener Citation Lookup API](https://free.law/2024/04/16/citation-lookup-api/) -- Documents normalized_citations field behavior, confirming CourtListener handles server-side normalization.
- Existing codebase: `src/tools/echo.ts`, `src/types.ts`, `src/server.ts` -- Phase 1 patterns for tool registration and response envelope.

### Secondary (MEDIUM confidence)
- [Bluebook spacing rules (Georgetown Law)](https://guides.ll.georgetown.edu/c.php?g=261289&p=2339383) -- Spacing rules for reporter abbreviations: no space between single capitals, space between single capital and multi-letter abbreviation.
- [Texas A&M Legal Case Citation Format guide](https://law.tamu.libguides.com/c.php?g=513860&p=3510990) -- Reference for standard reporter abbreviation list.
- [eyecite whitepaper](https://free.law/pdf/eyecite-whitepaper.pdf) -- Architecture of the canonical citation parser. Confirms regex-based approach with reporter lookup normalization.
- [mlissner citation regex gist](https://gist.github.com/mlissner/dda7f6677b98b98f54522e271d486781) -- Original regex patterns for US legal citations (Jureeka project).

### Tertiary (LOW confidence)
- Bluebook spacing rules inferred from multiple library guides rather than direct Bluebook source (Bluebook is behind paywall).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- No new dependencies. Follows Phase 1 patterns exactly.
- Architecture: HIGH -- Pure parser module + MCP tool follows established codebase pattern. Reporter lookup table approach verified across multiple authoritative sources.
- Pitfalls: HIGH -- Spacing rules, series suffix handling, and regex edge cases documented from multiple sources.
- Reporter coverage: MEDIUM -- ~25 reporters covers the "standard West" scope per success criteria. Edge cases with state-specific reporters are possible.
- Regex pattern: MEDIUM -- Basic pattern is straightforward. Series suffix edge cases (F. Supp. 2d, L. Ed. 2d) need careful testing.

**Research date:** 2026-02-13
**Valid until:** 2026-06-13 (reporter abbreviations are stable; reporters-db updates are additive)
