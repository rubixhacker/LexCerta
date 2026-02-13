# LexCerta

## What This Is

LexCerta is an MCP-native (Model Context Protocol) server that eliminates hallucinated legal citations in AI-generated legal drafting. It verifies West Reporter citations against CourtListener and checks quote integrity via fuzzy matching. Built for legal AI agents and tools like Claude Desktop.

## Core Value

Every legal citation returned by the system is verified against authoritative sources — no hallucinated cases pass through.

## Requirements

### Validated

- ✓ MCP server with Streamable HTTP + SSE transport, Zod validation, structured responses — v1.0
- ✓ Citation parsing and normalization for ~30 West Reporter formats — v1.0
- ✓ Citation existence verification via CourtListener with hallucination detection — v1.0
- ✓ Quote integrity verification via fuzzy matching against opinion text — v1.0
- ✓ LRU caching for citations and opinion text (no TTL, immutable data) — v1.0
- ✓ Rate limiting (token bucket) and circuit breaker (cockatiel) resilience — v1.0
- ✓ Vercel deployment configuration via mcp-handler — v1.0

### Active

<!-- v1.1 Launch & Monetization -->

- [ ] Next.js dashboard on lexcerta.ai (sign up, API key management, usage stats, billing)
- [ ] Supabase backend (accounts, API keys, usage records, credit balances)
- [ ] API key authentication middleware on MCP server
- [ ] Weighted usage metering per API key (parse=0, verify=1, quote=1)
- [ ] Stripe integration — Solo plan ($20/mo, 500 credits) + credit packs ($50/1,000 credits, never expire)
- [ ] Overage handling — prompt to buy credit packs when monthly credits exhausted

## Current Milestone: v1.1 Launch & Monetization

**Goal:** Turn LexCerta from an open MCP server into a paid service with user accounts, API key auth, usage metering, and Stripe billing.

**Target features:**
- Next.js web dashboard (sign up, manage keys, view usage, billing)
- API key auth + weighted usage tracking on MCP server
- Stripe subscriptions (Solo $20/mo) and one-time credit packs ($50/1K)
- Supabase for accounts, keys, usage, credits

### Out of Scope

- Westlaw/KeyCite "Good Law" status checking — requires paid Westlaw API access
- Statute and regulation verification — different data sources and pipelines; separate MCP server
- AI-powered citation suggestion — recursive hallucination risk
- Full Bluebook formatting enforcement — separate product territory
- CAP API integration — API shut down September 2024; CourtListener has all CAP data
- SSE-only transport — deprecated in MCP spec March 2025; use Streamable HTTP

## Context

- **Shipped:** v1.0 MVP (2026-02-13)
- **Codebase:** 3,483 LOC TypeScript, 248 tests passing
- **Tech stack:** TypeScript, MCP SDK 1.26, Express (via SDK), Zod 3.25, cockatiel, lru-cache, fuzzball, mcp-handler
- **Architecture:** Stateless MCP server with module-level singletons for rate limiter, circuit breaker, caches
- **MCP tools:** parse_citation, verify_west_citation, verify_quote_integrity
- **Data source:** CourtListener API (sole source — CAP shut down Sept 2024)
- **Transport:** Streamable HTTP primary, SSE fallback for legacy clients
- **Deployment:** Vercel Serverless Functions (code ready, deployment pending)
- **Domain:** lexcerta.ai (Cloudflare)
- **v1.1 additions:** Next.js frontend, Supabase (Postgres + auth), Stripe Billing
- **Performance targets:** <1.5s existence checks, <3.0s quote verification
- **Known concern:** CourtListener rate limits (5,000/day free, 5,000/hour auth) may constrain production usage

## Constraints

- **Tech stack**: TypeScript / Node.js with `@modelcontextprotocol/sdk`
- **Runtime**: Node.js 20+ (not Edge — CJS dependencies require Node.js runtime)
- **Transport**: Streamable HTTP primary, SSE fallback
- **Secrets**: Requires `COURTLISTENER_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- **Domain**: lexcerta.ai on Cloudflare
- **Deployment**: Vercel Serverless Functions via mcp-handler

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Streamable HTTP primary, SSE fallback | SSE deprecated March 2025; Streamable HTTP is current MCP spec | ✓ Good |
| CourtListener sole data source | CAP API shut down Sept 2024; CourtListener has all CAP data | ✓ Good |
| Local citation parsing (no Eyecite) | CourtListener citation-lookup handles server-side parsing | ✓ Good |
| TypeScript/Node.js | MCP SDK is TypeScript-native, best ecosystem support | ✓ Good |
| Stateless transport (no sessions) | Serverless-ready design for Vercel Functions | ✓ Good |
| Zod v3.25 (not v4) | Simpler imports, SDK compatibility | ✓ Good |
| Module-level singleton client | Preserves rate limiter + circuit breaker state across stateless requests | ✓ Good |
| Token bucket rate limiter (4500/hr) | 90% of CourtListener 5000/hr limit as safety margin | ✓ Good |
| Cockatiel circuit breaker | 5 consecutive 5xx opens circuit, 30s half-open recovery | ✓ Good |
| No cache TTL | Citations are immutable legal records — verified results never change | ✓ Good |
| Iterative page-candidate regex | Handles series suffixes (2d, 3d, 4th) and pin cites correctly | ✓ Good |
| Pure parser module (no SDK dep) | Independent testability, clean separation of concerns | ✓ Good |
| fuzzball for fuzzy matching | Named imports for CJS/ESM compat; paragraph chunking for large texts | ✓ Good |
| Score threshold >= 70 for valid quotes | Raw score always returned for custom thresholds | ✓ Good |
| Node.js runtime (not Edge) | Required for cockatiel, lru-cache, fuzzball CJS compatibility | ✓ Good |
| mcp-handler with --legacy-peer-deps | SDK 1.26 vs required 1.25.2; backward-compatible | ⚠️ Revisit |
| Next.js in same Vercel project | Single deploy, one domain (lexcerta.ai) | — Pending |
| Supabase for data layer | Postgres + auth + RLS, generous free tier, Vercel integration | — Pending |
| Stripe for payments | Most flexible for subscriptions + one-time credit packs | — Pending |
| Weighted metering (parse=0, verify=1, quote=1) | Don't penalize free local operations, charge for CourtListener calls | — Pending |
| Credit packs supplement subscription | No surprise overage bills, no hard lockouts | — Pending |

---
*Last updated: 2026-02-13 after v1.1 milestone started*
