# LexCerta

## What This Is

LexCerta is an MCP-native (Model Context Protocol) server that eliminates hallucinated legal citations in AI-generated legal drafting. It acts as a verification layer that cross-references citations and quotes against the West Case reporter system using a tiered "Source of Truth" lookup model. Built for legal AI agents and tools like Claude Desktop.

## Core Value

Every legal citation returned by the system is verified against authoritative sources — no hallucinated cases pass through.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] MCP tool to verify West Reporter citations against CourtListener/CAP
- [ ] MCP tool to verify quote integrity via full-text fuzzy matching
- [ ] Citation formatting and normalization to standard West format
- [ ] SSE transport for remote agent connectivity
- [ ] Caching layer for frequently cited cases
- [ ] Hard error responses for unverifiable citations

### Out of Scope

- Westlaw/KeyCite "Good Law" status checking — future tier, requires paid API access
- Mobile or web UI — MCP server only, consumed by AI agents
- OAuth/user authentication — tool-level access only via API keys

## Context

- Uses tiered verification: Eyecite (parsing) → CourtListener (existence) → CAP (full-text)
- CourtListener API: `https://www.courtlistener.com/api/v3/citations/`
- CAP API: `https://api.case.law/v1/cases/`
- Target deployment: Vercel or Supabase Edge Functions
- Performance targets: <1.5s existence checks, <3.0s quote verification
- Accuracy target: 100% detection of fake West citations

## Constraints

- **Tech stack**: TypeScript / Node.js with `@modelcontextprotocol/sdk`
- **Runtime**: Node.js 20+
- **Transport**: SSE (Server-Sent Events) prioritized over stdio
- **Secrets**: Requires `COURTLISTENER_API_KEY` and `CAP_API_KEY`
- **Deployment**: Vercel Edge Functions or Supabase Edge Functions

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| SSE over stdio transport | Remote agent connectivity for web-deployed MCP servers | — Pending |
| Tiered verification (Eyecite → CourtListener → CAP) | Layered confidence — parse first, verify existence, then full-text | — Pending |
| TypeScript/Node.js | MCP SDK is TypeScript-native, best ecosystem support | — Pending |

---
*Last updated: 2026-02-13 after initialization*
