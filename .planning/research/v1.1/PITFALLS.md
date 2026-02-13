# Domain Pitfalls: Adding SaaS Monetization to LexCerta MCP Server

**Domain:** SaaS billing, auth, metering on existing serverless MCP server
**Researched:** 2026-02-13
**Confidence:** MEDIUM-HIGH

---

## Critical Pitfalls

Mistakes that cause rewrites, data loss, or revenue leakage.

---

### Pitfall 1: Vercel Routing Collision Between Existing `api/server.ts` and Next.js App Router

**What goes wrong:**
LexCerta currently deploys as a standalone Vercel serverless function at `api/server.ts` with a catch-all rewrite (`"source": "/(.+)", "destination": "/api/server"`). Adding Next.js introduces `app/api/` routes (for Stripe webhooks, auth callbacks, dashboard API). Vercel's routing behaves inconsistently when root-level `/api` functions coexist with Next.js App Router `/app/api/` routes. In production, one routing system silently wins and the other returns 404. Local `vercel dev` may show different behavior than production deployment.

**Why it happens:**
The current `vercel.json` rewrites ALL paths to `/api/server`. This catch-all will intercept requests meant for Next.js pages (`/dashboard`, `/pricing`) and new API routes (`/api/stripe/webhook`, `/api/auth/callback`). Vercel processes rewrites before framework routing, so Next.js never sees the request. The [documented GitHub issue #12676](https://github.com/vercel/vercel/issues/12676) confirms that mixing root-level Vercel functions with Next.js App Router routes behaves inconsistently between environments.

**Consequences:**
- MCP endpoint stops working after Next.js migration (if rewrites are removed naively)
- Dashboard pages return MCP protocol errors (if rewrites are kept)
- Stripe webhooks never reach their handler (intercepted by catch-all)
- Works locally, breaks in production (or vice versa)

**Prevention:**
1. Migrate the MCP endpoint INTO the Next.js App Router before adding any other routes. Move `api/server.ts` to `app/api/mcp/[transport]/route.ts` using `mcp-handler`'s Next.js integration pattern with `basePath: "/api/mcp"`.
2. Remove the catch-all rewrite from `vercel.json` entirely. Let Next.js handle all routing.
3. Remove `"buildCommand": ""` from `vercel.json` -- Next.js needs its build step.
4. Test the MCP endpoint with MCP Inspector AFTER migration, BEFORE adding any new routes.

**Detection (warning signs):**
- 404 errors on `/dashboard` or `/api/stripe/webhook` in production
- MCP clients getting HTML responses instead of JSON-RPC
- `vercel dev` behavior diverging from `vercel --prod` deployment
- Routes working locally but returning 404/405 on Vercel

**Phase to address:** Phase 1 (Project restructure). This MUST be the first task before any other v1.1 work begins. Every subsequent feature depends on routing working correctly.

**Confidence:** HIGH -- confirmed via [Vercel GitHub issue #12676](https://github.com/vercel/vercel/issues/12676) and analysis of current `vercel.json` configuration.

---

### Pitfall 2: Credit Balance Race Condition on Concurrent Decrement

**What goes wrong:**
Two concurrent MCP requests for the same user both read credit balance as 5, both decrement to 4, and write 4. User consumed 2 credits but was only charged 1. At scale, this causes systematic revenue leakage. Worse: a user at 1 credit remaining can make 10 concurrent requests during the read-check-write window, consuming 10 credits worth of service while only being charged 1.

**Why it happens:**
Serverless functions run in parallel with no shared memory. The naive pattern is: (1) read balance, (2) check if sufficient, (3) decrement balance. In Supabase, the JavaScript client (`supabase-js`) has no native transaction support because PostgREST does not support transactions. Each step is a separate HTTP request to Supabase, creating a wide race window. This is not theoretical -- any user making rapid sequential requests (or an LLM making parallel tool calls) will trigger this.

**Consequences:**
- Systematic revenue leakage (users consume more than they pay for)
- Negative credit balances in the database
- Billing disputes when balance accounting does not match usage logs

**Prevention:**
Use a PostgreSQL stored procedure called via `supabase.rpc()` that performs the check-and-decrement atomically:

```sql
CREATE OR REPLACE FUNCTION decrement_credits(
  p_user_id UUID,
  p_amount INTEGER,
  p_tool_name TEXT,
  p_request_id UUID
) RETURNS TABLE(success BOOLEAN, remaining INTEGER) AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  -- Lock the row for update (prevents concurrent reads)
  SELECT credit_balance INTO v_balance
  FROM user_accounts
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_balance >= p_amount THEN
    UPDATE user_accounts
    SET credit_balance = credit_balance - p_amount
    WHERE user_id = p_user_id;

    INSERT INTO usage_log (user_id, credits_used, tool_name, request_id)
    VALUES (p_user_id, p_amount, p_tool_name, p_request_id);

    RETURN QUERY SELECT true, v_balance - p_amount;
  ELSE
    RETURN QUERY SELECT false, v_balance;
  END IF;
END;
$$ LANGUAGE plpgsql;
```

The `FOR UPDATE` row lock serializes concurrent decrements. The entire operation is one Supabase `.rpc()` call, so it is atomic even from serverless functions.

Do NOT use: `UPDATE ... SET balance = balance - 1 WHERE balance > 0` without the explicit lock -- while this prevents negative balances, it does not prevent the lost-update problem where two decrements succeed but only one is recorded.

**Detection (warning signs):**
- Usage log total credits consumed does not match (starting balance - current balance)
- Negative credit balances appearing in the database
- Balance checks in application code (JavaScript) rather than database (SQL)
- Any `supabase.from('accounts').select()` followed by separate `.update()` for balance changes

**Phase to address:** Phase 2 (Credit system). Must be designed correctly from the first implementation. Retrofitting atomicity onto an existing balance system is a data migration nightmare.

**Confidence:** HIGH -- well-documented database concurrency pattern. Confirmed Supabase lacks client-side transaction support via [PostgREST limitation](https://github.com/orgs/supabase/discussions/526) and [Marmelab analysis](https://marmelab.com/blog/2025/12/08/supabase-edge-function-transaction-rls.html).

---

### Pitfall 3: Stripe Webhook Signature Verification Fails Due to Body Parsing

**What goes wrong:**
Stripe webhook signature verification requires the raw request body (exact bytes as sent). Next.js App Router automatically parses the request body. If you call `request.json()` before verifying the signature, the re-serialized JSON may differ from the original bytes (key ordering, whitespace), causing `stripe.webhooks.constructEvent()` to throw "No signatures found matching the expected signature for payload."

**Why it happens:**
This is the single most common Stripe + Next.js integration issue, documented across [multiple](https://github.com/vercel/next.js/issues/60002) [GitHub](https://github.com/vercel/next.js/discussions/48885) [issues](https://github.com/vercel/next.js/issues/49739). Developers familiar with Express (where `bodyParser: false` is straightforward) struggle with the App Router pattern, which uses the Web Request API.

**Consequences:**
- All webhook events rejected with signature mismatch
- Subscription changes, payment confirmations, and cancellations never processed
- Manual intervention needed for every billing event
- Looks like "Stripe is broken" when actually it is a body parsing issue

**Prevention:**
In the App Router webhook route, use `request.text()` instead of `request.json()`:

```typescript
// app/api/stripe/webhook/route.ts
export async function POST(request: Request) {
  const body = await request.text();  // RAW body, not .json()
  const signature = request.headers.get('stripe-signature')!;

  const event = stripe.webhooks.constructEvent(
    body,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!
  );
  // ... handle event
}
```

Do NOT: use `request.json()`, do NOT use middleware that parses the body, do NOT use `JSON.stringify(await request.json())` as a workaround (byte order is not guaranteed).

**Detection (warning signs):**
- "No signatures found matching the expected signature" in logs
- Webhook test events failing in Stripe Dashboard
- `request.json()` called anywhere in the webhook handler file
- Any body-parsing middleware applied globally

**Phase to address:** Phase 3 (Stripe integration). Get this right on the first implementation -- the fix is simple but the debugging is maddening because the error message does not mention body parsing.

**Confidence:** HIGH -- confirmed via [Next.js issue #60002](https://github.com/vercel/next.js/issues/60002) and [Stripe documentation](https://docs.stripe.com/webhooks/signature).

---

### Pitfall 4: Stripe Webhook Events Processed Out of Order or Duplicated

**What goes wrong:**
Stripe does not guarantee event delivery order. A `customer.subscription.updated` event (downgrade) may arrive before `customer.subscription.created`. Or `invoice.paid` arrives, your handler provisions credits, then the same event arrives again (retry) and provisions credits a second time. In serverless, two Lambda/Vercel function instances can process the same webhook event simultaneously.

**Why it happens:**
Stripe retries failed webhooks for up to 3 days. Network issues cause delayed delivery. Serverless auto-scaling means two instances can receive and process the same event concurrently before either writes the "processed" flag. The [Stigg analysis](https://www.stigg.io/blog-posts/best-practices-i-wish-we-knew-when-integrating-stripe-webhooks) documents this as the most common production billing bug.

**Consequences:**
- Double credit provisioning (revenue loss)
- Subscription state corruption (user shows wrong plan)
- Credit packs purchased once but credited twice
- Intermittent -- hard to reproduce, only surfaces under load

**Prevention:**
1. **Idempotency table**: Store `stripe_event_id` with a unique constraint. Before processing, INSERT the event ID. If it already exists (unique violation), skip processing. This must happen in the SAME transaction as the business logic.
2. **Atomic event processing via stored procedure**:
```sql
CREATE OR REPLACE FUNCTION process_stripe_event(
  p_event_id TEXT,
  p_event_type TEXT,
  p_payload JSONB
) RETURNS BOOLEAN AS $$
BEGIN
  -- Attempt to insert; if duplicate, return false
  INSERT INTO stripe_events (event_id, event_type, payload, processed_at)
  VALUES (p_event_id, p_event_type, p_payload, NOW())
  ON CONFLICT (event_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN false;  -- Already processed
  END IF;

  -- Process event (credit provisioning, subscription updates, etc.)
  -- ... business logic here ...

  RETURN true;
END;
$$ LANGUAGE plpgsql;
```
3. **Fetch current state from Stripe API**: When handling `customer.subscription.updated`, fetch the subscription from Stripe's API to get the current state rather than relying on the webhook payload (which may be stale).
4. **5-minute signature window**: Verify signatures immediately. Do not queue raw events for later verification -- the Stripe signature has a 5-minute validity window.

**Detection (warning signs):**
- Duplicate entries in credit provisioning logs
- Users reporting more credits than purchased
- Webhook handler without an idempotency check on `event.id`
- Business logic outside of a database transaction

**Phase to address:** Phase 3 (Stripe integration). Idempotency must be part of the initial webhook handler, not bolted on later.

**Confidence:** HIGH -- confirmed via [Stripe idempotency docs](https://docs.stripe.com/api/idempotent_requests), [Stigg best practices](https://www.stigg.io/blog-posts/best-practices-i-wish-we-knew-when-integrating-stripe-webhooks), and [Hookdeck guide](https://hookdeck.com/webhooks/guides/implement-webhook-idempotency).

---

### Pitfall 5: API Key Lookup on Every MCP Request Adds 50-200ms Latency

**What goes wrong:**
Every MCP tool call requires API key validation. The naive approach queries Supabase on every request: `SELECT user_id, plan FROM api_keys WHERE key_hash = $1`. From a Vercel serverless function, this adds a Supabase round-trip (50-200ms depending on region) to every MCP request. For a `verify_citation` call that already takes 500-1500ms (CourtListener API), this is tolerable. But for `parse_citation` (pure computation, ~10ms), the auth overhead dominates by 10x.

**Why it happens:**
Serverless functions have no persistent memory between invocations (cold starts wipe in-memory caches). Even warm instances cannot reliably cache because Vercel may route subsequent requests to different instances. The standard Supabase client creates a new connection per invocation.

**Consequences:**
- Minimum 50ms overhead on every request
- Cold starts compound: function init (~300ms) + Supabase connection (~100ms) + key lookup (~100ms) = 500ms before any business logic
- Latency budget consumed by auth, not by the actual tool

**Prevention:**
1. **Hash-based key validation with short-lived edge cache**: Store API keys as SHA-256 hashes in Supabase. Use Vercel KV (Redis) as a fast lookup cache with 5-minute TTL. Cache pattern: check KV first (~5ms), fall back to Supabase on miss, populate KV on miss.
2. **Key structure encodes plan info**: Design API keys as `lc_solo_<random>` or `lc_team_<random>` where the prefix encodes the plan tier. This allows the middleware to reject obviously invalid keys before any database call.
3. **Connection pooling**: Use Supabase's connection pooler (Supavisor) via the pooled connection string, not the direct connection, to avoid connection setup overhead.
4. **Consider JWT-based approach for dashboard users**: Dashboard users (lawyers) authenticate via Supabase Auth and get JWTs. JWT validation is local (no database round-trip). Only developer API keys need the database lookup.

**Detection (warning signs):**
- P50 latency for `parse_citation` exceeds 100ms (should be ~10ms)
- Supabase query logs showing identical key lookups hundreds of times per hour
- No caching layer between the API key check and Supabase
- Using direct database connection string instead of pooled connection

**Phase to address:** Phase 2 (API key auth). Design the caching strategy before implementing auth middleware, not after latency complaints.

**Confidence:** MEDIUM-HIGH -- latency numbers estimated from Supabase [connection documentation](https://supabase.com/docs/guides/database/connecting-to-postgres) and [RLS performance analysis](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv). Exact numbers depend on region proximity.

---

### Pitfall 6: RLS Policies on Usage/Credit Tables Kill Query Performance

**What goes wrong:**
Supabase Row Level Security policies are evaluated per-row on every query. A naive RLS policy like `auth.uid() = user_id` on the `usage_log` table seems correct, but `auth.uid()` is a function call. Without optimization, PostgreSQL evaluates this function for every row in the table, turning a simple "get my usage this month" query into a full table scan.

**Why it happens:**
RLS policies look simple in tutorials: `CREATE POLICY "users see own data" ON usage_log FOR SELECT USING (auth.uid() = user_id)`. But the PostgreSQL query planner does not always optimize function calls in policies. Supabase's own [troubleshooting guide](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv) documents cases where unoptimized RLS policies degraded query time from 0.1ms to 178,000ms (178 seconds).

**Consequences:**
- Dashboard "usage this month" query takes seconds instead of milliseconds
- Supabase database CPU spikes on usage-heavy tables
- Connection pool exhaustion as slow queries block connections
- Appears to work in development (small tables) but collapses in production

**Prevention:**
1. **Wrap function calls in subselects**: Use `(SELECT auth.uid()) = user_id` instead of `auth.uid() = user_id`. The subselect triggers query planner caching so the function is called once, not per-row.
2. **Index columns used in RLS policies**: `CREATE INDEX idx_usage_log_user_id ON usage_log(user_id)`. This is the single highest-impact optimization (100x+ improvement documented).
3. **Always specify role**: Use `TO authenticated` in policies, not the default (which includes `anon`).
4. **Use service role for metering writes**: The MCP server writes usage logs server-side. Use the Supabase service role key (bypasses RLS) for writes from the MCP server, and RLS only for dashboard reads. This avoids RLS overhead on the hot path.
5. **Add client-side filters**: Always include `.eq('user_id', userId)` in dashboard queries even though RLS enforces it. This helps the query planner use indexes.

**Detection (warning signs):**
- Dashboard pages loading slowly (>1s for usage display)
- `auth.uid()` used directly (not wrapped in subselect) in RLS policies
- No indexes on `user_id` columns in usage/credit tables
- `EXPLAIN ANALYZE` showing sequential scans on RLS-protected tables

**Phase to address:** Phase 2 (Database schema). Define RLS policies and indexes together in the initial migration, not as separate concerns.

**Confidence:** HIGH -- confirmed via [Supabase RLS performance docs](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv) with specific before/after benchmarks.

---

## Moderate Pitfalls

---

### Pitfall 7: Weighted Credit Metering Becomes Unauditable

**What goes wrong:**
LexCerta has tools with different costs: `parse_citation` (cheap, no API call) vs `verify_citation` (expensive, CourtListener API) vs `verify_quote` (most expensive, fetches full opinion text). Assigning credit weights (e.g., 1/3/5) seems straightforward, but without an audit trail mapping every credit deduction to a specific request, disputes become unresolvable. "I only ran 10 verifications but I'm missing 50 credits" -- can you prove otherwise?

**Why it happens:**
Developers implement credit decrement as a simple counter update. The balance goes down but there is no record of WHY. When the credit weight changes (e.g., `verify_quote` goes from 5 to 3 credits after optimization), historical usage cannot be reconstructed.

**Prevention:**
1. **Immutable usage log**: Every credit deduction gets a row: `(request_id, user_id, tool_name, credits_charged, credit_weight_at_time, timestamp, api_key_used)`. Never delete or update these rows.
2. **Store the weight at time of charge**: Credit weights will change. Store the weight that was applied, not just the tool name.
3. **Request ID correlation**: Generate a UUID per MCP request. Store it in both the usage log and the MCP response metadata. User can correlate their API logs with billing.
4. **Balance = initial_credits - SUM(usage_log.credits_charged)**: The balance should be derivable from the usage log at any time. If the stored balance diverges from the calculated balance, you have a bug.

**Detection (warning signs):**
- Credit balance stored as a single counter with no itemized log
- No `request_id` in usage records
- Weight values hardcoded in application code with no versioning
- Inability to answer "what did user X spend credits on this month?"

**Phase to address:** Phase 2 (Credit system schema design). The usage log schema must be designed before the decrement function.

**Confidence:** HIGH -- standard billing audit pattern.

---

### Pitfall 8: MCP Server State Lost During Next.js Migration

**What goes wrong:**
The current `server.ts` uses module-level singletons (`sharedClient`, `sharedCache`, `sharedOpinionCache`) to share state across requests within the same serverless instance. When migrating to Next.js App Router, the module loading behavior changes. Next.js may reload modules between requests (especially in development with Fast Refresh), destroying the singleton state. The `lru-cache` instances (citation cache, opinion cache) get wiped on every request in dev, making it appear that caching is broken.

**Why it happens:**
Next.js development mode uses Hot Module Replacement (HMR) which re-executes modules. Production is better (modules persist within a single serverless instance) but the boundary behavior differs from the current setup where `mcp-handler` manages the module lifecycle.

**Prevention:**
1. **Use `globalThis` for singletons in Next.js**: The standard Next.js pattern for persistent singletons:
```typescript
const globalForLexCerta = globalThis as unknown as {
  courtlistenerClient: CourtListenerClient | undefined;
  citationCache: CitationCache | undefined;
};
export const client = globalForLexCerta.courtlistenerClient ??= new CourtListenerClient(...);
```
2. **Test cache behavior in Next.js dev mode**: Verify that cache hits occur across multiple requests in `next dev`, not just in production.
3. **Accept that serverless caching is best-effort**: The in-memory LRU cache is an optimization, not a guarantee. Design so the system works (slower) without cache hits.

**Detection (warning signs):**
- Cache hit rate drops to 0% after migration
- CourtListener API calls increasing despite caching code being present
- `module-level let` declarations being re-initialized on every request in dev

**Phase to address:** Phase 1 (Project restructure). Test singleton persistence immediately after migrating to Next.js.

**Confidence:** MEDIUM -- specific behavior depends on Next.js version and Vercel runtime. The `globalThis` pattern is well-established but needs verification.

---

### Pitfall 9: Stripe Checkout Session Does Not Map to Supabase User

**What goes wrong:**
A user signs up via Supabase Auth (gets a Supabase `user_id`), then purchases a plan via Stripe Checkout (creates a Stripe `customer_id`). These are two separate identity systems. If the mapping between `user_id` and `customer_id` is not established atomically during checkout, you end up with: (a) Stripe payments with no corresponding Supabase user, (b) Supabase users with no Stripe customer, or (c) duplicate Stripe customers for the same user.

**Why it happens:**
Stripe Checkout creates the customer on Stripe's side. If your `checkout.session.completed` webhook handler fails after Stripe creates the customer but before your database records the mapping, you have an orphan. Retrying the webhook creates a second Stripe customer.

**Prevention:**
1. **Create Stripe customer BEFORE checkout**: When a user signs up, immediately create a Stripe customer and store the mapping: `user_accounts(user_id, stripe_customer_id)`. Pass the existing `customer` ID to Checkout Session creation.
2. **Use `client_reference_id`**: Pass the Supabase `user_id` as `client_reference_id` in the Checkout Session so webhooks can always map back to your user.
3. **Idempotent customer creation**: Before creating a Stripe customer, check if one already exists for this user. Stripe supports searching customers by metadata.

**Detection (warning signs):**
- `stripe_customer_id` is NULL for paying users
- Multiple Stripe customers with the same email
- Webhook handler creating Stripe customers (they should already exist)
- No `client_reference_id` in Checkout Session creation

**Phase to address:** Phase 2 (User account setup) and Phase 3 (Stripe integration). Create the Stripe customer during signup, not during first purchase.

**Confidence:** HIGH -- standard Stripe integration pattern documented in [Stripe Checkout docs](https://docs.stripe.com/payments/checkout).

---

### Pitfall 10: Cold Start + Auth + Metering Chain Exceeds Vercel Function Timeout

**What goes wrong:**
A cold MCP request hits the full chain: Vercel function cold start (~300ms) + Supabase API key lookup (~100ms) + credit balance check (~50ms) + CourtListener API call (~500-1500ms) + usage log write (~50ms) + response serialization. Total: 1000-2000ms warm, 1300-2300ms cold. The current `maxDuration: 60` is generous, but if CourtListener is slow (3-5s on complex searches), the chain approaches timeout. More importantly, the P95 latency for end users degrades significantly.

**Why it happens:**
Each layer (auth, metering, business logic, logging) adds sequential latency. In a monolithic server, these would be in-process function calls (~microseconds). In serverless + external database + external API, each is a network round-trip.

**Prevention:**
1. **Parallelize where possible**: API key validation and credit balance check can be a single database call (the stored procedure from Pitfall 2 already combines them).
2. **Fire-and-forget usage logging**: Write the usage log asynchronously after the response is sent. Use `waitUntil()` in Vercel's serverless runtime to continue execution after response.
3. **Cache API key validation**: As described in Pitfall 5, cache validated keys in Vercel KV.
4. **Set realistic latency budgets**: Auth: <10ms (cached), Credit check+decrement: <50ms (single RPC), Business logic: <3000ms, Usage log: async. Total target: <3100ms.

**Detection (warning signs):**
- P95 latency exceeding 3 seconds for simple operations
- Sequential `await` calls for auth, then balance check, then business logic, then logging
- No use of `waitUntil()` for post-response work
- Timeout errors in Vercel function logs

**Phase to address:** Phase 2 (Auth middleware design). Design the middleware pipeline for parallelism from the start.

**Confidence:** MEDIUM -- latency numbers are estimates. Actual performance depends on Vercel region, Supabase region, and CourtListener API response times. Must be validated with load testing.

---

## Minor Pitfalls

---

### Pitfall 11: Credit Pack "Never Expire" Complicates Balance Accounting

**What goes wrong:**
The pricing model has subscription credits (500/month, reset monthly) and credit packs ($50/1K, never expire). This creates two credit pools with different lifecycle rules. If stored as a single balance, you cannot implement "use subscription credits first, then pack credits" (desirable to avoid waste). If stored as two balances, the decrement function must check both pools atomically.

**Prevention:**
Use a single `credit_balance` column but track credit sources in the usage log. Subscription credits are added monthly via a cron job; pack credits are added on purchase. Decrement from the single balance. The "never expire" guarantee means pack credits are simply never removed -- the monthly reset only tops up to the subscription amount, never reduces below it.

```sql
-- Monthly subscription credit refresh (cron)
UPDATE user_accounts
SET credit_balance = GREATEST(credit_balance, 500)  -- top up, never reduce
WHERE plan = 'solo';
```

**Phase to address:** Phase 2 (Credit system design).

**Confidence:** MEDIUM -- the `GREATEST` approach is simple but may need refinement for edge cases (e.g., user with 1200 pack credits should not be reduced to 500).

---

### Pitfall 12: MCP Transport Auth vs Dashboard Auth Confusion

**What goes wrong:**
LexCerta has two user types with different auth flows: developers (API keys in MCP requests) and lawyers (Supabase Auth sessions in dashboard). Mixing these up causes: (a) API keys being validated against Supabase Auth (wrong system), (b) dashboard sessions being checked for MCP requests (wrong flow), (c) RLS policies assuming `auth.uid()` is always available (it is not for API key users).

**Prevention:**
1. **Separate middleware chains**: MCP routes (`/api/mcp/*`) use API key middleware. Dashboard routes (`/api/dashboard/*`) use Supabase Auth middleware.
2. **Map API keys to user_id**: API key validation returns a `user_id` so downstream code (credit decrement, usage logging) works identically regardless of auth method.
3. **RLS policies for dashboard only**: Use service role for MCP server database operations (API key auth is handled in application code). Use RLS for dashboard queries (where `auth.uid()` is available).

**Phase to address:** Phase 2 (Auth architecture). Define the auth boundary before implementing either auth method.

**Confidence:** HIGH -- architectural decision, not a technology limitation.

---

### Pitfall 13: Stripe Webhook Endpoint Not Protected Against Replay Attacks

**What goes wrong:**
Stripe's signature verification includes a timestamp. The tolerance window is typically set to 300 seconds (5 minutes). Without explicitly setting this tolerance, an attacker could replay old webhook payloads indefinitely.

**Prevention:**
Always pass the tolerance parameter:
```typescript
const event = stripe.webhooks.constructEvent(
  body, signature, webhookSecret,
  300  // 5-minute tolerance, explicitly set
);
```

**Phase to address:** Phase 3 (Stripe integration). Trivial to implement, easy to forget.

**Confidence:** HIGH -- documented in [Stripe webhook security docs](https://docs.stripe.com/webhooks/signature).

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation | Severity |
|-------------|---------------|------------|----------|
| Project restructure (Phase 1) | Routing collision (Pitfall 1) | Migrate MCP endpoint into Next.js first, test before adding routes | CRITICAL |
| Project restructure (Phase 1) | Singleton state loss (Pitfall 8) | Use `globalThis` pattern, verify cache behavior | MODERATE |
| Database schema (Phase 2) | Credit race condition (Pitfall 2) | Atomic decrement via PostgreSQL stored procedure | CRITICAL |
| Database schema (Phase 2) | RLS performance (Pitfall 6) | Index policy columns, wrap `auth.uid()` in subselect | CRITICAL |
| API key auth (Phase 2) | Lookup latency (Pitfall 5) | Edge cache with KV, connection pooling | MODERATE |
| Credit system (Phase 2) | Unauditable metering (Pitfall 7) | Immutable usage log with request correlation | MODERATE |
| Credit system (Phase 2) | Dual-pool accounting (Pitfall 11) | Single balance with GREATEST-based refresh | LOW |
| Auth architecture (Phase 2) | Auth flow confusion (Pitfall 12) | Separate middleware chains for MCP vs dashboard | MODERATE |
| Stripe integration (Phase 3) | Raw body parsing (Pitfall 3) | Use `request.text()` not `.json()` | CRITICAL |
| Stripe integration (Phase 3) | Duplicate/out-of-order events (Pitfall 4) | Idempotency table with atomic processing | CRITICAL |
| Stripe integration (Phase 3) | User identity mapping (Pitfall 9) | Create Stripe customer at signup, not checkout | MODERATE |
| Stripe integration (Phase 3) | Replay attacks (Pitfall 13) | Explicit timestamp tolerance | LOW |
| Performance (Phase 4) | Latency chain (Pitfall 10) | Parallelize auth+metering, async logging | MODERATE |

## "Looks Done But Isn't" Checklist for v1.1

- [ ] **Routing**: MCP endpoint accessible at new path after Next.js migration; old clients updated
- [ ] **Credit atomicity**: Load test with 50 concurrent requests for same user; balance matches expected
- [ ] **Webhook idempotency**: Send same Stripe event ID twice; only one credit provisioning occurs
- [ ] **Webhook body**: Stripe CLI `stripe listen --forward-to` succeeds with signature verification
- [ ] **API key cache**: Second request with same key completes in <10ms (cache hit)
- [ ] **RLS indexes**: `EXPLAIN ANALYZE` on dashboard queries shows index scan, not sequential scan
- [ ] **Usage audit**: SUM of usage_log credits equals (initial_credits - current_balance) for every user
- [ ] **Auth separation**: API key on dashboard route returns 401; Supabase session on MCP route returns 401
- [ ] **Cold start budget**: End-to-end cold start for authenticated MCP request under 2 seconds
- [ ] **Stripe customer mapping**: Every Supabase user with a subscription has exactly one Stripe customer

## Sources

- [Vercel/Next.js routing conflict (GitHub #12676)](https://github.com/vercel/vercel/issues/12676) -- routing inconsistencies between dev and production
- [mcp-handler repository](https://github.com/vercel/mcp-handler) -- Next.js App Router integration pattern
- [Next.js Stripe raw body issue (GitHub #60002)](https://github.com/vercel/next.js/issues/60002) -- body parsing breaks signature verification
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) -- webhook deduplication requirements
- [Stigg: Stripe webhook best practices](https://www.stigg.io/blog-posts/best-practices-i-wish-we-knew-when-integrating-stripe-webhooks) -- event ordering, duplicate processing
- [Hookdeck: webhook idempotency](https://hookdeck.com/webhooks/guides/implement-webhook-idempotency) -- implementation patterns
- [Supabase RLS performance](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv) -- function caching, indexing impact
- [Supabase transaction limitations](https://github.com/orgs/supabase/discussions/526) -- PostgREST lacks transaction support
- [Marmelab: Supabase edge function transactions](https://marmelab.com/blog/2025/12/08/supabase-edge-function-transaction-rls.html) -- RPC and direct connection patterns
- [Supabase connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres) -- connection pooling via Supavisor
- [Stripe webhook signatures](https://docs.stripe.com/webhooks/signature) -- verification and replay protection
- [Stripe Checkout documentation](https://docs.stripe.com/payments/checkout) -- customer creation patterns

---
*Pitfalls research for: LexCerta v1.1 SaaS monetization layer*
*Researched: 2026-02-13*
