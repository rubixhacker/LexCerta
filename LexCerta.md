# LexCerta: Citation Verification MCP

> **Historical PRD.** The [product scope confirmed September 13, 2026](docs/product-scope.md) supersedes this brief's product promises and requirements. Its original text is preserved below for context; use the [domain glossary](CONTEXT.md) for current terminology.

**Product Requirements Document (PRD)**

---

## 1. Overview

**LexCerta** is an MCP-native (Model Context Protocol) service designed to eliminate "hallucinations" in AI-generated legal drafting. It acts as a verification layer that cross-references citations and quotes against the **West Case** (Thomson Reuters) reporter system using a hybrid "Source of Truth" model.

## 2. Target Architecture

* **Interface:** MCP Server (supporting Tools and Resources).
* **Language:** TypeScript / Node.js.
* **Deployment:** Vercel (Edge Functions) or Supabase (Edge Functions).
* **Transport:** SSE (Server-Sent Events) for remote agent connectivity.

---

## 3. The "Source of Truth" Strategy

To ensure 100% reliability, LexCerta utilizes a tiered lookup system:

1. **Tier 1 (Validation):** `Eyecite` (Open Source) for parsing West Reporter regex patterns.
2. **Tier 2 (Existence):** **CourtListener API** (Free Law Project) to verify volume/page mapping.
3. **Tier 3 (Verbatim Check):** **Caselaw Access Project (CAP)** for full-text quote verification.
4. **Tier 4 (Status - Future):** Westlaw/KeyCite API for checking "Good Law" status (Overruled/Abrogated).

---

## 4. Functional Requirements

### FR-1: MCP Tool `verify_west_citation`

* **Input:** String (e.g., "410 U.S. 113").
* **Process:**
* Parse string using West Reporter patterns.
* Query CourtListener/CAP to confirm existence.


* **Output:** * `valid`: Boolean
* `caseName`: Official Title
* `metadata`: Court, Date, Reporter Volume.
* `error`: Detailed "Hallucination Detected" message if not found.



### FR-2: MCP Tool `verify_quote_integrity`

* **Input:** `citation` (String), `quote` (String).
* **Process:** Fetch full-text corpus from CAP and perform fuzzy matching.
* **Output:** * `matchScore`: 0-100%.
* `officialText`: The actual text from the reporter for comparison.



### FR-3: Formatting & Normalization

* Automatically normalize malformed citations (e.g., "123 S. Ct 456" -> "123 S. Ct. 456") to ensure the agent uses standardized West format in final outputs.

---

## 5. Technical Specifications

### API Integrations

* **CourtListener:** `https://www.courtlistener.com/api/v3/citations/`
* **CAP:** `https://api.case.law/v1/cases/`

### Deployment Stack

* **Runtime:** Node.js 20+
* **Framework:** `@modelcontextprotocol/sdk`
* **Secrets Management:** * `COURTLISTENER_API_KEY`
* `CAP_API_KEY`



---

## 6. Implementation Notes for GSD Agent

* **SSE vs Stdio:** Since this is intended for Vercel/Supabase, prioritize the **SSE (Server-Sent Events)** transport over `stdio`. This allows the MCP server to be accessible over the web by agents like Context7 or Claude Desktop.
* **Caching:** Implement a simple Supabase/Redis cache for frequently cited cases (e.g., *Miranda v. Arizona*) to reduce API latency and cost.
* **Error States:** If the "Source of Truth" returns a 404, the MCP tool must return a hard error to the calling LLM to prevent it from "hallucinating" a justification for the fake case.

---

## 7. Success Metrics

* **Accuracy:** 100% detection of fake West citations.
* **Latency:** `< 1.5s` for existence checks; `< 3.0s` for full-text quote verification.

---
