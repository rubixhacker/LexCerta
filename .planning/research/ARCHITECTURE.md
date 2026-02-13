# Architecture Patterns: LexCerta v1.1 Integration

**Domain:** Monetization layer (auth, billing, dashboard) for existing MCP server
**Researched:** 2026-02-13
**Confidence:** HIGH (core patterns), MEDIUM (some Vercel routing edge cases)

## Existing Architecture (v1.0 Baseline)

```
lexcerta/
  api/server.ts          <- Vercel Serverless Function (mcp-handler entry point)
  src/                   <- TypeScript source (compiled to build/)
    server.ts            <- registerTools() + module-level singletons
    config.ts            <- Zod-validated env config
    tools/               <- MCP tool implementations
    clients/             <- CourtListener API client
    cache/               <- LRU caches (citation, opinion)
    resilience/          <- Rate limiter, circuit breaker
  vercel.json            <- rewrites all traffic to /api/server, no build step
  tsconfig.json          <- rootDir: ./src, outDir: ./build, module: Node16
  package.json           <- type: "module", tsc build
```

**Critical facts about current setup:**
- Top-level `/api/server.ts` is a Vercel Serverless Function (NOT Next.js)
- `vercel.json` rewrites ALL routes (`/(.+)`) to `/api/server`
- `buildCommand: ""` -- no build step, Vercel auto-compiles `api/server.ts`
- `mcp-handler` creates the Express server internally; exports GET/POST/DELETE
- Module-level singletons persist across warm invocations (rate limiter, caches)

## Recommended Architecture (v1.1)

### Strategy: Convert to Next.js App Router Project

The current project uses Vercel's "other framework" mode (top-level `/api` directory). Adding Next.js requires converting to a Next.js project structure. These two modes **conflict** on Vercel -- a top-level `/api` directory and Next.js `app/api/` directory cannot coexist reliably. The `/api` directory is treated as Vercel Serverless Functions in non-framework mode, but Next.js has its own routing for `app/api/`.

**Migration approach:** Move `api/server.ts` into `app/api/[transport]/route.ts` (the path mcp-handler expects for Next.js App Router). This is a file move, not a rewrite -- mcp-handler already supports both patterns.

### System Overview (v1.1)

```
                                   lexcerta.ai
                                       |
                    ┌──────────────────┼──────────────────┐
                    |                  |                   |
              Next.js Pages     API Routes          MCP Endpoint
              /dashboard/*     /api/stripe/*      /api/mcp/[transport]
              /login           /api/keys/*
              /pricing
                    |                  |                   |
                    └──────┬───────────┘                   |
                           |                               |
                  ┌────────┴────────┐            ┌────────┴────────┐
                  | Supabase Auth   |            | API Key Auth    |
                  | (cookie-based)  |            | (Bearer token)  |
                  | Dashboard users |            | MCP consumers   |
                  └────────┬────────┘            └────────┬────────┘
                           |                               |
                           └──────────┬────────────────────┘
                                      |
                            ┌─────────┴─────────┐
                            |  Supabase DB      |
                            |  - accounts       |
                            |  - api_keys       |
                            |  - usage_records  |
                            |  - subscriptions  |
                            |  - credit_packs   |
                            └─────────┬─────────┘
                                      |
                            ┌─────────┴─────────┐
                            |  Stripe           |
                            |  - Subscriptions  |
                            |  - One-time buys  |
                            |  - Webhooks       |
                            └───────────────────┘
```

### Project Structure (v1.1)

```
lexcerta/
  app/                              <- NEW: Next.js App Router
    layout.tsx                      <- Root layout (html, body, providers)
    page.tsx                        <- Landing page / marketing
    (auth)/                         <- Route group: auth pages
      login/page.tsx
      signup/page.tsx
      callback/route.ts             <- Supabase OAuth callback
    (dashboard)/                    <- Route group: protected pages
      layout.tsx                    <- Dashboard shell (sidebar, nav)
      dashboard/page.tsx            <- Usage overview
      keys/page.tsx                 <- API key management
      billing/page.tsx              <- Subscription + credits
      usage/page.tsx                <- Detailed usage history
    api/
      mcp/[transport]/route.ts      <- MOVED from api/server.ts
      stripe/
        webhook/route.ts            <- Stripe webhook handler
        checkout/route.ts           <- Create Checkout Session
      keys/
        route.ts                    <- CRUD API keys (POST, GET)
        [id]/route.ts               <- Single key operations (DELETE)
  src/                              <- EXISTING: MCP server source (unchanged)
    server.ts
    config.ts
    tools/
    clients/
    cache/
    resilience/
  lib/                              <- NEW: Shared utilities
    supabase/
      client.ts                     <- Browser Supabase client
      server.ts                     <- Server Component Supabase client
      middleware.ts                 <- Middleware Supabase client
      admin.ts                      <- Service role client (webhooks)
    stripe/
      client.ts                     <- Stripe SDK instance
      config.ts                     <- Price IDs, product config
    auth/
      middleware.ts                 <- API key validation logic
  middleware.ts                     <- NEW: Next.js middleware (Supabase token refresh + route protection)
  next.config.ts                    <- NEW: Next.js configuration
  tailwind.config.ts                <- NEW: Tailwind CSS config
  tsconfig.json                     <- MODIFIED: Add Next.js paths
  vercel.json                       <- MODIFIED: Remove catch-all rewrite
  package.json                      <- MODIFIED: Add Next.js + deps
```

### Component Boundaries

| Component | Responsibility | Communicates With | New/Existing |
|-----------|---------------|-------------------|--------------|
| **Next.js App Shell** | SSR pages, layouts, route groups | Supabase (auth), all page components | NEW |
| **middleware.ts** | Refresh Supabase auth tokens, protect `/dashboard/*` routes, redirect unauthenticated users | Supabase Auth (cookie refresh) | NEW |
| **MCP Route Handler** | Same as v1.0 -- mcp-handler entry point | src/server.ts (registerTools), API key auth middleware | MOVED (api/server.ts -> app/api/mcp/[transport]/route.ts) |
| **API Key Auth Middleware** | Validate Bearer tokens on MCP requests, resolve account, check credits | Supabase DB (api_keys, accounts) | NEW |
| **Usage Metering** | Record each MCP tool call with tool name, account ID, timestamp | Supabase DB (usage_records) | NEW |
| **Stripe Webhook Handler** | Process subscription events, credit purchases, sync to Supabase | Stripe API, Supabase DB (subscriptions, credit_balances) | NEW |
| **Stripe Checkout Route** | Create Checkout Sessions for subscriptions and credit packs | Stripe API, Supabase Auth (get user) | NEW |
| **API Key Management Routes** | Create, list, revoke API keys | Supabase DB (api_keys) | NEW |
| **Dashboard Pages** | Display usage, manage keys, billing UI | Supabase DB (read), Stripe Customer Portal | NEW |
| **src/server.ts** | Register MCP tools, manage singletons | CourtListener client, caches, tools | EXISTING (unchanged) |
| **src/tools/*** | Citation verification, quote checking | CourtListener API, caches | EXISTING (unchanged) |

## Data Flow: Request Lifecycle

### MCP Request (API key auth)

```
1. MCP Client sends POST /api/mcp/mcp
   Headers: { Authorization: "Bearer lc_abc123..." }

2. app/api/mcp/[transport]/route.ts receives request
   |
   ├─ 3. API Key Middleware intercepts BEFORE mcp-handler
   |     a. Extract key from Authorization header
   |     b. Hash key prefix, lookup in Supabase api_keys table
   |     c. bcrypt verify full key against stored hash
   |     d. Check account has credits > 0 OR active subscription
   |     e. REJECT 401 if invalid, 403 if no credits
   |     f. Attach account_id to request context
   |
   ├─ 4. mcp-handler processes MCP protocol (unchanged)
   |     a. Creates McpServer, calls registerTools()
   |     b. Tool executes (verify_west_citation, etc.)
   |     c. Returns MCP response
   |
   ├─ 5. Usage Metering (after response, via waitUntil)
   |     a. Record: account_id, tool_name, timestamp, latency_ms
   |     b. Decrement credit balance (if credit-based plan)
   |
   └─ 6. Response sent to MCP client
```

### Dashboard Request (Supabase cookie auth)

```
1. Browser requests GET /dashboard
   Cookies: { sb-xxx-auth-token: "..." }

2. middleware.ts intercepts
   a. Create Supabase client from cookies
   b. Call supabase.auth.getUser() to validate (NOT getSession)
   c. If no user -> redirect to /login
   d. If valid -> refresh token cookies, continue

3. Dashboard Server Component renders
   a. Create server Supabase client
   b. Query usage_records, subscriptions, api_keys
   c. SSR the page with data

4. Response sent to browser
```

### Stripe Webhook Flow

```
1. Stripe sends POST /api/stripe/webhook
   Headers: { stripe-signature: "..." }

2. app/api/stripe/webhook/route.ts handles
   a. Read raw body (NOT parsed JSON -- critical for signature)
   b. Verify signature with stripe.webhooks.constructEvent()
   c. Switch on event type:

   checkout.session.completed:
     - If subscription: upsert subscriptions row
     - If credit pack: increment credit_balance

   invoice.payment_succeeded:
     - Update subscription status, reset period usage

   invoice.payment_failed:
     - Mark subscription as past_due

   customer.subscription.updated:
     - Sync plan changes to subscriptions table

   customer.subscription.deleted:
     - Mark subscription as canceled

3. Return 200 to Stripe (within 30s timeout)
```

## Database Schema

### Supabase Tables

```sql
-- Accounts (one per user, could later support orgs)
CREATE TABLE public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',  -- free, pro, enterprise
  credit_balance INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API Keys (hashed, never store raw)
CREATE TABLE public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                    -- user-assigned label
  key_prefix VARCHAR(7) NOT NULL,        -- "lc_abc" for lookup
  key_hash TEXT NOT NULL,                -- bcrypt hash of full key
  last_used_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_prefix ON public.api_keys(key_prefix) WHERE is_active = true;

-- Usage Records (append-only log)
CREATE TABLE public.usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id),
  api_key_id UUID REFERENCES public.api_keys(id),
  tool_name TEXT NOT NULL,               -- verify_west_citation, verify_quote_integrity
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_account_created ON public.usage_records(account_id, created_at DESC);

-- Subscriptions (synced from Stripe webhooks)
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  stripe_price_id TEXT NOT NULL,
  status TEXT NOT NULL,                  -- active, past_due, canceled, trialing
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credit Purchases (audit trail)
CREATE TABLE public.credit_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id),
  stripe_payment_intent_id TEXT UNIQUE,
  credits INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Row Level Security Policies

```sql
-- Accounts: users see only their own
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own account"
  ON public.accounts FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "Users update own account"
  ON public.accounts FOR UPDATE
  USING (user_id = auth.uid());

-- API Keys: users manage own keys
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own keys"
  ON public.api_keys FOR ALL
  USING (account_id IN (SELECT id FROM public.accounts WHERE user_id = auth.uid()));

-- Usage Records: users see own usage
ALTER TABLE public.usage_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own usage"
  ON public.usage_records FOR SELECT
  USING (account_id IN (SELECT id FROM public.accounts WHERE user_id = auth.uid()));

-- Subscriptions: users see own
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own subscriptions"
  ON public.subscriptions FOR SELECT
  USING (account_id IN (SELECT id FROM public.accounts WHERE user_id = auth.uid()));

-- Service role (used by webhooks, API key auth) bypasses RLS
```

## Patterns to Follow

### Pattern 1: Dual Auth Strategy

**What:** Dashboard pages use Supabase cookie-based auth. MCP endpoint uses API key Bearer token auth. Both resolve to the same `account_id`.

**When:** Always. These are fundamentally different consumers (browser vs MCP client).

**Implementation:**

```typescript
// middleware.ts -- handles ONLY dashboard/browser auth
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // Skip API key-authenticated routes
  if (request.nextUrl.pathname.startsWith('/api/mcp')) {
    return NextResponse.next()
  }
  // Skip webhook routes (no auth needed, signature verified internally)
  if (request.nextUrl.pathname.startsWith('/api/stripe/webhook')) {
    return NextResponse.next()
  }

  const response = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { /* get/set/remove from request/response cookies */ } }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Protect dashboard routes
  if (request.nextUrl.pathname.startsWith('/dashboard') && !user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
}
```

### Pattern 2: API Key Validation as Wrapper Around mcp-handler

**What:** Since mcp-handler creates its own handler, API key validation must wrap the handler rather than being middleware inside Express.

**When:** Every MCP request.

**Implementation:**

```typescript
// app/api/mcp/[transport]/route.ts
import { createMcpHandler } from 'mcp-handler'
import { validateApiKey } from '@/lib/auth/middleware'
import { recordUsage } from '@/lib/metering'
import { loadConfig } from '../../../../src/config.js'
import { registerTools } from '../../../../src/server.js'

const mcpHandler = createMcpHandler(
  (server) => {
    const config = loadConfig()
    registerTools(server, config)
  },
  { serverInfo: { name: 'lexcerta', version: '1.1.0' } },
  { basePath: '/api/mcp', maxDuration: 60 }
)

async function withAuth(request: Request): Promise<Response> {
  const authResult = await validateApiKey(request)
  if (!authResult.valid) {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: authResult.error },
      id: null
    }), { status: authResult.status, headers: { 'Content-Type': 'application/json' } })
  }

  const response = await mcpHandler(request)

  // Fire-and-forget usage recording via waitUntil
  // (Edge: use waitUntil; Node: just await, it's fast)
  recordUsage({
    accountId: authResult.accountId,
    apiKeyId: authResult.apiKeyId,
    toolName: 'mcp_request',  // Refined in metering layer
    latencyMs: Date.now() - authResult.startTime
  }).catch(() => {}) // Never fail the response for metering

  return response
}

export const GET = withAuth
export const POST = withAuth
export const DELETE = withAuth
```

### Pattern 3: Credit Deduction with Optimistic Check, Deferred Debit

**What:** Check credits before processing (fast, approximate), debit after response (accurate). Use Supabase RPC for atomic decrement.

**When:** Credit-based plans (not unlimited subscriptions).

**Why:** Checking and decrementing in one atomic operation before the request adds latency. Optimistic check + async debit is fast and safe (worst case: a few extra requests if credits hit zero during concurrent calls).

```sql
-- Atomic credit decrement function
CREATE OR REPLACE FUNCTION decrement_credits(
  p_account_id UUID,
  p_amount INTEGER DEFAULT 1
) RETURNS INTEGER AS $$
DECLARE
  new_balance INTEGER;
BEGIN
  UPDATE public.accounts
  SET credit_balance = credit_balance - p_amount,
      updated_at = now()
  WHERE id = p_account_id
    AND credit_balance >= p_amount
  RETURNING credit_balance INTO new_balance;

  IF NOT FOUND THEN
    RETURN -1;  -- insufficient credits
  END IF;
  RETURN new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Pattern 4: Stripe Webhook with Raw Body

**What:** Stripe requires the raw request body (not parsed JSON) for signature verification. Next.js App Router route handlers provide the raw body via `request.text()`.

**Implementation:**

```typescript
// app/api/stripe/webhook/route.ts
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!  // Service role for webhook writes
)

export async function POST(request: Request) {
  const body = await request.text()  // Raw body, NOT .json()
  const signature = request.headers.get('stripe-signature')!

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err) {
    return new Response('Webhook signature verification failed', { status: 400 })
  }

  // Handle events...
  switch (event.type) {
    case 'checkout.session.completed':
      // Upsert subscription or add credits
      break
    case 'customer.subscription.updated':
      // Sync plan changes
      break
    // etc.
  }

  return new Response('ok', { status: 200 })
}
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Keeping Top-Level `/api` Directory with Next.js

**What:** Leaving `api/server.ts` at the project root while adding Next.js `app/` directory.

**Why bad:** Vercel treats top-level `/api` as framework-independent Serverless Functions. When a Next.js project also has `app/api/` routes, routing conflicts arise. Requests may hit the wrong handler, or 404/405 errors appear in production that don't reproduce locally.

**Instead:** Move MCP handler to `app/api/mcp/[transport]/route.ts`. Delete the top-level `api/` directory entirely.

### Anti-Pattern 2: Using getSession() for Auth Checks in Server Components

**What:** Calling `supabase.auth.getSession()` to verify user identity in Server Components.

**Why bad:** `getSession()` reads from cookies without revalidating the token against Supabase Auth servers. Cookies can be spoofed. This is a security vulnerability documented by Supabase themselves.

**Instead:** Always use `supabase.auth.getUser()` which makes a server-to-server call to validate the JWT.

### Anti-Pattern 3: Storing Raw API Keys

**What:** Storing the full API key in the database for easy comparison.

**Why bad:** Database breach = all API keys compromised.

**Instead:** Store only bcrypt hash. Use a short prefix (`lc_` + 4 chars) for efficient lookup, then bcrypt-verify the full key against the hash.

### Anti-Pattern 4: Synchronous Credit Deduction in Request Path

**What:** Calling Supabase to atomically decrement credits before processing the MCP request.

**Why bad:** Adds 50-100ms latency to every request for a database round-trip that rarely rejects.

**Instead:** Optimistic check (is balance > 0?) in the auth middleware (data already fetched for key validation), then deferred deduction after response.

### Anti-Pattern 5: Parsing Webhook Body as JSON Before Signature Verification

**What:** Using `request.json()` and then trying to verify the Stripe signature.

**Why bad:** `constructEvent()` needs the raw string body. JSON.parse + JSON.stringify does not preserve the exact bytes, causing signature verification to always fail.

**Instead:** Use `request.text()` for the raw body. Parse only after verification.

## Integration Points: New to Existing

| Integration Point | What Changes | What Stays the Same |
|-------------------|-------------|---------------------|
| **MCP entry point** | File moves from `api/server.ts` to `app/api/mcp/[transport]/route.ts`. Auth wrapper added. basePath changes from `/api` to `/api/mcp`. | `registerTools()`, `loadConfig()`, singletons, all tool logic unchanged |
| **vercel.json** | Remove catch-all rewrite. Remove `buildCommand: ""`. Let Next.js handle routing. | `maxDuration: 60` stays (via route segment config) |
| **tsconfig.json** | Add `jsx: "preserve"`, change module to `esnext`/`bundler`, add path aliases. May need separate tsconfig for `src/` vs `app/` | `src/` compilation logic unchanged |
| **package.json** | Add next, react, react-dom, @supabase/ssr, stripe, tailwindcss, etc. Change build script to `next build`. | Existing deps unchanged |
| **src/server.ts** | No changes. `registerTools()` still called from route handler. | Singletons, tool registration, all MCP logic |
| **src/config.ts** | May add new env vars (SUPABASE_*, STRIPE_*) but core Config type unchanged | COURTLISTENER_API_KEY, PORT, NODE_ENV |

## TypeScript Configuration Strategy

The existing `src/` uses `module: "Node16"` with explicit `.js` extensions in imports. Next.js App Router expects `module: "esnext"` or `"bundler"`. These are incompatible in a single tsconfig.

**Solution: Two tsconfig files.**

```jsonc
// tsconfig.json (Next.js -- project root, used by next build)
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "paths": {
      "@/*": ["./*"]
    },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "middleware.ts"],
  "exclude": ["node_modules", "src/**/*"]
}

// tsconfig.server.json (MCP server source -- existing code)
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

The MCP route handler (`app/api/mcp/[transport]/route.ts`) imports from `src/` using relative paths. Next.js bundler resolution handles the `.js` extension imports from `src/` files transparently.

## Scalability Considerations

| Concern | At 100 users | At 10K users | At 1M users |
|---------|-------------|-------------|-------------|
| **API key validation** | Direct Supabase query per request (~50ms) | Add in-memory LRU cache of validated key hashes (5min TTL) | Redis/Upstash cache layer in front of Supabase |
| **Usage recording** | Direct INSERT per request | Batch inserts via queue (waitUntil + buffer) | Dedicated analytics pipeline (Tinybird, ClickHouse) |
| **Credit balance** | Single row UPDATE | Row-level lock contention possible; use Supabase RPC atomic decrement | Separate balance service, eventual consistency |
| **MCP singletons** | Module-level singletons work in Vercel (warm instances) | Same -- Vercel reuses warm instances within a region | Same, but consider multi-region and rate limiter sync |
| **Dashboard SSR** | Supabase queries in Server Components | Same + add ISR/caching for static content | CDN + edge caching for dashboard shell |

## Build Order (Dependency-Driven)

The following order respects dependencies -- each phase only requires what the previous phase provides:

1. **Next.js Scaffold + MCP Migration** -- Convert project to Next.js, move MCP handler, verify existing functionality preserved. No new features, just infrastructure.
   - Depends on: nothing new
   - Produces: Working Next.js project with MCP endpoint at new path

2. **Supabase Schema + Auth** -- Set up database tables, RLS policies, Supabase Auth with middleware.ts, login/signup pages.
   - Depends on: Next.js scaffold (for pages and middleware)
   - Produces: User accounts, authentication, database schema

3. **API Key System** -- Key generation, hashing, storage, validation middleware on MCP endpoint. Dashboard key management page.
   - Depends on: Supabase schema (accounts, api_keys tables), auth (to protect dashboard)
   - Produces: Authenticated MCP access via API keys

4. **Usage Metering** -- Record MCP tool calls, display usage on dashboard.
   - Depends on: API key system (to know which account made the call)
   - Produces: Usage data for billing decisions

5. **Stripe Billing** -- Subscriptions, credit packs, webhook handler, checkout flow, billing dashboard page.
   - Depends on: Accounts (for stripe_customer_id), usage metering (to show what they're paying for)
   - Produces: Complete monetization

6. **Credit Enforcement** -- Gate MCP requests on credit balance or subscription status.
   - Depends on: Stripe billing (subscriptions/credits exist), API key auth (to check before processing)
   - Produces: Enforced monetization -- free tier limits, paid tier access

## Sources

- [Vercel mcp-handler GitHub](https://github.com/vercel/mcp-handler) -- mcp-handler setup for Next.js App Router, basePath configuration, [transport] route pattern
- [Vercel Functions API Reference](https://vercel.com/docs/functions/functions-api-reference) -- Confirms top-level /api and app/api/ coexistence rules
- [Vercel/vercel#2887](https://github.com/vercel/vercel/issues/2887) -- Confirms conflict between top-level /api and pages/api
- [Supabase Server-Side Auth for Next.js](https://supabase.com/docs/guides/auth/server-side/nextjs) -- middleware.ts pattern, getUser() vs getSession() security
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) -- RLS policy patterns
- [Makerkit: Supabase API Key Management](https://makerkit.dev/blog/tutorials/supabase-api-key-management) -- bcrypt hashing, private schema, verify_api_key() pattern
- [Makerkit: Stripe Webhooks with Next.js Supabase](https://makerkit.dev/docs/next-supabase/payments/stripe-webhooks) -- Webhook event handling pattern
- [Vercel nextjs-subscription-payments](https://github.com/vercel/nextjs-subscription-payments) -- Reference architecture for Next.js + Supabase + Stripe
- [Next.js Project Structure](https://nextjs.org/docs/app/getting-started/project-structure) -- App Router file conventions
