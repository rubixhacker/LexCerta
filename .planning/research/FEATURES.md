# Feature Landscape: v1.1 Launch & Monetization

**Domain:** SaaS billing dashboard, API key management, usage metering for a developer-facing legal API
**Researched:** 2026-02-13
**Overall confidence:** MEDIUM-HIGH

**Context:** LexCerta v1.0 MVP is shipped (MCP server with parse_citation, verify_west_citation, verify_quote_integrity). v1.1 adds monetization: Next.js dashboard, Supabase backend, API key auth, weighted metering, Stripe billing. Two user types: developers (API keys, Claude Desktop integration) and lawyers (via Claude Desktop as end users).

---

## Table Stakes

Features users expect from any developer API billing product. Missing these makes the product feel broken or untrustworthy.

| Feature | Why Expected | Complexity | Dependencies on Existing System | User Type |
|---------|--------------|------------|--------------------------------|-----------|
| Email/password sign-up and login | Every SaaS product has this. Developers and lawyers both need accounts to get API keys and manage billing. No account = no product. | Low | None (new Supabase Auth layer). Dashboard route, not MCP server. | Both |
| API key generation (create, name, copy-once) | The fundamental developer onboarding action. OpenAI, Anthropic, Google, and every API provider show the key exactly once at creation time. Copy-once is a security pattern users understand. | Low | New Supabase table `api_keys`. Keys must be validated by new MCP server middleware. | Developer |
| API key revocation | If a key leaks, users must be able to kill it immediately. Google, OpenAI, and Anthropic all provide instant revocation. Non-negotiable for any API product. | Low | Supabase `api_keys` table soft-delete or status field. MCP middleware must check key validity on every request. | Developer |
| API key authentication on MCP endpoints | Without auth, the MCP server is open. Auth middleware intercepts requests before they reach tool handlers. Must validate key, identify account, and reject invalid/revoked keys with clear error. | Medium | Integrates into existing `transport.ts` Express middleware chain. Must not break Streamable HTTP or SSE transport. Key lookup hits Supabase on every request (cache recommended). | Developer |
| Usage dashboard (current period) | Users need to see how many credits they have used this billing cycle. OpenAI shows cost + activity views. Anthropic shows usage + cost. At minimum: credits used, credits remaining, current period dates. | Medium | Reads from new Supabase `usage_records` table. Aggregation query by account + billing period. | Both |
| Credit balance display | Users must see their remaining credits at a glance -- both subscription credits and purchased credit pack credits. Stripe billing credits track this, but a local view is faster and more reliable for the dashboard. | Low | Supabase `credit_balances` table or derived from Stripe Credit Balance Summary API. | Both |
| Stripe Checkout for subscription signup | Solo plan ($20/mo, 500 credits). Standard Stripe Checkout Session flow -- redirect to Stripe, return to dashboard. Every Stripe-based SaaS does this. | Medium | Stripe Product + Price objects. Stripe Checkout Session creation from Next.js API route. Webhook to provision account on successful payment. | Both |
| Stripe Customer Portal for subscription management | Cancel, update payment method, view invoices. Stripe provides a hosted portal -- do not build custom UI for this. Users expect self-service billing management. | Low | Stripe Customer Portal configuration. Single API call to create portal session, redirect user. | Both |
| Credit pack purchase | One-time purchase of additional credits ($50/1,000 credits, never expire). Must be available when subscription credits are exhausted. Stripe Checkout Session with one-time price. | Medium | Stripe Product + Price (one-time). Webhook to add credits to Supabase balance. Must handle "never expire" semantics (no `expires_at` on Stripe credit grant). | Both |
| Webhook handling (Stripe events) | Process subscription lifecycle events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`, `customer.subscription.updated`. Without webhooks, billing state drifts from reality. | Medium | New Next.js API route `/api/webhooks/stripe`. Must verify webhook signature. Updates Supabase account status and credit balances. | System |
| Usage metering per API call | Every tool invocation through an authenticated API key must record: which tool, which key, timestamp, credit cost. This is the billing source of truth. | Medium | New middleware in MCP server records usage after tool execution. Writes to Supabase `usage_records`. Weighted: parse_citation=0, verify_west_citation=1, verify_quote_integrity=1. | System |
| Overage notification (credits exhausted) | When monthly credits hit zero, user must know immediately. Return a clear API error (not a silent failure) and show status on dashboard. The project context specifies "prompt to buy credit packs" -- this is the right pattern over hard cutoff or surprise overage bills. | Medium | MCP middleware checks credit balance before allowing paid tool calls. Returns structured error with "credits exhausted" message and link to purchase credit packs. Dashboard shows warning banner. | Both |
| Multiple API keys per account | Developers use separate keys for dev/staging/prod environments. OpenAI organizes by project; even simple APIs allow multiple keys. Minimum viable: 5 keys per account. | Low | Supabase `api_keys` table with `account_id` foreign key. Dashboard list view with create/revoke actions. | Developer |

## Differentiators

Features that set LexCerta apart from generic API billing products. Not expected, but valued -- especially for the legal/developer crossover audience.

| Feature | Value Proposition | Complexity | Dependencies on Existing System | User Type |
|---------|-------------------|------------|--------------------------------|-----------|
| Per-tool usage breakdown | Show which tools consumed credits (verify_west_citation vs verify_quote_integrity). OpenAI breaks down by model; Anthropic by model + cache status. Most API dashboards only show total usage. Knowing that 80% of credits go to quote verification helps users optimize. | Low | Supabase `usage_records` already stores tool name per record. Dashboard aggregation query grouped by tool. | Both |
| Usage history chart (7d/30d trend) | Visual trend of daily credit consumption. OpenAI and Anthropic both provide time-series usage charts. Helps users predict when they will exhaust credits and whether they need a higher plan. | Medium | Time-series aggregation from `usage_records`. Chart component in Next.js dashboard (recharts or similar). | Both |
| Per-key usage tracking | Show usage broken down by API key. OpenAI enables this by default since Dec 2023. Developers with dev/staging/prod keys want to see which environment is consuming credits. | Low | `usage_records` already linked to `api_key_id`. Dashboard filter/groupby on key. | Developer |
| Claude Desktop integration guide | Lawyers using Claude Desktop need a "copy this config, paste it here" onboarding flow. Not a generic API docs page -- a specific, step-by-step Claude Desktop MCP config generator that outputs the JSON with their API key pre-filled. This bridges the gap for non-technical lawyer users. | Low | Static page in dashboard. Reads user's API key (masked) and generates Claude Desktop `claude_desktop_config.json` snippet. No backend work. | Lawyer |
| Usage alerts (email at 75%/90%/100%) | Proactive notification before credits run out. Industry best practice is alerts at 75%, 90%, and 100% thresholds. Prevents surprise lockouts. OpenAI and Anthropic both send usage alerts. | Medium | Background job or Supabase trigger that checks credit consumption percentage. Email via Supabase Edge Functions or Resend. Must not spam -- send each threshold email once per billing period. | Both |
| Free tier / trial credits | Let users try the API before paying. Give 50 free credits on signup (enough for ~50 verifications). Reduces friction for evaluation. Most API products offer free tier or trial credits. | Low | Grant initial credits on account creation. No Stripe subscription required for free tier. Supabase credit balance starts at 50. | Both |
| API key scoping (read-only vs full access) | Allow keys with restricted permissions. E.g., a key that can only call parse_citation (free, 0 credits) but not verification tools. Useful for testing and demos. | Medium | `api_keys` table gains `scopes` column (e.g., `["parse", "verify", "quote"]`). MCP middleware checks scope before tool execution. | Developer |
| OAuth / Google sign-in | Reduces signup friction. Supabase Auth supports Google OAuth out of the box. Lawyers especially may not want to create yet another password. | Low | Supabase Auth provider configuration. Dashboard login page adds "Sign in with Google" button. | Both |

## Anti-Features

Features to explicitly NOT build for v1.1. Commonly requested or seemingly obvious, but counterproductive.

| Anti-Feature | Why It Seems Good | Why Avoid | What to Do Instead |
|--------------|-------------------|-----------|-------------------|
| Custom billing portal UI | Full control over billing UX (invoices, payment methods, plan changes). | Stripe Customer Portal handles this and is maintained by Stripe. Building custom billing UI is weeks of work for forms, PCI compliance considerations, edge cases (failed payments, refunds, disputes). Stripe updates their portal automatically when they add features. | Use Stripe Customer Portal. One API call to create a session, redirect the user. Covers 95% of billing management needs. |
| Team/organization accounts | Multiple users sharing one billing account. Seems natural for law firms. | Massive complexity increase: role-based access control, invitation flows, shared vs per-user keys, billing owner vs member permissions, seat-based pricing logic. v1.1 is solo users only. Add teams when there is validated demand from paying customers. | Single-user accounts only. One email = one account = one billing relationship. Document that team support is on the roadmap if asked. |
| Usage-based pricing (pay per call, no subscription) | Maximum flexibility. User pays exactly for what they use. | Unpredictable revenue. Harder to implement with Stripe (requires Meters + usage reporting). Harder for users to budget. The subscription + credit pack model gives predictable baseline revenue and user cost predictability. Pure usage-based can be added as a plan later. | Stick with Solo plan ($20/mo, 500 credits) + credit packs ($50/1K). Simple, predictable for both sides. |
| Multiple subscription tiers at launch | Pro plan, Enterprise plan, custom pricing. Seems like you need tiers. | No data on usage patterns yet. You do not know what a "power user" looks like for this product. Premature tier design leads to awkward pricing that must be changed later (breaking existing subscribers). One plan + credit packs is the right starting point. | Launch with Solo plan only. After 3-6 months of usage data, design Pro tier based on actual power user patterns. Credit packs serve as the "I need more" escape valve in the meantime. |
| Real-time usage streaming (WebSocket) | Dashboard updates live as API calls happen. Feels modern. | Adds WebSocket infrastructure, connection management, and complexity for a metric that updates at most a few times per minute for most users. Polling or page refresh is fine for a billing dashboard. | Dashboard fetches usage on page load. Add a refresh button. If a user just made API calls and wants to see updated usage, they click refresh. |
| Admin panel / back-office tools | View all users, manage accounts, override balances, investigate issues. | Scope creep. For early-stage with few users, Supabase Studio dashboard + Stripe Dashboard provide all admin capabilities needed. Building a custom admin panel is a separate product. | Use Supabase Studio for database queries and Stripe Dashboard for billing management. Build admin tooling only when user count makes direct database access impractical (100+ users). |
| Rate limiting per API key | Throttle individual keys to prevent abuse. | The existing MCP server already has a global rate limiter (4,500/hr against CourtListener's 5,000/hr limit). Per-key rate limiting adds complexity and is redundant with credit-based limiting -- when credits run out, the key is effectively rate-limited to zero on paid tools. | Credit balance acts as the natural rate limit. Global CourtListener rate limiter prevents upstream abuse. Add per-key rate limiting only if a single user is monopolizing the shared CourtListener quota. |
| Automatic plan upgrades | Detect high usage and auto-upgrade to a higher plan. | Users hate surprise billing changes. Violates trust, especially with lawyers who are sensitive to unauthorized charges. | Send usage alerts. Show "upgrade available" banner. Let the user decide. Never change billing without explicit user action. |
| SDK / client library | Official npm package for calling LexCerta API. | The MCP protocol IS the SDK. MCP clients (Claude Desktop, custom agents) already know how to call MCP tools. A custom SDK adds a maintenance burden and duplicates what MCP provides. | Document MCP connection configuration. Provide the Claude Desktop JSON config snippet. Users who build custom integrations use the MCP SDK directly. |

## Feature Dependencies

```
[Supabase Auth (sign up/login)]
    |
    +--enables--> [API Key Generation]
    |                 |
    |                 +--enables--> [API Key Auth Middleware on MCP Server]
    |                 |                 |
    |                 |                 +--enables--> [Usage Metering per Call]
    |                 |                 |                 |
    |                 |                 |                 +--enables--> [Usage Dashboard]
    |                 |                 |                 |
    |                 |                 |                 +--enables--> [Per-Tool Breakdown]
    |                 |                 |                 |
    |                 |                 |                 +--enables--> [Per-Key Usage Tracking]
    |                 |                 |                 |
    |                 |                 |                 +--enables--> [Usage Alerts]
    |                 |                 |
    |                 |                 +--enables--> [Credit Balance Check (overage handling)]
    |                 |
    |                 +--enables--> [Claude Desktop Config Generator]
    |
    +--enables--> [Stripe Checkout (subscription)]
    |                 |
    |                 +--enables--> [Stripe Webhooks]
    |                 |                 |
    |                 |                 +--enables--> [Credit Balance Provisioning]
    |                 |                 |
    |                 |                 +--enables--> [Credit Pack Purchase]
    |                 |
    |                 +--enables--> [Stripe Customer Portal]

[Existing MCP Server (transport.ts)]
    |
    +--modified by--> [API Key Auth Middleware]
    |
    +--modified by--> [Usage Recording Middleware]
    |
    +--modified by--> [Credit Balance Gate]
```

### Critical Path

The dependency chain that determines build order:

1. **Supabase schema + Auth** -- everything depends on accounts existing
2. **API key generation + storage** -- auth middleware needs keys to validate
3. **API key auth middleware on MCP server** -- metering needs to know who is calling
4. **Usage metering** -- billing needs usage records
5. **Stripe integration** -- needs accounts to associate with Stripe customers
6. **Credit balance management** -- needs both Stripe webhooks and usage records
7. **Dashboard UI** -- needs all backend pieces to display

### Integration Points with Existing MCP Server

The v1.0 MCP server must be modified in exactly three places:

1. **`transport.ts` (or new middleware):** Add API key extraction from request headers (e.g., `Authorization: Bearer lc_...`) before requests reach tool handlers. Must work for both Streamable HTTP (`POST /mcp`) and SSE (`GET /sse`, `POST /messages`).

2. **Tool handler wrappers:** After a tool executes successfully, record usage to Supabase. The weight is determined by tool name: `parse_citation=0`, `verify_west_citation=1`, `verify_quote_integrity=1`.

3. **Pre-execution credit check:** Before executing a paid tool (weight > 0), verify the account has sufficient credits. Reject with structured MCP error if insufficient.

The `server.ts` `registerTools()` function and tool implementations (`verify-citation.ts`, `verify-quote.ts`, `parse-citation.ts`) should NOT be modified. Auth and metering are cross-cutting concerns handled by middleware, not by individual tools.

## MVP Recommendation for v1.1

### Must Have (launch blockers)

1. **Email/password sign-up and login** -- gate to everything else
2. **API key generation and revocation** -- the core developer action
3. **API key auth middleware on MCP server** -- monetization requires auth
4. **Weighted usage metering** -- must track credits consumed
5. **Credit balance display** -- users must see remaining credits
6. **Stripe subscription checkout (Solo plan)** -- the revenue mechanism
7. **Stripe webhook handling** -- billing state synchronization
8. **Credit pack purchase flow** -- the overage escape valve
9. **Stripe Customer Portal link** -- billing self-service
10. **Overage handling (structured error + prompt to buy)** -- graceful credit exhaustion

### Should Have (launch with if possible, defer 1-2 weeks if needed)

1. **Usage dashboard with current period summary** -- users want to see usage, but can check Stripe receipts in the short term
2. **Per-tool usage breakdown** -- low effort addition to usage dashboard
3. **Claude Desktop integration guide** -- low effort, high value for lawyer users
4. **Free trial credits (50 on signup)** -- reduces friction, easy to implement

### Defer (post-launch, data-driven)

1. **Usage history chart** -- nice but not blocking
2. **Per-key usage tracking** -- wait for users with multiple keys
3. **Usage alerts (email)** -- requires email infrastructure
4. **OAuth / Google sign-in** -- Supabase makes this easy, but email/password is sufficient for launch
5. **API key scoping** -- wait for developer feedback on permission needs

## User Type Considerations

### Developer Users

Developers expect: API key management, clear documentation, usage visibility, standard auth patterns (Bearer token), predictable error responses when credits are exhausted. They will read docs and configure integrations themselves.

**Key insight:** Developers want the key management and usage tracking features to work exactly like OpenAI or Anthropic's dashboards. Do not innovate on these patterns -- follow them.

### Lawyer Users (via Claude Desktop)

Lawyers expect: simple signup, a "paste this into Claude Desktop" instruction, visibility into how many "checks" they have left (not "credits" -- use plain language), and the ability to buy more when they run out.

**Key insight:** Lawyers do not think in terms of API keys or credits. The dashboard must translate: "You have 347 citation checks remaining this month" not "347 credits remaining." The Claude Desktop config generator is the most important differentiator for this user type -- it eliminates the technical barrier entirely.

### Dual-Audience Dashboard Strategy

Do NOT build two separate dashboards. Build one dashboard with progressive disclosure:

- **Default view:** Simple -- credit balance ("X checks remaining"), buy more button, Claude Desktop setup guide
- **Developer view:** Toggle or tab -- API keys, per-key usage, per-tool breakdown, raw usage data

This serves lawyers by default and lets developers access what they need without cluttering the lawyer experience.

## Sources

- [Stripe credit-based pricing model docs](https://docs.stripe.com/billing/subscriptions/usage-based/use-cases/credits-based-pricing-model) -- Credit grants, meters, implementation flow (HIGH confidence)
- [Stripe billing credits docs](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits) -- Credit grant lifecycle, priority, limitations (HIGH confidence)
- [OpenAI API Usage Dashboard](https://help.openai.com/en/articles/10478918-api-usage-dashboard) -- Cost + Activity views, per-project filtering, export (MEDIUM confidence)
- [Anthropic Cost and Usage Reporting](https://support.anthropic.com/en/articles/9534590-cost-and-usage-reporting-in-console) -- Usage breakdown, Admin API (MEDIUM confidence)
- [Google Cloud API key best practices](https://docs.google.google.com/docs/authentication/api-keys-best-practices) -- Security patterns, rotation, scoping (HIGH confidence)
- [Stigg usage-based pricing guide](https://www.stigg.io/blog-posts/beyond-metering-the-only-guide-youll-ever-need-to-implement-usage-based-pricing) -- Overage handling patterns: hard stop vs soft limit vs credit packs (MEDIUM confidence)
- [ColorWhistle SaaS credits system guide 2026](https://colorwhistle.com/saas-credits-system-guide/) -- Credit pack implementation patterns, weighted pricing (MEDIUM confidence)
- [Lago credit-based pricing explainer](https://getlago.com/blog/credit-based-pricing) -- Double-entry ledger pattern, audit trails (MEDIUM confidence)
- [Supabase Next.js server-side auth](https://supabase.com/docs/guides/auth/server-side/nextjs) -- Middleware pattern, cookie-based auth (HIGH confidence)
- [OpenAI project management](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects) -- Per-project API keys, usage tracking per key (MEDIUM confidence)
- [CloudZero API metrics 2026](https://www.cloudzero.com/blog/api-metrics/) -- Cost per API call as foundational metric (LOW confidence)

---
*Feature research for: LexCerta v1.1 Launch & Monetization*
*Researched: 2026-02-13*
