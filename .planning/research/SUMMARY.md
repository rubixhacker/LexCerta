# Project Research Summary

**Project:** LexCerta v1.1 Launch & Monetization
**Domain:** SaaS monetization layer for legal citation verification MCP server
**Researched:** 2026-02-13
**Confidence:** HIGH

## Executive Summary

LexCerta v1.1 adds a complete monetization layer to the existing v1.0 MCP server (which provides legal citation verification tools). This is a subsequent milestone focused on commercial viability, not core product functionality. The research validates a proven SaaS architecture: Next.js dashboard + Supabase backend + Stripe billing + API key authentication, with weighted usage metering and credit-based pricing.

The recommended approach requires converting the current Vercel serverless function deployment to a Next.js App Router project, moving the MCP handler from `/api/server.ts` to `app/api/mcp/[transport]/route.ts`, and adding dual authentication (cookie-based for dashboard users, Bearer token for MCP clients). The architecture follows established patterns from OpenAI/Anthropic API products: API keys shown once at creation, copy-once security, usage dashboards with per-tool breakdowns, Stripe-managed billing portal, and credit packs as the overage mechanism. Implementation complexity is moderate — this is well-trodden territory with minimal greenfield work.

The critical risks are integration points with the existing MCP server and maintaining transport compatibility during the Next.js migration. Three middleware injection points modify the v1.0 codebase: (1) API key extraction in the request wrapper, (2) usage recording after tool execution, and (3) credit balance checks before paid tool calls. All tool implementations remain unchanged. Streamable HTTP transport must be preserved during migration (SSE is deprecated as of MCP spec 2025-03-26). Following the dependency-driven build order prevents integration failures: scaffold Next.js first, then Supabase auth, then API keys, then metering, then Stripe, then credit enforcement.

## Key Findings

### Recommended Stack

The v1.1 stack adds a complete web application layer while preserving the existing MCP server infrastructure. **Critical finding:** The current deployment uses Vercel's "other framework" mode with a top-level `/api` directory. This conflicts with Next.js App Router — migration requires moving `api/server.ts` into the Next.js structure at `app/api/mcp/[transport]/route.ts`.

**Core technologies:**
- **Next.js 15+** (App Router): Dashboard UI and API routes — industry standard for React/TypeScript SaaS apps, excellent Vercel deployment story
- **Supabase Auth + PostgreSQL**: User accounts, API key storage, usage records — provides RLS security, scales well, free tier sufficient for launch
- **Stripe**: Subscription billing ($20/mo Solo plan, 500 credits) + one-time credit packs ($50/1K credits) — standard choice for SaaS billing, hosted Customer Portal eliminates custom billing UI
- **`mcp-handler`**: Vercel MCP adapter with Streamable HTTP support — required for Next.js App Router deployment, successor to deprecated `@vercel/mcp-adapter`
- **bcrypt**: API key hashing — security requirement, prevents key exposure in database breach

**Critical version requirements:**
- `@modelcontextprotocol/sdk@^1.25.1` (minimum) — versions below have DNS rebinding vulnerability CVE-2025-66414
- `zod@^3.25` (NOT v4) — MCP SDK has documented compatibility issues with Zod v4
- Node.js 20 LTS minimum (22 LTS preferred)

**Transport requirement:** Streamable HTTP (NOT SSE). SSE was deprecated in MCP spec 2025-03-26. mcp-handler provides automatic SSE backward compatibility but Streamable HTTP must be the primary transport.

### Expected Features

Research validates a standard developer API billing model. The feature set mirrors OpenAI/Anthropic API dashboards with one legal-specific differentiator: Claude Desktop integration guide for non-technical lawyer users.

**Must have (table stakes):**
- Email/password signup and login (Supabase Auth)
- API key generation with copy-once display (security pattern users understand)
- API key revocation (instant kill for leaked keys)
- API key authentication on MCP endpoints (Bearer token validation)
- Weighted usage metering (parse_citation=0 credits, verify_west_citation=1, verify_quote_integrity=1)
- Credit balance display (subscription credits + purchased credit pack credits)
- Stripe Checkout for Solo plan subscription ($20/mo, 500 credits)
- Stripe Customer Portal for billing self-service (cancel, update payment, view invoices)
- Credit pack purchase ($50/1,000 credits, never expire)
- Stripe webhook handling (checkout.session.completed, invoice.paid, customer.subscription.*)
- Overage handling with structured error + prompt to buy credit packs (graceful degradation, not hard cutoff)

**Should have (competitive differentiators):**
- Per-tool usage breakdown (show which tools consumed credits)
- Usage dashboard with current period summary
- Claude Desktop integration guide (JSON config generator with pre-filled API key — critical for lawyer users)
- Free trial credits (50 on signup, reduces friction for evaluation)
- Per-key usage tracking (developers use separate keys for dev/staging/prod)

**Defer (v2+ based on user feedback):**
- Usage history chart (7d/30d trend)
- Usage alerts via email (75%/90%/100% thresholds)
- OAuth/Google sign-in (Supabase makes this easy but email/password sufficient for launch)
- API key scoping (read-only vs full access permissions)
- Multiple subscription tiers (Pro, Enterprise)
- Team/organization accounts (massive complexity increase, wait for validated demand)

### Architecture Approach

The architecture adds a Next.js application layer around the existing MCP server with **dual authentication strategies**: cookie-based Supabase Auth for dashboard pages, Bearer token API key auth for MCP clients. Both resolve to the same `account_id` in Supabase. The MCP server itself remains unchanged — auth and metering are cross-cutting concerns handled by middleware, not individual tool implementations.

**Major components:**
1. **Next.js App Shell** — SSR pages (dashboard, billing, API keys), route groups for auth and protected areas, middleware for Supabase token refresh
2. **MCP Route Handler** — Moved from `api/server.ts` to `app/api/mcp/[transport]/route.ts`, wrapped in API key validation, calls existing `registerTools()` from `src/server.ts`
3. **API Key Auth Middleware** — Validates Bearer tokens, bcrypt-verifies keys, attaches account context to requests, checks credit balance before execution
4. **Usage Metering** — Records tool calls after execution (fire-and-forget), writes to Supabase `usage_records` table, deferred credit deduction for performance
5. **Stripe Webhook Handler** — Processes subscription lifecycle events, syncs to Supabase (subscriptions, credit_purchases tables), raw body signature verification
6. **Supabase Database** — Accounts, api_keys (hashed), usage_records (append-only log), subscriptions (synced from Stripe), credit_purchases (audit trail), Row Level Security policies

**Critical integration points with existing v1.0 MCP server:**
- File move: `api/server.ts` → `app/api/mcp/[transport]/route.ts` (same mcp-handler logic, new path)
- Auth wrapper: Request handler validates API key BEFORE mcp-handler processes request
- Usage recording: After tool execution, record tool name + latency to Supabase (does NOT modify tools themselves)
- Credit gate: Before paid tool execution (weight > 0), check credit balance and reject if insufficient
- **No changes** to `src/server.ts`, `src/tools/*`, `src/clients/*`, `src/cache/*`, or tool registration logic

**Data flow:**
```
MCP Client → POST /api/mcp/mcp (Bearer token) → API Key Middleware (validate, attach account)
  → mcp-handler → registerTools() → tool executes → response
  → Usage Metering (async record) → Credit Deduction (deferred, atomic via Supabase RPC)
```

### Critical Pitfalls

The monetization layer introduces new failure modes beyond the v1.0 MCP server pitfalls (CAP API deprecation, CourtListener rate limits, citation parser ambiguity). Focus on integration and production readiness.

1. **Top-level `/api` conflicts with Next.js App Router** — Vercel treats top-level `/api` as framework-independent serverless functions. When a Next.js project also has `app/api/` routes, routing conflicts cause 404/405 errors in production that don't reproduce locally. **Prevention:** Delete the top-level `api/` directory entirely, move MCP handler into `app/api/mcp/[transport]/route.ts` following Next.js conventions.

2. **Using `getSession()` instead of `getUser()` for auth checks** — `getSession()` reads cookies without revalidating tokens, allowing cookie spoofing. Supabase explicitly warns this is a security vulnerability. **Prevention:** Always call `supabase.auth.getUser()` in Server Components and middleware, which validates tokens server-to-server.

3. **Storing raw API keys in database** — Database breach = all API keys compromised. **Prevention:** bcrypt-hash all keys before storage, store only a short prefix (`lc_` + 4 chars) for efficient lookup, then bcrypt-verify full key against hash on validation.

4. **Synchronous credit deduction in request path** — Calling Supabase to atomically decrement credits before processing the MCP request adds 50-100ms latency. **Prevention:** Optimistic check (is balance > 0?) using data already fetched for key validation, then deferred atomic deduction after response via Supabase RPC function.

5. **Parsing webhook body as JSON before signature verification** — Stripe's `constructEvent()` requires the raw string body. JSON parsing + stringifying changes bytes, causing signature verification to always fail. **Prevention:** Use `request.text()` for raw body in Next.js App Route handlers, verify signature first, parse event object from Stripe's verified event.

## Implications for Roadmap

Based on research, recommended 6-phase structure following dependency order. Each phase delivers working functionality that can be validated before proceeding.

### Phase 1: Next.js Migration & Foundation
**Rationale:** Infrastructure must be converted before new features can be added. Moving from standalone Vercel functions to Next.js App Router is the foundational change that enables everything else. Critical to preserve existing MCP functionality during migration.

**Delivers:**
- Next.js 15 project structure with App Router
- MCP handler moved to `app/api/mcp/[transport]/route.ts`
- Streamable HTTP transport verified (SSE backward compat via mcp-handler)
- Existing v1.0 MCP tools working at new endpoint
- Tailwind CSS configured for dashboard UI

**Addresses:**
- Anti-pattern: Top-level `/api` + Next.js conflict (PITFALLS.md)
- Stack: Next.js + mcp-handler as required deployment target (STACK.md)
- Architecture: File move + transport preservation (ARCHITECTURE.md)

**Avoids:**
- Breaking existing MCP clients during migration
- Routing conflicts between framework modes
- SSE-only implementation (deprecated transport)

**Research flag:** Standard Next.js + mcp-handler migration, well-documented by Vercel. Skip `/gsd:research-phase`.

---

### Phase 2: Supabase Backend & Authentication
**Rationale:** User accounts and database schema are prerequisites for API keys, usage tracking, and billing. Supabase Auth provides the identity layer that everything else depends on.

**Delivers:**
- Supabase project with PostgreSQL database
- Tables: accounts, api_keys, usage_records, subscriptions, credit_purchases
- Row Level Security policies
- Supabase Auth configured (email/password provider)
- Next.js middleware for cookie-based auth and token refresh
- Login/signup pages
- Protected dashboard shell (layout + empty dashboard page)

**Addresses:**
- Features: Email/password signup and login (FEATURES.md table stakes)
- Architecture: Dual auth strategy foundations (ARCHITECTURE.md)
- Database schema with RLS (ARCHITECTURE.md)

**Avoids:**
- `getSession()` security vulnerability (use `getUser()` only)
- Proceeding to API keys without account infrastructure

**Research flag:** Standard Supabase + Next.js integration. Supabase docs are comprehensive. Skip `/gsd:research-phase`.

---

### Phase 3: API Key Management System
**Rationale:** API keys are the authentication mechanism for MCP clients and the identity bridge between dashboard users and MCP requests. Must be implemented before usage metering (which needs to know who made the call).

**Delivers:**
- API key generation with bcrypt hashing and prefix storage
- Copy-once key display (show raw key only at creation)
- API key revocation (soft delete via `is_active` flag)
- Dashboard page for key management (list, create, revoke)
- API key validation middleware on MCP endpoint
- Bearer token authentication (`Authorization: Bearer lc_...`)
- Structured error responses for invalid/missing keys

**Addresses:**
- Features: API key generation, revocation, authentication (FEATURES.md table stakes)
- Architecture: API key auth middleware (ARCHITECTURE.md Pattern 2)
- Security: bcrypt hashing, prefix lookup (PITFALLS.md)

**Avoids:**
- Storing raw keys (security pitfall)
- Proceeding to metering without identity context

**Research flag:** Standard API key pattern, well-documented by Google Cloud and others. Skip `/gsd:research-phase`.

---

### Phase 4: Usage Metering & Dashboard
**Rationale:** Usage tracking is required before billing can be implemented — Stripe needs to know what to charge for. Metering must be accurate and performant (fire-and-forget recording, no request latency).

**Delivers:**
- Usage recording middleware (after tool execution, async)
- Weighted metering: parse_citation=0, verify_west_citation=1, verify_quote_integrity=1
- Supabase `usage_records` table append-only writes
- Usage dashboard page showing current period summary
- Per-tool usage breakdown
- Per-key usage filtering

**Addresses:**
- Features: Usage metering, usage dashboard, per-tool breakdown (FEATURES.md table stakes + differentiators)
- Architecture: Usage metering component (ARCHITECTURE.md)
- Performance: Fire-and-forget recording pattern (ARCHITECTURE.md Pattern 3)

**Avoids:**
- Synchronous metering that adds latency
- Proceeding to billing without usage data

**Research flag:** Standard usage metering pattern. Skip `/gsd:research-phase`.

---

### Phase 5: Stripe Integration & Billing
**Rationale:** Monetization layer. Subscriptions and credit packs provide the revenue mechanism. Stripe webhooks sync billing state to Supabase so credit enforcement (Phase 6) has accurate data.

**Delivers:**
- Stripe Products and Prices configured (Solo plan $20/mo 500 credits, Credit Pack $50/1K)
- Stripe Checkout Session creation for subscriptions
- Stripe Checkout Session creation for one-time credit packs
- Stripe webhook handler (`/api/stripe/webhook`) with signature verification
- Webhook event handling: checkout.session.completed, invoice.paid, customer.subscription.*
- Supabase sync: subscriptions table, credit_purchases table, credit_balance updates
- Stripe Customer Portal link on billing dashboard page
- Billing dashboard page showing subscription status, credit balance, purchase history

**Addresses:**
- Features: Stripe Checkout, Customer Portal, credit pack purchase, webhook handling, credit balance display (FEATURES.md table stakes)
- Architecture: Stripe webhook handler (ARCHITECTURE.md Pattern 4)
- Security: Raw body signature verification (PITFALLS.md)

**Avoids:**
- Custom billing UI (use Stripe Customer Portal)
- JSON-parsed webhook body (breaks signature verification)

**Research flag:** Standard Stripe billing pattern. Stripe docs + credit-based pricing model documented. Skip `/gsd:research-phase`.

---

### Phase 6: Credit Enforcement & Overage Handling
**Rationale:** Final step that connects usage to billing. Without enforcement, the monetization layer has no teeth. Credit checks must be fast (optimistic) and graceful (prompt to buy, don't just fail).

**Delivers:**
- Credit balance check before paid tool execution (weight > 0)
- Optimistic check during auth middleware (already fetching account data)
- Atomic credit deduction via Supabase RPC function (deferred, after response)
- Structured MCP error response when credits exhausted
- Dashboard banner when credits low (<50 remaining)
- Free tier: parse_citation always allowed (0 credits)
- Paid tools: verify_west_citation, verify_quote_integrity gated on credit balance

**Addresses:**
- Features: Overage handling with structured error and purchase prompt (FEATURES.md table stakes)
- Architecture: Credit deduction with optimistic check (ARCHITECTURE.md Pattern 3)
- UX: Graceful degradation, not hard cutoff (PITFALLS.md)

**Avoids:**
- Synchronous credit deduction (performance trap)
- Silent failures when credits exhausted

**Research flag:** Credit-based gating pattern documented by Stigg and Lago. Skip `/gsd:research-phase`.

---

### Phase Ordering Rationale

**Dependency-driven sequencing:**
1. Next.js migration enables everything else (can't add dashboard without Next.js)
2. Supabase auth enables API keys (accounts must exist first)
3. API keys enable usage metering (need to know who made the call)
4. Usage metering enables billing (need to know what to charge)
5. Billing enables credit enforcement (need credit balances to gate on)

**Risk mitigation:**
- Phase 1 validates existing MCP functionality preserved during migration (prevents breaking v1.0)
- Phase 2 validates auth before building features dependent on it (prevents rework)
- Phases 3-6 are additive — each phase delivers user-facing value without breaking prior phases

**Parallel work opportunities:**
- Dashboard UI components can be built in parallel with backend routes (shared between phases)
- Stripe product configuration can happen during Phase 4 (billing setup doesn't block metering development)

### Research Flags

**Phases with standard patterns (skip `/gsd:research-phase`):**
- **Phase 1:** Next.js + mcp-handler migration well-documented by Vercel
- **Phase 2:** Supabase + Next.js integration is Supabase's reference architecture
- **Phase 3:** API key management patterns documented by Google Cloud, Makerkit
- **Phase 4:** Usage metering is standard event logging to database
- **Phase 5:** Stripe billing + webhooks heavily documented by Stripe
- **Phase 6:** Credit enforcement is application logic using existing primitives

**Phases that might need deeper research during execution:** None. All patterns are well-established in the SaaS billing domain. The v1.1 milestone is intentionally scoped to proven, low-risk patterns.

**Research completed during this synthesis:**
- Confirmed mcp-handler usage for Next.js App Router (HIGH confidence from Vercel docs)
- Confirmed credit-based pricing implementation patterns (MEDIUM-HIGH confidence from Stripe docs + Stigg/Lago guides)
- Confirmed dual auth strategy viability (HIGH confidence from Supabase docs + Makerkit examples)

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All technologies are mainstream choices with extensive documentation. Critical finding: mcp-handler for Next.js App Router deployment is verified. Zod version compatibility documented. |
| Features | HIGH | Feature set mirrors industry-standard API billing (OpenAI/Anthropic). Table stakes vs differentiators clearly distinguished. Anti-features prevent scope creep. |
| Architecture | HIGH | Next.js + Supabase + Stripe is a reference architecture (vercel/nextjs-subscription-payments). Dual auth pattern documented by Supabase. Integration points with existing MCP server well-defined. |
| Pitfalls | MEDIUM-HIGH | Integration pitfalls specific to v1.1 (Next.js migration, webhook signature, auth security) validated. v1.0 MCP server pitfalls (CAP deprecation, CourtListener limits) carried forward but not re-researched. |

**Overall confidence:** HIGH

Research validates this is a well-trodden path. The risk is not "can this architecture work?" (yes, it's proven) but "will the integration with the existing MCP server introduce bugs?" The answer is: only if the file move (api/server.ts → app/api/mcp/[transport]/route.ts) or auth middleware breaks transport compatibility. Testing after Phase 1 validates this.

### Gaps to Address

**During Phase 1 (Next.js Migration):**
- Verify mcp-handler `basePath: '/api/mcp'` works correctly with Next.js App Router dynamic routes `[transport]` — mcp-handler docs confirm this but needs runtime validation
- Confirm Streamable HTTP POST requests reach the handler (not just GET for SSE) — test with MCP Inspector and curl
- Validate existing CourtListener rate limiter and LRU caches (module-level singletons) persist across warm Vercel function invocations in Next.js mode — behavior should be identical but needs verification

**During Phase 3 (API Key System):**
- Determine optimal bcrypt work factor (rounds) for key hashing — balance security vs latency. Start with default (10 rounds), measure p99 latency, increase if <50ms overhead.
- Decide cache strategy for validated keys (in-memory LRU vs no cache) — research suggests LRU with 5min TTL for <10K users, Redis for scale

**During Phase 5 (Stripe Integration):**
- Test webhook signature verification with Stripe CLI — raw body handling in Next.js App Route POST handlers needs hands-on validation
- Confirm Stripe Credit Grants API vs manual credit_balance column trade-offs — Lago and Stigg guides suggest app-managed column for simplicity at low scale

**Not gaps, just validation:**
- Free trial credits (50 on signup) — implementation is trivial (default value in accounts table), but confirm this aligns with business model intent
- Credit pack "never expire" semantics — confirm this is desired vs time-limited (research suggests never-expire is user-friendly but needs business validation)

## Sources

### Primary (HIGH confidence)
- [Vercel mcp-handler GitHub](https://github.com/vercel/mcp-handler) — Next.js App Router deployment, basePath configuration
- [Vercel MCP Deployment Docs](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel) — mcp-handler setup and routing
- [Supabase Server-Side Auth for Next.js](https://supabase.com/docs/guides/auth/server-side/nextjs) — middleware pattern, getUser() security
- [Stripe credit-based pricing model](https://docs.stripe.com/billing/subscriptions/usage-based/use-cases/credits-based-pricing-model) — credit grants, meters, implementation flow
- [Stripe billing credits docs](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits) — credit grant lifecycle
- [Stripe webhooks docs](https://docs.stripe.com/webhooks) — signature verification, event handling
- [@modelcontextprotocol/sdk npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — version 1.26.0 verified, CVE-2025-66414 documented
- [MCP Specification: Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) — SSE deprecation confirmed

### Secondary (MEDIUM-HIGH confidence)
- [Vercel nextjs-subscription-payments](https://github.com/vercel/nextjs-subscription-payments) — Reference architecture Next.js + Supabase + Stripe
- [Makerkit: Supabase API Key Management](https://makerkit.dev/blog/tutorials/supabase-api-key-management) — bcrypt hashing, prefix pattern
- [Makerkit: Stripe Webhooks with Next.js Supabase](https://makerkit.dev/docs/next-supabase/payments/stripe-webhooks) — Webhook event handling
- [Stigg usage-based pricing guide](https://www.stigg.io/blog-posts/beyond-metering-the-only-guide-youll-ever-need-to-implement-usage-based-pricing) — Overage patterns: credit packs vs hard stop
- [Lago credit-based pricing](https://getlago.com/blog/credit-based-pricing) — Double-entry ledger pattern
- [OpenAI API Usage Dashboard](https://help.openai.com/en/articles/10478918-api-usage-dashboard) — Industry reference for usage UI
- [Google Cloud API key best practices](https://docs.google.google.com/docs/authentication/api-keys-best-practices) — Security patterns

### Tertiary (MEDIUM confidence)
- [ColorWhistle SaaS credits system guide 2026](https://colorwhistle.com/saas-credits-system-guide/) — Credit pack implementation patterns
- [Anthropic Cost and Usage Reporting](https://support.anthropic.com/en/articles/9534590-cost-and-usage-reporting-in-console) — Usage breakdown UI patterns
- [Vercel Functions API Reference](https://vercel.com/docs/functions/functions-api-reference) — Top-level /api routing behavior

---
*Research completed: 2026-02-13*
*Ready for roadmap: yes*
