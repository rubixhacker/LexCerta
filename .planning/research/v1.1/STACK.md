# Technology Stack: v1.1 Dashboard, Auth, Billing, Metering

**Project:** LexCerta v1.1
**Researched:** 2026-02-13

## Critical Architecture Decision: Next.js Absorbs the Project

The existing project deploys a standalone Vercel serverless function at `/api/server.ts` via `mcp-handler`. Adding Next.js to the same Vercel project means Next.js takes over as the build framework. The existing MCP endpoint moves from a standalone `/api/server.ts` to a Next.js App Router route handler at `app/api/[transport]/route.ts`. This is explicitly supported by `mcp-handler` v1.0.7 -- it was designed for Next.js App Router.

**What changes:**
- `vercel.json` simplifies (Next.js handles routing natively)
- `tsconfig.json` adapts for Next.js (JSX, path aliases, etc.)
- The MCP server code in `src/` stays as-is; only the thin handler file moves
- Dashboard pages live in `app/` alongside the MCP route

**What does NOT change:**
- All existing `src/` code (parser, tools, cache, resilience, clients)
- Dependencies: `@modelcontextprotocol/sdk`, `mcp-handler`, `zod`, `cockatiel`, `lru-cache`, `fuzzball`
- Vercel deployment target (same project, same domain)

---

## Recommended Stack

### Framework

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Next.js | ^15.5.9 | Full-stack framework for dashboard + API routes | v15 is the stable LTS choice. v16 (16.1.6 available) introduces breaking changes (middleware renamed to proxy, sync request APIs removed, Turbopack default) that add migration risk without benefit for a new dashboard. v15 has full Vercel support, established ecosystem, and all the App Router features needed. |
| React | ^19.0 | UI rendering | Required by Next.js 15 App Router. React 19 is stable. |
| React DOM | ^19.0 | DOM rendering | Peer dependency of Next.js + React 19. |

**Why NOT Next.js 16:** v16 renames `middleware` to `proxy`, removes sync access to `cookies()`/`headers()`, requires React 19.2 canary, and has only been stable for ~2 months. Supabase SSR auth middleware patterns are documented and tested against Next.js 15. Adopting v16 means debugging untested Supabase + Stripe integration paths. Ship on v15, upgrade to v16 when the ecosystem catches up.

### Authentication and Database

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| @supabase/supabase-js | ^2.95 | Supabase client (database queries, auth) | Official JS client. v2 is stable and actively maintained (published 7 days ago). |
| @supabase/ssr | ^0.8.0 | Server-side auth for Next.js | Replaces deprecated `@supabase/auth-helpers-nextjs`. Handles cookie-based auth in Server Components, Route Handlers, and middleware. Official Supabase recommendation. |

**Supabase provides both auth AND database.** No separate ORM needed. Use `supabase-js` for all DB operations (users, api_keys, usage_records, subscriptions). Row Level Security (RLS) policies enforce authorization at the database layer.

**Why Supabase over alternatives (Clerk, Auth0, Prisma):**
- Auth + Postgres in one service eliminates integration complexity
- RLS means authorization logic lives in the DB, not scattered across middleware
- Free tier is generous for early-stage SaaS (50K MAU, 500MB DB)
- Already specified in project requirements

### Billing

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| stripe | ^20.3 | Server-side Stripe API (subscriptions, checkout, webhooks) | Official Node.js SDK. Handles subscription creation, credit pack purchases, webhook verification, customer portal. Published 8 days ago. |
| @stripe/stripe-js | ^8.7 | Client-side Stripe.js loader | Loads Stripe.js for Checkout redirect. Minimal client-side footprint -- we use Stripe Checkout (hosted) not Stripe Elements, so `@stripe/react-stripe-js` is NOT needed. |

**Why Stripe Checkout (hosted) over Stripe Elements:**
- No PCI compliance burden -- Stripe hosts the payment form
- Customer Portal provides subscription management UI for free
- Faster to implement: redirect to checkout, handle webhook, done
- Credit pack purchases use the same Checkout flow as subscriptions

**Why NOT `@stripe/react-stripe-js`:** Only needed for embedded payment forms (Stripe Elements). Since we redirect to Stripe Checkout and use Customer Portal for management, there is no custom payment UI to build. Removing this dependency eliminates React context setup and reduces bundle size.

### API Key Management

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Node.js crypto (built-in) | -- | Generate cryptographically random API keys | `crypto.randomBytes(32).toString('base64url')` produces 256-bit keys. No external dependency needed. Built-in, audited, zero bundle cost. |
| Node.js crypto (built-in) | -- | Hash API keys for storage | `crypto.createHash('sha256').update(key).digest('hex')` for one-way hashing. Store hash in Supabase, compare on auth. Never store raw keys. |

**Why NOT nanoid:** nanoid is designed for short URL-friendly IDs, not API keys. `crypto.randomBytes` provides direct access to the OS CSPRNG with no abstraction layer. API keys are not URL-slugs; they do not need to be short or URL-safe (they travel in HTTP headers).

**Key format:** `lc_live_<base64url(32 bytes)>` -- prefixed for easy identification, 256-bit entropy.

### UI Components

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| shadcn/ui | latest (not versioned -- copy-paste) | Dashboard UI components | Not an npm dependency -- components are copied into the project. Provides pre-built, accessible, customizable components (cards, tables, charts, forms, buttons). Built on Radix UI primitives. The dominant choice for Next.js dashboards in 2026. |
| Tailwind CSS | ^4.1 | Utility CSS framework | Required by shadcn/ui. v4 is stable (v4.1.18 current), zero-config with Next.js 15. Major DX improvement over v3 (CSS-first config, no `tailwind.config.js`). |
| Recharts | ^2.15 | Usage charts in dashboard | shadcn/ui's chart components wrap Recharts. Declarative, composable, React-native. Already integrated with shadcn/ui chart primitives. |

**Why shadcn/ui over full component libraries (MUI, Chakra, Ant):** Copy-paste model means zero runtime dependency, full control over styling, no version lock-in. Components are yours to modify. Tailwind + Radix is the fastest path to a polished dashboard.

### Development Dependencies

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| typescript | ^5.7 | Type safety | Already in project. Next.js 15 requires TS 5+. |
| @types/react | ^19 | React type definitions | Required for TypeScript + React 19. |
| @types/react-dom | ^19 | ReactDOM type definitions | Required for TypeScript + React DOM 19. |
| @biomejs/biome | ^1 | Linting + formatting | Already in project. Keep it. Next.js 16 removed `next lint` anyway -- Biome is the right call. |
| vitest | ^4 | Testing | Already in project. Works with Next.js. |
| stripe CLI | latest | Webhook testing in development | `stripe listen --forward-to localhost:3000/api/webhooks/stripe` forwards webhook events to local dev server. Install globally or use `npx stripe`. |
| supabase CLI | latest | Local Supabase development | `supabase start` runs local Postgres + Auth. `supabase gen types typescript` generates DB types. |

---

## What NOT to Add

| Library | Why Not |
|---------|---------|
| Express | Already embedded in MCP SDK. Next.js App Router replaces the need for any Express routing. |
| Prisma / Drizzle | Supabase client handles all DB queries. Adding an ORM creates two query paths and doubles migration complexity. Use Supabase's typed client with generated types via `supabase gen types typescript`. |
| @supabase/auth-helpers-nextjs | Deprecated. Use `@supabase/ssr` instead. |
| @stripe/react-stripe-js | Not needed -- using Stripe Checkout (redirect), not embedded Elements. |
| next-auth / Auth.js | Supabase Auth handles authentication. Adding another auth layer creates confusion about session ownership. |
| nanoid / uuid | `crypto.randomBytes` is sufficient and more appropriate for API key generation. No external dependency needed. |
| Bull / BullMQ | Usage metering is synchronous (increment counter in Supabase on each MCP tool call). No job queue needed at this scale. |
| Redis | Not needed for v1.1. LRU cache is in-memory (already exists). Supabase handles persistent state. If SSE transport is needed later, mcp-handler docs mention Redis, but Streamable HTTP does not require it. |
| Tailwind v3 | v4 is stable and better. Zero-config, CSS-first. shadcn/ui supports v4. |

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Framework | Next.js 15.5.9 | Next.js 16.1.6 | Breaking changes (middleware->proxy, async-only request APIs), Supabase SSR not yet ecosystem-tested against v16, risk outweighs benefit for a dashboard |
| Auth | Supabase Auth | Clerk | Extra dependency + monthly cost when Supabase already provides auth. Clerk is better if you need social login magic, but Supabase auth handles email/password and OAuth. |
| Database | Supabase Postgres | PlanetScale | Supabase bundles auth + DB. PlanetScale is MySQL (no RLS equivalent). |
| ORM | Supabase client (none) | Prisma | Adds build step (prisma generate), migration complexity, and a second query path alongside Supabase's client. Supabase CLI generates TypeScript types natively. |
| CSS | Tailwind v4 | Tailwind v3 | v4 is stable, zero-config, and shadcn/ui supports it. No reason to use v3. |
| Charts | Recharts (via shadcn/ui) | Chart.js, D3 | Recharts is what shadcn/ui wraps. Using anything else means fighting the component library. |
| API Keys | crypto.randomBytes | nanoid | Built-in wins for security-critical generation. Zero dependency. |
| Payments UI | Stripe Checkout (hosted) | Stripe Elements (embedded) | Checkout is faster to build, handles PCI, and the Customer Portal handles subscription management for free. |

---

## Installation

```bash
# Core framework (NEW)
npm install next@^15.5.9 react@^19 react-dom@^19

# Supabase (NEW)
npm install @supabase/supabase-js@^2.95 @supabase/ssr@^0.8

# Stripe server SDK (NEW)
npm install stripe@^20.3

# Stripe.js client loader (NEW)
npm install @stripe/stripe-js@^8.7

# Tailwind CSS v4 (NEW -- used by shadcn/ui)
npm install tailwindcss@^4.1

# Dev dependencies (NEW additions to existing devDeps)
npm install -D @types/react@^19 @types/react-dom@^19

# shadcn/ui initialization (run after Next.js is configured)
npx shadcn@latest init
npx shadcn@latest add button card table chart tabs badge input label separator dropdown-menu avatar skeleton
```

---

## Environment Variables

```bash
# Supabase (NEW)
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable anon key>
SUPABASE_SERVICE_ROLE_KEY=<secret service role key -- server-only>

# Stripe (NEW)
STRIPE_SECRET_KEY=sk_live_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Existing (unchanged)
COURTLISTENER_API_KEY=<existing>
```

---

## Project Structure (Post-Migration)

```
lexcerta/
  app/                              # NEW -- Next.js App Router
    layout.tsx                      # Root layout (html, body, fonts)
    page.tsx                        # Landing / marketing page
    globals.css                     # Tailwind v4 entry (@import "tailwindcss")
    (auth)/
      login/page.tsx                # Supabase auth login
      signup/page.tsx               # Supabase auth signup
      callback/route.ts            # OAuth callback handler
    (dashboard)/
      layout.tsx                    # Dashboard shell (sidebar, nav)
      dashboard/
        page.tsx                    # Overview (usage stats, plan info)
        keys/page.tsx               # API key management (create, revoke, list)
        billing/page.tsx            # Subscription status, credit balance, purchase
        settings/page.tsx           # Account settings
    api/
      [transport]/route.ts          # MCP server (mcp-handler) -- MOVED from /api/server.ts
      webhooks/
        stripe/route.ts             # Stripe webhook handler
      billing/
        checkout/route.ts           # Create Stripe Checkout session
        portal/route.ts             # Create Stripe Customer Portal session
  src/                              # EXISTING -- MCP server logic (unchanged)
    tools/                          # Tool handlers (gain metering wrapper)
    parser/
    clients/
    cache/
    resilience/
    server.ts                       # registerTools, loadConfig
    config.ts
    types.ts
  lib/                              # NEW -- shared utilities
    supabase/
      client.ts                     # Browser Supabase client (createBrowserClient)
      server.ts                     # Server Supabase client (createServerClient)
    stripe/
      client.ts                     # Stripe server client singleton
      webhooks.ts                   # Webhook event handler dispatch
    api-keys/
      generate.ts                   # Key generation (crypto.randomBytes) + hashing
      verify.ts                     # Key verification (hash + DB lookup)
    metering/
      record.ts                     # Usage recording (tool name, weight, user_id)
      check-balance.ts              # Credit balance check before tool execution
  middleware.ts                     # NEW -- Supabase auth token refresh + route protection
  next.config.ts                    # NEW -- Next.js configuration
  components/                       # NEW -- shadcn/ui components (copy-pasted)
    ui/                             # Button, Card, Table, Chart, etc.
    dashboard/                      # Composed dashboard components
```

---

## Integration Points with Existing MCP Server

### 1. MCP Route Handler Migration

`app/api/[transport]/route.ts` replaces `/api/server.ts`. Same `createMcpHandler` call, same imports from `src/server.ts` and `src/config.ts`. The handler exports `GET`, `POST`, `DELETE` as Next.js route handler exports -- identical to current pattern.

### 2. API Key Auth in Middleware

Next.js middleware (`middleware.ts`) intercepts requests to `/api/mcp/*`:
- Extract `Authorization: Bearer lc_live_...` header
- Hash the key with SHA-256
- Look up hash in Supabase `api_keys` table (using service role client)
- Attach `user_id` and `credit_balance` to request headers for downstream use
- If key invalid or balance zero, return 401/402 immediately

For dashboard routes, the same middleware refreshes Supabase auth cookies (standard `@supabase/ssr` pattern).

### 3. Usage Metering in Tool Handlers

After each MCP tool call completes, record usage in Supabase:
- Tool name, credit weight (parse=0, verify=1, quote=1), timestamp, user_id
- Atomic credit deduction via Supabase RPC (Postgres function) to prevent race conditions
- The `user_id` comes from the auth middleware via request context

### 4. Stripe Webhook Handler

`app/api/webhooks/stripe/route.ts`:
- Verify signature with `stripe.webhooks.constructEvent()`
- Handle `checkout.session.completed` (new subscription or credit pack)
- Handle `invoice.payment_succeeded` (subscription renewal -- reset monthly credits)
- Handle `customer.subscription.deleted` (downgrade to no plan)
- Update Supabase records (subscriptions, credit_balances)

**Important:** Stripe webhook route must opt out of Next.js body parsing. Use `export const runtime = 'nodejs'` and read raw body with `request.text()` for signature verification.

---

## Version Confidence

| Package | Version | Confidence | Source |
|---------|---------|------------|--------|
| Next.js | ^15.5.9 | HIGH | npm registry, official docs, LTS policy |
| React | ^19.0 | HIGH | Required by Next.js 15 App Router |
| @supabase/supabase-js | ^2.95 | HIGH | npm registry (published 2026-02-06) |
| @supabase/ssr | ^0.8.0 | HIGH | npm registry (published 2025-11-26), official docs |
| stripe | ^20.3 | HIGH | npm registry (published 2026-02-05) |
| @stripe/stripe-js | ^8.7 | HIGH | npm registry (published 2026-01-29) |
| Tailwind CSS | ^4.1 | HIGH | npm registry (v4.1.18), stable since early 2025 |
| shadcn/ui | N/A (copy-paste) | HIGH | Actively maintained, Next.js 15/16 templates exist |
| mcp-handler | ^1.0.7 | HIGH | Already in project, confirmed App Router support |
| Recharts | ^2.15 | MEDIUM | shadcn/ui chart dependency, training data only |

---

## Sources

- [Supabase SSR Auth for Next.js](https://supabase.com/docs/guides/auth/server-side/nextjs) -- official setup guide, HIGH confidence
- [Supabase SSR Client Creation](https://supabase.com/docs/guides/auth/server-side/creating-a-client) -- @supabase/ssr package docs, HIGH confidence
- [Next.js 16 Upgrade Guide](https://nextjs.org/docs/app/guides/upgrading/version-16) -- breaking changes reference (why v15 chosen), HIGH confidence
- [Stripe Build Subscriptions Guide](https://docs.stripe.com/billing/subscriptions/build-subscriptions) -- official billing docs, HIGH confidence
- [mcp-handler GitHub](https://github.com/vercel/mcp-handler) -- Next.js App Router integration, HIGH confidence
- [Supabase Custom API Key Pattern](https://gist.github.com/j4w8n/25d233194877f69c1cbf211de729afb2) -- API key implementation with Supabase, MEDIUM confidence
- [Supabase API Key Security Guide](https://makerkit.dev/blog/tutorials/supabase-api-key-management) -- hashing and RLS patterns, MEDIUM confidence
- [Vercel Next.js Deployment](https://vercel.com/docs/frameworks/full-stack/nextjs) -- framework detection and routing, HIGH confidence
- [@supabase/ssr npm](https://www.npmjs.com/package/@supabase/ssr) -- v0.8.0 verified, HIGH confidence
- [stripe npm](https://www.npmjs.com/package/stripe) -- v20.3.1 verified, HIGH confidence
- [@stripe/stripe-js npm](https://www.npmjs.com/package/@stripe/stripe-js) -- v8.7.0 verified, HIGH confidence
- [Next.js npm](https://www.npmjs.com/package/next) -- v15.5.9 / v16.1.6 verified, HIGH confidence
- [Stripe Webhook in Next.js App Router](https://medium.com/@gragson.john/stripe-checkout-and-webhook-in-a-next-js-15-2025-925d7529855e) -- implementation pattern, MEDIUM confidence
- [shadcn/ui Next.js Installation](https://ui.shadcn.com/docs/installation/next) -- setup guide, HIGH confidence
- [Tailwind CSS v4](https://tailwindcss.com/blog/tailwindcss-v4) -- release announcement, HIGH confidence

---
*Stack research for: LexCerta v1.1 -- Dashboard, Auth, Billing, Metering*
*Researched: 2026-02-13*
